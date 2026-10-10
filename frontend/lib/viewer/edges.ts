/**
 * Which triangle edges of a mesh are real edges of the shape.
 *
 * Pure and three.js-free. The renderer draws these from the surface material
 * itself (see `applyIfcLiteMaterialFinish`) rather than as a second line
 * object, so the decision of *which* edges count has to be made up front and
 * handed to the shader as a per-triangle bit mask.
 *
 * An edge counts when it is a boundary (one triangle only: the rim of a
 * sheet, an opening's reveal), when more than two triangles meet there, or
 * when the two triangles on either side fold by more than a threshold angle.
 * Triangulation diagonals and the facets of a smoothly curved surface are
 * flat or nearly so, so they are left alone — which is the whole difference
 * between "edges" and a wireframe.
 */

export const DEFAULT_EDGE_ANGLE_DEGREES = 30;
/** Total line width, CSS pixels, centred on the edge. */
export const DEFAULT_EDGE_WIDTH = 1;
export const DEFAULT_EDGE_COLOUR = "#1b1d2b";

/** Positions closer than this (model units, metres) are the same point. */
const WELD = 1e-4;

/**
 * One byte per triangle. Bit `e` is set when the edge *opposite* corner `e`
 * (the one joining the other two) is a feature edge.
 *
 * Winding is deliberately ignored: IFC tessellation does not keep it
 * consistent, so two coplanar neighbours can have opposite normals. The fold
 * is measured between the planes, not between the oriented faces.
 */
export function featureEdgeMasks(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  angleDegrees = DEFAULT_EDGE_ANGLE_DEGREES,
): Uint8Array {
  const triangles = Math.floor(indices.length / 3);
  const masks = new Uint8Array(triangles);
  if (triangles === 0) return masks;

  // Vertices are often duplicated along an edge (flat shading wants a normal
  // per face), so adjacency is decided by position, not by index.
  const vertexCount = positions.length / 3;
  const weldedId = new Uint32Array(vertexCount);
  const seen = new Map<string, number>();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${Math.round(positions[v * 3] / WELD)},${Math.round(positions[v * 3 + 1] / WELD)},${Math.round(positions[v * 3 + 2] / WELD)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    weldedId[v] = id;
  }
  const stride = seen.size + 1;

  // Unit normal per triangle; zero for a degenerate one.
  const normals = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t += 1) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-12) {
      normals[t * 3] = nx / length;
      normals[t * 3 + 1] = ny / length;
      normals[t * 3 + 2] = nz / length;
    }
  }

  const limit = Math.cos((angleDegrees * Math.PI) / 180);
  // edge key → `slot + 1` of its first triangle edge, or -1 once two have met.
  const open = new Map<number, number>();

  for (let t = 0; t < triangles; t += 1) {
    for (let e = 0; e < 3; e += 1) {
      const a = weldedId[indices[t * 3 + ((e + 1) % 3)]];
      const b = weldedId[indices[t * 3 + ((e + 2) % 3)]];
      if (a === b) continue;
      const key = a < b ? a * stride + b : b * stride + a;
      const first = open.get(key);

      if (first === undefined) {
        open.set(key, t * 3 + e + 1);
      } else if (first === -1) {
        // Three or more triangles on one edge: never a smooth surface.
        masks[t] |= 1 << e;
      } else {
        const other = Math.floor((first - 1) / 3);
        const otherEdge = (first - 1) % 3;
        open.set(key, -1);
        const dot =
          normals[t * 3] * normals[other * 3] +
          normals[t * 3 + 1] * normals[other * 3 + 1] +
          normals[t * 3 + 2] * normals[other * 3 + 2];
        const degenerate =
          (normals[t * 3] === 0 && normals[t * 3 + 1] === 0 && normals[t * 3 + 2] === 0) ||
          (normals[other * 3] === 0 &&
            normals[other * 3 + 1] === 0 &&
            normals[other * 3 + 2] === 0);
        if (!degenerate && Math.abs(dot) < limit) {
          masks[t] |= 1 << e;
          masks[other] |= 1 << otherEdge;
        }
      }
    }
  }

  // Whatever never found a partner is a boundary.
  for (const slot of open.values()) {
    if (slot > 0) masks[Math.floor((slot - 1) / 3)] |= 1 << ((slot - 1) % 3);
  }
  return masks;
}
