import { describe, expect, it } from "vitest";

import {
  DegenerateControlPointsError,
  InsufficientControlPointsError,
  fitControlPoints,
  refine,
  solveSimilarity,
  toMapConversion,
  type ControlPoint,
  type FitParameters,
} from "../fit";
import { gridRotation } from "../transform";

/** Apply a known transform, so a fit can be checked against the truth. */
function synthesise(
  locals: Array<[number, number, number?]>,
  truth: FitParameters,
  noise: number[][] = [],
): ControlPoint[] {
  const radians = (truth.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return locals.map(([x, y, z = 0], index) => {
    const [de = 0, dn = 0, dh = 0] = noise[index] ?? [];
    return {
      id: `p${index}`,
      local: { x, y, z },
      map: {
        easting: truth.eastings + truth.scale * (x * cos - y * sin) + de,
        northing: truth.northings + truth.scale * (x * sin + y * cos) + dn,
        height: truth.orthogonalHeight + truth.scale * z + dh,
      },
    };
  });
}

const TRUTH: FitParameters = {
  eastings: -40_000,
  northings: 180_000,
  orthogonalHeight: 190,
  rotationDegrees: 23.5,
  scale: 1,
};

const LOCALS: Array<[number, number, number?]> = [
  [0, 0, 0],
  [100, 0, 2],
  [100, 60, 4],
  [0, 60, 1],
];

describe("closed-form similarity fit", () => {
  it("recovers the exact transform from clean points", () => {
    const result = solveSimilarity(synthesise(LOCALS, TRUTH));

    expect(result.parameters.eastings).toBeCloseTo(TRUTH.eastings, 6);
    expect(result.parameters.northings).toBeCloseTo(TRUTH.northings, 6);
    expect(result.parameters.orthogonalHeight).toBeCloseTo(TRUTH.orthogonalHeight, 6);
    expect(result.parameters.rotationDegrees).toBeCloseTo(TRUTH.rotationDegrees, 6);
    expect(result.parameters.scale).toBeCloseTo(TRUTH.scale, 9);

    expect(result.rmse).toBeLessThan(1e-6);
    expect(result.converged).toBe(true);
    // Closed form: no iteration at all.
    expect(result.iterations).toBe(0);
  });

  it("recovers a non-unit scale", () => {
    const scaled = { ...TRUTH, scale: 1.0004 };
    const result = solveSimilarity(synthesise(LOCALS, scaled));
    expect(result.parameters.scale).toBeCloseTo(1.0004, 9);
  });

  it("solves from the minimum of two points", () => {
    const result = solveSimilarity(
      synthesise(
        [
          [0, 0],
          [100, 0],
        ],
        TRUTH,
      ),
    );
    expect(result.parameters.rotationDegrees).toBeCloseTo(TRUTH.rotationDegrees, 6);
    expect(result.rmse).toBeLessThan(1e-6);
  });

  it("refuses fewer than two points instead of inventing a rotation", () => {
    expect(() => solveSimilarity(synthesise([[0, 0]], TRUTH))).toThrow(
      InsufficientControlPointsError,
    );
  });

  it("refuses coincident points, where rotation is undetermined", () => {
    const coincident: ControlPoint[] = [
      { id: "a", local: { x: 5, y: 5 }, map: { easting: 10, northing: 10 } },
      { id: "b", local: { x: 5, y: 5 }, map: { easting: 12, northing: 10 } },
    ];
    expect(() => solveSimilarity(coincident)).toThrow(DegenerateControlPointsError);
  });

  it("reports per-point residuals, not just an aggregate", () => {
    // One point pulled 0.20 m east; least squares spreads that across the set.
    const points = synthesise(LOCALS, TRUTH, [[], [0.2, 0, 0]]);
    const result = solveSimilarity(points);

    expect(result.residuals).toHaveLength(4);
    expect(result.residuals.map((r) => r.id)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(result.maxResidual).toBeGreaterThan(0);
    expect(result.rmse).toBeLessThanOrEqual(result.maxResidual);

    for (const residual of result.residuals) {
      expect(residual.horizontal).toBeCloseTo(
        Math.hypot(residual.easting, residual.northing),
        12,
      );
    }
  });

  it("keeps the vertical residual separate from the horizontal one", () => {
    const points = synthesise(LOCALS, TRUTH, [[0, 0, 0.5]]);
    const result = solveSimilarity(points);
    // A pure height error must not inflate the horizontal RMSE.
    expect(result.rmse).toBeLessThan(1e-6);
    expect(Math.abs(result.residuals[0].height)).toBeGreaterThan(0.1);
  });

  it("reports rotation in (−180, 180]", () => {
    const result = solveSimilarity(
      synthesise(LOCALS, { ...TRUTH, rotationDegrees: -170 }),
    );
    expect(result.parameters.rotationDegrees).toBeGreaterThan(-180);
    expect(result.parameters.rotationDegrees).toBeLessThanOrEqual(180);
    expect(result.parameters.rotationDegrees).toBeCloseTo(-170, 6);
  });
});

describe("Levenberg–Marquardt refinement", () => {
  it("matches the closed form when nothing is locked", () => {
    const points = synthesise(LOCALS, TRUTH, [[], [0.05, -0.03, 0]]);
    const closed = solveSimilarity(points);
    const iterated = refine(points);

    expect(iterated.parameters.rotationDegrees).toBeCloseTo(
      closed.parameters.rotationDegrees,
      6,
    );
    expect(iterated.parameters.scale).toBeCloseTo(closed.parameters.scale, 6);
    // The meaningful property is that iterating does not do *worse* than the
    // exact solution, not that it reproduces it bit for bit. LM stops at its
    // tolerance, so it lands a hair above the exact optimum.
    expect(iterated.rmse).toBeLessThanOrEqual(closed.rmse * (1 + 1e-6));
    expect(iterated.converged).toBe(true);
  });

  it("honours a locked scale, and still fits everything else", () => {
    // A surveyor who knows the grid scale is exactly 1 should get a fit that
    // respects that rather than one that absorbs error into the scale.
    const points = synthesise(LOCALS, { ...TRUTH, scale: 1.02 });
    const result = refine(points, { locks: { scale: 1 } });

    expect(result.parameters.scale).toBe(1);
    expect(result.parameters.rotationDegrees).toBeCloseTo(TRUTH.rotationDegrees, 3);
    // With scale pinned wrong, the residuals must show it rather than vanish.
    expect(result.rmse).toBeGreaterThan(0.1);
  });

  it("honours a locked rotation", () => {
    const points = synthesise(LOCALS, TRUTH);
    const result = refine(points, { locks: { rotation: 0 } });

    expect(result.parameters.rotationDegrees).toBe(0);
    expect(result.rmse).toBeGreaterThan(1);
  });

  it("honours a locked height", () => {
    const points = synthesise(LOCALS, TRUTH);
    const result = refine(points, { locks: { height: 100 } });
    expect(result.parameters.orthogonalHeight).toBe(100);
  });

  it("solves translation only when rotation and scale are both pinned", () => {
    const truth = { ...TRUTH, rotationDegrees: 0, scale: 1 };
    const points = synthesise(LOCALS, truth);
    const result = refine(points, { locks: { rotation: 0, scale: 1 } });

    expect(result.parameters.eastings).toBeCloseTo(truth.eastings, 6);
    expect(result.parameters.northings).toBeCloseTo(truth.northings, 6);
    expect(result.rmse).toBeLessThan(1e-6);
  });

  it("converges from a deliberately poor starting point", () => {
    const points = synthesise(LOCALS, TRUTH);
    const result = refine(points, {
      locks: { scale: 1 },
      initial: {
        eastings: 0,
        northings: 0,
        orthogonalHeight: 0,
        rotationDegrees: 0,
        scale: 1,
      },
    });

    expect(result.converged).toBe(true);
    expect(result.rmse).toBeLessThan(1e-4);
    expect(result.parameters.rotationDegrees).toBeCloseTo(TRUTH.rotationDegrees, 3);
  });

  it("takes iterations, unlike the closed form", () => {
    const result = refine(synthesise(LOCALS, TRUTH), { locks: { scale: 1 } });
    expect(result.iterations).toBeGreaterThan(0);
  });
});

describe("fitControlPoints", () => {
  it("uses the closed form when unconstrained", () => {
    expect(fitControlPoints(synthesise(LOCALS, TRUTH)).iterations).toBe(0);
  });

  it("switches to LM once anything is locked", () => {
    const result = fitControlPoints(synthesise(LOCALS, TRUTH), { scale: 1 });
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.parameters.scale).toBe(1);
  });
});

describe("toMapConversion", () => {
  it("writes the rotation as an axis direction, round-tripping the angle", () => {
    const result = solveSimilarity(synthesise(LOCALS, TRUTH));
    const conversion = toMapConversion(result.parameters);

    expect(conversion.eastings).toBeCloseTo(TRUTH.eastings, 6);
    expect(conversion.orthogonalHeight).toBeCloseTo(TRUTH.orthogonalHeight, 6);
    expect(gridRotation(conversion).degrees).toBeCloseTo(TRUTH.rotationDegrees, 6);
  });

  it("emits a clean axis pair for a right-angle rotation", () => {
    const conversion = toMapConversion({
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      rotationDegrees: 90,
      scale: 1,
    });
    expect(conversion.xAxisAbscissa).toBe(0);
    expect(conversion.xAxisOrdinate).toBe(1);
  });
});
