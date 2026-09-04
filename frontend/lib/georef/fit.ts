/**
 * Fitting a map conversion to control points.
 *
 * ifcgref does this with `scipy.optimize.least_squares`. The parameters are
 * eastings, northings, orthogonal height, grid rotation and scale — a 3D
 * similarity transform restricted to rotation about the vertical, which is
 * exactly what `IfcMapConversion` can represent.
 *
 * ## Why there are two solvers
 *
 * For the **unconstrained** case that transform has a closed-form least-squares
 * solution (Umeyama / orthogonal Procrustes). It is exact, needs no initial
 * guess, and cannot fail to converge — so using an iterative optimiser for it
 * would be strictly worse. {@link solveSimilarity} is that.
 *
 * Levenberg–Marquardt earns its place once the user **pins** a parameter — "I
 * know the scale is exactly 1", "the surveyor gave me this rotation" — where the
 * closed form no longer applies to an arbitrary combination of locks.
 * {@link refine} is a real LM implementation with an analytic Jacobian,
 * initialised from the closed form so it converges in a handful of iterations.
 *
 * Everything works in **metres**. Callers convert project units first; a solver
 * that silently mixed millimetres and metres would produce a scale factor of
 * 1000 and look like it had succeeded.
 */

import type { MapConversionView } from "@/lib/ifc/types";
import { rotationFromDegrees } from "./transform";

/** One correspondence: a point in the model, and where it really is. */
export type ControlPoint = {
  id: string;
  /** Model coordinates, in metres. */
  local: { x: number; y: number; z?: number };
  /** Map coordinates, in metres, in the target CRS. */
  map: { easting: number; northing: number; height?: number };
};

export type FitParameters = {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  /** Grid rotation, degrees counter-clockwise from map east. */
  rotationDegrees: number;
  scale: number;
};

/** Which parameters the solver may move. */
export type FitLocks = {
  rotation?: number;
  scale?: number;
  height?: number;
};

export type PointResidual = {
  id: string;
  /** Signed errors, metres. */
  easting: number;
  northing: number;
  height: number;
  /** Horizontal magnitude — the number a surveyor reads first. */
  horizontal: number;
};

export type FitResult = {
  parameters: FitParameters;
  residuals: PointResidual[];
  /** Root-mean-square horizontal residual, metres. */
  rmse: number;
  /** Largest horizontal residual, metres. */
  maxResidual: number;
  /** Iterations used. 0 for the closed-form path. */
  iterations: number;
  converged: boolean;
};

export class InsufficientControlPointsError extends Error {
  constructor(readonly count: number) {
    super(
      `A map conversion needs at least 2 control points to solve rotation and scale; got ${count}.`,
    );
    this.name = "InsufficientControlPointsError";
  }
}

export class DegenerateControlPointsError extends Error {
  constructor() {
    super(
      "The control points are coincident in plan, so rotation and scale are undetermined. Move them apart.",
    );
    this.name = "DegenerateControlPointsError";
  }
}

// ---------------------------------------------------------------------------
// Closed form
// ---------------------------------------------------------------------------

/**
 * Least-squares similarity fit, in closed form.
 *
 * Centre both point sets, recover rotation from the cross-covariance, recover
 * scale from the ratio of spreads, then place the translation so the centroids
 * coincide. Height is a plain mean offset, because the transform has no tilt.
 */
export function solveSimilarity(points: ControlPoint[]): FitResult {
  if (points.length < 2) throw new InsufficientControlPointsError(points.length);

  const n = points.length;
  const localCentroid = centroid(points.map((p) => [p.local.x, p.local.y]));
  const mapCentroid = centroid(points.map((p) => [p.map.easting, p.map.northing]));

  // Cross-covariance of the centred sets. `a` accumulates the aligned part and
  // `b` the perpendicular part; their ratio is the rotation.
  let a = 0;
  let b = 0;
  let localVariance = 0;

  for (const point of points) {
    const lx = point.local.x - localCentroid[0];
    const ly = point.local.y - localCentroid[1];
    const mx = point.map.easting - mapCentroid[0];
    const my = point.map.northing - mapCentroid[1];

    a += lx * mx + ly * my;
    b += lx * my - ly * mx;
    localVariance += lx * lx + ly * ly;
  }

  if (localVariance < 1e-12) throw new DegenerateControlPointsError();

  const rotation = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / localVariance;

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new DegenerateControlPointsError();
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const eastings =
    mapCentroid[0] - scale * (localCentroid[0] * cos - localCentroid[1] * sin);
  const northings =
    mapCentroid[1] - scale * (localCentroid[0] * sin + localCentroid[1] * cos);

  // Height has no rotation term, so it is the mean of (observed − scale·z).
  let heightSum = 0;
  for (const point of points) {
    heightSum += (point.map.height ?? 0) - scale * (point.local.z ?? 0);
  }

  const parameters: FitParameters = {
    eastings,
    northings,
    orthogonalHeight: heightSum / n,
    rotationDegrees: (rotation * 180) / Math.PI,
    scale,
  };

  return report(parameters, points, 0, true);
}

// ---------------------------------------------------------------------------
// Levenberg–Marquardt
// ---------------------------------------------------------------------------

export type RefineOptions = {
  locks?: FitLocks;
  maxIterations?: number;
  /** Stop when the RMSE improves by less than this, in metres. */
  tolerance?: number;
  initial?: FitParameters;
};

/**
 * Refine a fit under parameter locks, by Levenberg–Marquardt.
 *
 * Damped Gauss–Newton: solve `(JᵀJ + λ·diag(JᵀJ))·δ = −Jᵀr`, accept the step if
 * it reduces the cost and relax λ, otherwise reject it and increase λ. Starting
 * from the closed-form solution means λ starts small and the first step is
 * usually accepted.
 *
 * The Jacobian is analytic. A numeric one would need a step size, and choosing
 * one that suits both a translation in metres and a rotation in radians is a
 * source of quiet inaccuracy.
 */
export function refine(
  points: ControlPoint[],
  options: RefineOptions = {},
): FitResult {
  if (points.length < 2) throw new InsufficientControlPointsError(points.length);

  const locks = options.locks ?? {};
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-9;

  // Which of [E, N, H, θ, s] are free, in that order.
  const free: number[] = [0, 1];
  if (locks.height === undefined) free.push(2);
  if (locks.rotation === undefined) free.push(3);
  if (locks.scale === undefined) free.push(4);

  let current = applyLocks(
    options.initial ?? initialGuess(points, locks),
    locks,
  );
  let cost = sumSquares(residualVector(current, points));
  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;

  while (iterations < maxIterations) {
    // Counted at the top: an iteration that converges immediately still did the
    // work, and reporting 0 would make a successful refinement look like the
    // closed-form path had run instead.
    iterations += 1;

    const residuals = residualVector(current, points);
    const jacobian = jacobianMatrix(current, points, free);

    // Normal equations: JᵀJ and Jᵀr.
    const size = free.length;
    const jtj = zeros(size, size);
    const jtr = new Array<number>(size).fill(0);

    for (let row = 0; row < residuals.length; row += 1) {
      for (let i = 0; i < size; i += 1) {
        jtr[i] += jacobian[row][i] * residuals[row];
        for (let j = 0; j < size; j += 1) {
          jtj[i][j] += jacobian[row][i] * jacobian[row][j];
        }
      }
    }

    let stepped = false;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const damped = jtj.map((row, i) =>
        row.map((value, j) =>
          // Marquardt's scaling: damp proportionally to each parameter's own
          // curvature, so a rotation in radians and a translation in metres are
          // damped comparably rather than by an absolute λ that suits neither.
          i === j ? value + lambda * Math.max(value, 1e-12) : value,
        ),
      );

      const delta = solveLinearSystem(damped, jtr.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }

      const candidate = applyLocks(applyDelta(current, free, delta), locks);
      const candidateCost = sumSquares(residualVector(candidate, points));

      if (candidateCost < cost) {
        const improvement = cost - candidateCost;
        current = candidate;
        cost = candidateCost;
        lambda = Math.max(lambda / 10, 1e-12);
        stepped = true;
        if (improvement < tolerance) converged = true;
        break;
      }

      lambda *= 10;
    }

    if (!stepped || converged) {
      converged = true;
      break;
    }
  }

  return report(current, points, iterations, converged);
}

/**
 * Fit control points, choosing the right solver.
 *
 * With no locks this is the closed form; with locks it is LM seeded from it.
 */
export function fitControlPoints(
  points: ControlPoint[],
  locks: FitLocks = {},
): FitResult {
  const unconstrained =
    locks.rotation === undefined &&
    locks.scale === undefined &&
    locks.height === undefined;

  if (unconstrained) return solveSimilarity(points);
  return refine(points, { locks });
}

/** Turn a fit into the map conversion the exporter writes. */
export function toMapConversion(parameters: FitParameters): MapConversionView {
  const { xAxisAbscissa, xAxisOrdinate } = rotationFromDegrees(
    parameters.rotationDegrees,
  );
  return {
    eastings: parameters.eastings,
    northings: parameters.northings,
    orthogonalHeight: parameters.orthogonalHeight,
    xAxisAbscissa,
    xAxisOrdinate,
    scale: parameters.scale,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function initialGuess(points: ControlPoint[], locks: FitLocks): FitParameters {
  try {
    return solveSimilarity(points).parameters;
  } catch {
    // Degenerate points still deserve a starting point rather than a throw:
    // LM under locks may well be solvable where the free fit is not.
    const localCentroid = centroid(points.map((p) => [p.local.x, p.local.y]));
    const mapCentroid = centroid(
      points.map((p) => [p.map.easting, p.map.northing]),
    );
    return {
      eastings: mapCentroid[0] - localCentroid[0],
      northings: mapCentroid[1] - localCentroid[1],
      orthogonalHeight: locks.height ?? 0,
      rotationDegrees: locks.rotation ?? 0,
      scale: locks.scale ?? 1,
    };
  }
}

function applyLocks(parameters: FitParameters, locks: FitLocks): FitParameters {
  return {
    ...parameters,
    rotationDegrees: locks.rotation ?? parameters.rotationDegrees,
    scale: locks.scale ?? parameters.scale,
    orthogonalHeight: locks.height ?? parameters.orthogonalHeight,
  };
}

function predict(parameters: FitParameters, point: ControlPoint) {
  const radians = (parameters.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const { scale } = parameters;
  const { x, y, z = 0 } = point.local;

  return {
    easting: parameters.eastings + scale * (x * cos - y * sin),
    northing: parameters.northings + scale * (x * sin + y * cos),
    height: parameters.orthogonalHeight + scale * z,
  };
}

/** Flat residual vector: [dE₀, dN₀, dH₀, dE₁, …]. */
function residualVector(
  parameters: FitParameters,
  points: ControlPoint[],
): number[] {
  const out: number[] = [];
  for (const point of points) {
    const predicted = predict(parameters, point);
    out.push(
      predicted.easting - point.map.easting,
      predicted.northing - point.map.northing,
      predicted.height - (point.map.height ?? 0),
    );
  }
  return out;
}

/** Analytic Jacobian, rows matching `residualVector`, columns matching `free`. */
function jacobianMatrix(
  parameters: FitParameters,
  points: ControlPoint[],
  free: number[],
): number[][] {
  const radians = (parameters.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const { scale } = parameters;
  // The parameter is in degrees, so the chain rule needs this factor. Omitting
  // it does not break convergence, it just makes every rotation step 57× too
  // small — which reads as "the solver is slow" rather than as a bug.
  const perDegree = Math.PI / 180;

  const rows: number[][] = [];

  for (const point of points) {
    const { x, y, z = 0 } = point.local;

    const dE = [1, 0, 0, scale * (-x * sin - y * cos) * perDegree, x * cos - y * sin];
    const dN = [0, 1, 0, scale * (x * cos - y * sin) * perDegree, x * sin + y * cos];
    const dH = [0, 0, 1, 0, z];

    rows.push(
      free.map((i) => dE[i]),
      free.map((i) => dN[i]),
      free.map((i) => dH[i]),
    );
  }

  return rows;
}

function applyDelta(
  parameters: FitParameters,
  free: number[],
  delta: number[],
): FitParameters {
  const values = [
    parameters.eastings,
    parameters.northings,
    parameters.orthogonalHeight,
    parameters.rotationDegrees,
    parameters.scale,
  ];
  free.forEach((index, i) => {
    values[index] += delta[i];
  });

  return {
    eastings: values[0],
    northings: values[1],
    orthogonalHeight: values[2],
    rotationDegrees: values[3],
    scale: values[4],
  };
}

function report(
  parameters: FitParameters,
  points: ControlPoint[],
  iterations: number,
  converged: boolean,
): FitResult {
  const residuals: PointResidual[] = points.map((point) => {
    const predicted = predict(parameters, point);
    const easting = predicted.easting - point.map.easting;
    const northing = predicted.northing - point.map.northing;
    const height = predicted.height - (point.map.height ?? 0);

    return {
      id: point.id,
      easting,
      northing,
      height,
      horizontal: Math.hypot(easting, northing),
    };
  });

  const squared = residuals.reduce((sum, r) => sum + r.horizontal ** 2, 0);

  return {
    parameters: {
      ...parameters,
      // Keep the reported rotation in (−180, 180]; a solver that wanders to
      // 719° is arithmetically fine and unreadable.
      rotationDegrees: normalizeDegrees(parameters.rotationDegrees),
    },
    residuals,
    rmse: Math.sqrt(squared / residuals.length),
    maxResidual: residuals.reduce((max, r) => Math.max(max, r.horizontal), 0),
    iterations,
    converged,
  };
}

function normalizeDegrees(degrees: number): number {
  let wrapped = degrees % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped <= -180) wrapped += 360;
  return wrapped === 0 ? 0 : wrapped;
}

function centroid(points: Array<[number, number]>): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  return [x / points.length, y / points.length];
}

function sumSquares(values: number[]): number {
  return values.reduce((sum, value) => sum + value * value, 0);
}

function zeros(rows: number, columns: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
}

/** Gaussian elimination with partial pivoting. Null when singular. */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-14) return null;

    [a[column], a[pivot]] = [a[pivot], a[column]];

    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k <= n; k += 1) a[row][k] -= factor * a[column][k];
    }
  }

  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * solution[k];
    solution[row] = sum / a[row][row];
  }
  return solution.every(Number.isFinite) ? solution : null;
}
