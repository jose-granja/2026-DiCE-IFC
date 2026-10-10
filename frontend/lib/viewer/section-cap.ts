/**
 * Section cap styling — the fill drawn where a section plane cuts through
 * solid geometry.
 *
 * A clipping plane alone (`renderer.ts`'s `clipPlanes`) leaves a cut open: the
 * far side of whatever it sliced through is simply gone, so a wall reads as a
 * hollow shell rather than a solid cut through material. This is the "hatch"
 * fill — familiar from architectural section drawings — that the reference
 * project (github.com/LTplus-AG/ifc-lite) draws over the open cut. Kept as
 * its own small module, not folded into `tools.ts`, because the renderer's
 * cap material and the panel's dropdown both need this one shape and nothing
 * else from `tools.ts`'s plane arithmetic.
 *
 * The filled regions are the solid's own cut cross-section, found by slicing
 * its triangles against the plane (`section-cut.ts`) — never the whole plane,
 * and never in front of an opening. Each region is also outlined.
 */

export const HATCH_PATTERNS = [
  "solid",
  "diagonal",
  "crossHatch",
  "horizontal",
  "vertical",
] as const;

export type HatchPatternId = (typeof HATCH_PATTERNS)[number];

export type SectionCapStyle = {
  /** Off by default — a cut fill is a deliberate choice, not a surprise the
   *  first section plane a user adds should spring on them. */
  enabled: boolean;
  pattern: HatchPatternId;
  /** CSS hex colours. */
  fillColour: string;
  hatchColour: string;
  /** Distance between hatch lines and their thickness, in metres. */
  hatchSpacing: number;
  hatchWidth: number;
  borderColour: string;
  /** Outline thickness in CSS pixels. */
  borderWidth: number;
};

export const DEFAULT_SECTION_CAP_STYLE: SectionCapStyle = {
  enabled: false,
  pattern: "diagonal",
  fillColour: "#fcf2b1",
  hatchColour: "#000000",
  hatchSpacing: 0.2,
  hatchWidth: 0.01,
  borderColour: "#000000",
  borderWidth: 0.5,
};

/** Bounds the settings inputs clamp to; a hatch wider than its spacing is solid. */
export const SECTION_CAP_LIMITS = {
  hatchSpacing: { min: 0.02, max: 5 },
  hatchWidth: { min: 0.005, max: 2 },
  borderWidth: { min: 0, max: 10 },
} as const;
