import { describe, expect, it } from "vitest";

import { standardViewDirection } from "../camera";
import {
  CUBE_FACES,
  directionKey,
  faceOfDirection,
  facesOfDirection,
  isZoneLit,
  zonesForFace,
} from "../view-cube-zones";

const all = CUBE_FACES.flatMap((face) => zonesForFace(face).map((zone) => ({ face, zone })));

describe("view cube zones", () => {
  it("has 26 views: 6 faces, 12 edges, 8 corners", () => {
    const unique = new Map(all.map(({ zone }) => [zone.key, zone.kind]));
    expect(unique.size).toBe(26);
    const kinds = [...unique.values()];
    expect(kinds.filter((kind) => kind === "face")).toHaveLength(6);
    expect(kinds.filter((kind) => kind === "edge")).toHaveLength(12);
    expect(kinds.filter((kind) => kind === "corner")).toHaveLength(8);
  });

  it("shows an edge on its two faces and a corner on its three, as one key", () => {
    const seen = new Map<string, Set<string>>();
    for (const { face, zone } of all) seen.set(zone.key, (seen.get(zone.key) ?? new Set()).add(face));
    for (const { zone } of all) {
      expect(seen.get(zone.key)!.size).toBe(zone.kind === "face" ? 1 : zone.kind === "edge" ? 2 : 3);
      expect([...seen.get(zone.key)!].sort()).toEqual(facesOfDirection(zone.direction).sort());
    }
  });

  it("looks from each face's middle exactly as the named views do", () => {
    for (const face of CUBE_FACES) {
      const middle = zonesForFace(face)[4];
      expect(middle.kind).toBe("face");
      expect(middle.direction).toEqual(standardViewDirection(face));
      expect(faceOfDirection(middle.direction)).toBe(face);
    }
  });

  it("puts the front's top edge above, its right edge to the right and its corners between", () => {
    const front = zonesForFace("front");
    expect(front[1].direction).toEqual([0, 1, 1]); // top edge: front and top
    expect(front[5].direction).toEqual([1, 0, 1]); // right edge: front and right
    expect(front[2].direction).toEqual([1, 1, 1]); // top right corner
    expect(front[6].direction).toEqual([-1, -1, 1]); // bottom left corner
    // The top's bottom row is the edge it shares with the front.
    expect(zonesForFace("top")[7].key).toBe(front[1].key);
    expect(faceOfDirection(front[2].direction)).toBeNull();
  });

  it("folds -0 into 0 in a key", () => {
    expect(directionKey([-0, 1, 0])).toBe(directionKey([0, 1, 0]));
  });

  it("lights the hovered zone wherever it shows, and a whole face for a face", () => {
    const corner = zonesForFace("front")[2].key;
    const lit = all.filter(({ face, zone }) => isZoneLit(zone, face, corner));
    expect(lit.map(({ face }) => face).sort()).toEqual(["front", "right", "top"]);

    const top = directionKey([0, 1, 0]);
    const litByFace = all.filter(({ face, zone }) => isZoneLit(zone, face, top));
    expect(litByFace).toHaveLength(9);
    expect(litByFace.every(({ face }) => face === "top")).toBe(true);
    expect(all.some(({ face, zone }) => isZoneLit(zone, face, null))).toBe(false);
  });
});
