/**
 * Ready-made clash matrices.
 *
 * A matrix is a lot of typing before the first useful run: a dozen groups of
 * IFC classes and the tolerance for each pair of them. For a residential
 * building the answer is nearly always the same, so it is offered as a starting
 * point — not a rule. Every group, tolerance and cell can be edited afterwards,
 * and the result exports like any other matrix.
 *
 * The words (discipline, group and tolerance names) are passed in so the matrix
 * reads in the user's language; the structure is the same in both.
 */

import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import { ruleKey } from "./matrix";
import {
  DEFAULT_CLASH_SETTINGS,
  type ClashGroup,
  type ClashMatrix,
  type ClashRule,
  type ClashTolerance,
} from "./types";

export type TemplateId = "residential";

export const TEMPLATE_IDS: readonly TemplateId[] = ["residential"];

/** Looks up a translated label by key — `t` from `useTranslations`, or a test double. */
export type TemplateLabel = (key: string) => string;

type GroupSpec = {
  key: string;
  discipline: "architecture" | "structure" | "mep";
  classes: string[];
};

/**
 * Wildcards, because a class and its subtypes belong together: `IfcWall*` is
 * `IfcWall`, `IfcWallStandardCase` and `IfcWallElementedCase`.
 *
 * What is deliberately not here: a "structural slab" or "structural wall".
 * Those are the same IFC classes as the architect's, and what tells them apart
 * (a load-bearing flag, a layer name) is not written consistently enough to
 * build a default on. Add one with a property filter once your models agree.
 */
const GROUPS: GroupSpec[] = [
  // Architecture
  { key: "walls", discipline: "architecture", classes: ["IfcWall*", "IfcCurtainWall"] },
  { key: "floorsRoofs", discipline: "architecture", classes: ["IfcSlab*", "IfcRoof"] },
  { key: "doors", discipline: "architecture", classes: ["IfcDoor*"] },
  { key: "windows", discipline: "architecture", classes: ["IfcWindow*"] },
  { key: "stairs", discipline: "architecture", classes: ["IfcStair*", "IfcRamp*"] },
  { key: "ceilings", discipline: "architecture", classes: ["IfcCovering"] },
  // Structure
  { key: "columns", discipline: "structure", classes: ["IfcColumn*"] },
  { key: "beams", discipline: "structure", classes: ["IfcBeam*"] },
  { key: "foundations", discipline: "structure", classes: ["IfcFooting*", "IfcPile*"] },
  // Services
  { key: "ducts", discipline: "mep", classes: ["IfcDuctSegment*", "IfcDuctFitting*"] },
  { key: "pipes", discipline: "mep", classes: ["IfcPipeSegment*", "IfcPipeFitting*"] },
  {
    key: "cableways",
    discipline: "mep",
    classes: ["IfcCableCarrierSegment*", "IfcCableCarrierFitting*", "IfcCableSegment*", "IfcCableFitting*"],
  },
  {
    key: "equipment",
    discipline: "mep",
    classes: [
      "IfcFlowController*",
      "IfcFlowMovingDevice*",
      "IfcFlowStorageDevice*",
      "IfcFlowTreatmentDevice*",
      "IfcEnergyConversionDevice*",
      "IfcElectricDistributionBoard*",
    ],
  },
  {
    key: "terminals",
    discipline: "mep",
    classes: ["IfcFlowTerminal*", "IfcAirTerminal*", "IfcSanitaryTerminal*", "IfcLightFixture*", "IfcOutlet*"],
  },
];

const TOLERANCES: Array<Omit<ClashTolerance, "name"> & { key: string }> = [
  // An overlap that is not deeper than this is two elements meeting, not clashing.
  { key: "hard10", id: "hard10", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0.05, useVolume: false, volume: 0.01 },
  // Finishes and structure routinely overlap by a couple of centimetres at a joint.
  { key: "hard25", id: "hard25", mode: "hard", horizontal: 0.025, vertical: 0.025, clearance: 0.05, useVolume: false, volume: 0.01 },
  // Room to insulate, to hang and to service.
  { key: "clearance50", id: "clearance50", mode: "clearance", horizontal: 0.01, vertical: 0.01, clearance: 0.05, useVolume: false, volume: 0.01 },
];

type Cell = [a: string, b: string, tolerance: string];

/**
 * The cells. Pairs not listed are not tested: walls against slabs is how a
 * building is made, not a clash.
 */
const RULES: Cell[] = [
  // Architecture × structure: overlaps of a few centimetres where finishes meet frame.
  ["walls", "columns", "hard25"],
  ["walls", "beams", "hard25"],
  ["walls", "foundations", "hard25"],
  ["floorsRoofs", "columns", "hard25"],
  ["floorsRoofs", "beams", "hard25"],
  ["floorsRoofs", "foundations", "hard25"],
  ["stairs", "columns", "hard25"],
  ["stairs", "beams", "hard25"],
  ["doors", "columns", "hard10"],
  ["doors", "beams", "hard10"],
  ["windows", "columns", "hard10"],
  ["windows", "beams", "hard10"],
  ["ceilings", "columns", "hard10"],
  ["ceilings", "beams", "hard10"],

  // Services × structure: the classic. A pipe through a beam is a clash; a pipe
  // through a slab is one until someone models the opening.
  ["ducts", "columns", "hard10"],
  ["ducts", "beams", "hard10"],
  ["ducts", "foundations", "hard10"],
  ["pipes", "columns", "hard10"],
  ["pipes", "beams", "hard10"],
  ["pipes", "foundations", "hard10"],
  ["cableways", "columns", "hard10"],
  ["cableways", "beams", "hard10"],
  ["equipment", "columns", "hard10"],
  ["equipment", "beams", "hard10"],
  ["terminals", "columns", "hard10"],
  ["terminals", "beams", "hard10"],

  // Services × architecture: penetrations and things in the way.
  ["ducts", "walls", "hard10"],
  ["ducts", "floorsRoofs", "hard10"],
  ["pipes", "walls", "hard10"],
  ["pipes", "floorsRoofs", "hard10"],
  ["cableways", "walls", "hard10"],
  ["cableways", "floorsRoofs", "hard10"],
  ["equipment", "walls", "hard10"],
  ["equipment", "floorsRoofs", "hard10"],
  ["ducts", "doors", "hard10"],
  ["ducts", "windows", "hard10"],
  ["pipes", "doors", "hard10"],
  ["pipes", "windows", "hard10"],
  ["ducts", "stairs", "hard10"],
  ["pipes", "stairs", "hard10"],
  ["ducts", "ceilings", "clearance50"],
  ["pipes", "ceilings", "clearance50"],

  // Services × services: kept apart, not merely not touching.
  ["ducts", "pipes", "clearance50"],
  ["ducts", "cableways", "clearance50"],
  ["pipes", "cableways", "clearance50"],
  ["equipment", "ducts", "hard10"],
  ["equipment", "pipes", "hard10"],
  ["equipment", "cableways", "hard10"],
];

/** A typical residential building: architecture, structure, HVAC, plumbing and electrical. */
export function residentialMatrix(label: TemplateLabel): ClashMatrix {
  const groups: ClashGroup[] = GROUPS.map((spec) => ({
    id: `tpl-${spec.key}`,
    name: label(`groups.${spec.key}`),
    discipline: label(`disciplines.${spec.discipline}`),
    filter: { ...EMPTY_ELEMENT_FILTER, classes: [...spec.classes] },
  }));

  const tolerances: ClashTolerance[] = TOLERANCES.map(({ key, ...tolerance }) => ({
    ...tolerance,
    id: `tpl-${key}`,
    name: label(`tolerances.${key}`),
  }));

  const seen = new Set<string>();
  const rules: ClashRule[] = [];
  for (const [a, b, tolerance] of RULES) {
    const rule = { a: `tpl-${a}`, b: `tpl-${b}`, toleranceId: `tpl-${tolerance}` };
    const key = ruleKey(rule.a, rule.b);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }

  return {
    groups,
    tolerances,
    rules,
    settings: {
      ...DEFAULT_CLASH_SETTINGS,
      // Discipline models are federated, and clashes inside one model are its
      // author's to fix, not the coordinator's.
      ignoreSameModel: true,
    },
  };
}

export function buildTemplate(id: TemplateId, label: TemplateLabel): ClashMatrix {
  switch (id) {
    case "residential":
      return residentialMatrix(label);
  }
}
