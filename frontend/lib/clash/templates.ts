/**
 * Ready-made clash matrices.
 *
 * A matrix is a lot of typing before the first useful run: a couple of dozen
 * groups of IFC classes and the tolerance for each pair of them. The residential
 * one below is a coordination baseline for a house or apartment block —
 * architecture, structure, HVAC, plumbing, electrical, fire protection, ELV,
 * lifts, site utilities and two kinds of clearance zone — with the tests worth
 * running between them and the tolerance each should use.
 *
 * It comes from a residential coordination workbook (its Test Register, Filters,
 * Tolerances and General Requirements sheets): the 172 tests that workbook
 * enables are the cells here, and the 31 it leaves disabled are left empty.
 * What the workbook also carries — priority, run stage, reviewer, intent and
 * permitted exceptions per test — is a coordination register and has no place in
 * a matrix, so it is not here.
 *
 * It is a *baseline*, not a rule. Several groups select the same IFC classes
 * (the five kinds of pipework, architectural versus structural walls and
 * slabs), and what tells them apart is project-specific: which model, which
 * system. Those groups carry a note saying so, and they need a filter before
 * the results mean anything. Every group, tolerance and cell stays editable.
 *
 * The words (discipline, group, tolerance and note text) are passed in so the
 * matrix reads in the user's language; the structure is the same in both.
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
  /** The workbook's own code (A01, S02, H03…), lower-cased. */
  key: string;
  discipline:
    | "architecture"
    | "structure"
    | "hvac"
    | "plumbing"
    | "electrical"
    | "fire"
    | "elv"
    | "transport"
    | "civil"
    | "zones";
  classes: string[];
  predefinedTypes?: string[];
  names?: string[];
};

/**
 * Wildcards, because a class and its subtypes belong together: `IfcWall*` is
 * `IfcWall`, `IfcWallStandardCase` and `IfcWallElementedCase`.
 *
 * The two clearance-zone groups select only solids *named* `CLZ_MAINT_*` or
 * `CLZ_EGRESS_*`. Left to the class alone they would select every room in the
 * building (`IfcSpace`), and the zone is something the project models on
 * purpose.
 */
const GROUPS: GroupSpec[] = [
  { key: "a01", discipline: "architecture", classes: ["IfcWall*", "IfcCurtainWall"] }, // Walls & partitions
  { key: "a02", discipline: "architecture", classes: ["IfcSlab*", "IfcRoof*"] }, // Floors & roofs
  { key: "a03", discipline: "architecture", classes: ["IfcDoor*"] }, // Doors
  { key: "a04", discipline: "architecture", classes: ["IfcWindow*"] }, // Windows & glazing
  { key: "a05", discipline: "architecture", classes: ["IfcStair*", "IfcRamp*", "IfcRailing*"] }, // Stairs, ramps & railings
  { key: "a06", discipline: "architecture", classes: ["IfcCovering*"], predefinedTypes: ["CEILING"] }, // Suspended ceilings
  { key: "a07", discipline: "architecture", classes: ["IfcFurnishingElement*", "IfcSystemFurnitureElement*", "IfcBuildingElementProxy*"] }, // Fixed joinery
  { key: "s01", discipline: "structure", classes: ["IfcWall*", "IfcSlab*"] }, // Structural slabs & walls
  { key: "s02", discipline: "structure", classes: ["IfcColumn*", "IfcBeam*", "IfcMember*"] }, // Columns & beams
  { key: "s03", discipline: "structure", classes: ["IfcFooting*", "IfcPile*"] }, // Foundations & piles
  { key: "h01", discipline: "hvac", classes: ["IfcDuctSegment*", "IfcDuctFitting*"] }, // HVAC ducts
  { key: "h02", discipline: "hvac", classes: ["IfcAirTerminal*", "IfcAirTerminalBox*", "IfcFan*", "IfcDamper*", "IfcUnitaryEquipment*", "IfcEnergyConversionDevice*"] }, // Air terminals & HVAC plant
  { key: "h03", discipline: "hvac", classes: ["IfcPipeSegment*", "IfcPipeFitting*"] }, // Heating / cooling pipes
  { key: "p01", discipline: "plumbing", classes: ["IfcPipeSegment*", "IfcPipeFitting*"] }, // Domestic water pipes
  { key: "p02", discipline: "plumbing", classes: ["IfcPipeSegment*", "IfcPipeFitting*"] }, // Waste / rainwater pipes
  { key: "p03", discipline: "plumbing", classes: ["IfcSanitaryTerminal*", "IfcWasteTerminal*", "IfcTank*", "IfcPump*"] }, // Plumbing fixtures & pumps
  { key: "e01", discipline: "electrical", classes: ["IfcCableCarrierSegment*", "IfcCableCarrierFitting*"] }, // Cable trays & conduits
  { key: "e02", discipline: "electrical", classes: ["IfcElectricDistributionBoard*", "IfcTransformer*", "IfcSwitchingDevice*", "IfcProtectiveDevice*"] }, // Boards & electrical plant
  { key: "e03", discipline: "electrical", classes: ["IfcLightFixture*", "IfcOutlet*", "IfcJunctionBox*"] }, // Lighting & power devices
  { key: "f01", discipline: "fire", classes: ["IfcPipeSegment*", "IfcPipeFitting*"] }, // Sprinkler pipework
  { key: "f02", discipline: "fire", classes: ["IfcFireSuppressionTerminal*", "IfcAlarm*", "IfcSensor*"] }, // Sprinkler heads & fire devices
  { key: "l01", discipline: "elv", classes: ["IfcCommunicationsAppliance*", "IfcAlarm*", "IfcSensor*", "IfcAudioVisualAppliance*"] }, // ELV / security devices
  { key: "v01", discipline: "transport", classes: ["IfcTransportElement*"] }, // Lifts & transport
  { key: "c01", discipline: "civil", classes: ["IfcPipeSegment*", "IfcPipeFitting*", "IfcDistributionChamberElement*"] }, // External utilities
  { key: "z01", discipline: "zones", classes: ["IfcSpace*", "IfcBuildingElementProxy*"], names: ["CLZ_MAINT_*"] }, // Plant maintenance zones
  { key: "z02", discipline: "zones", classes: ["IfcSpace*", "IfcBuildingElementProxy*"], names: ["CLZ_EGRESS_*"] }, // Egress / door swing zones
];

/** The groups that need the project to say which of the same-class elements they mean. */
export const GROUPS_NEEDING_SETUP: ReadonlySet<string> = new Set(["a01", "a02", "a07", "s01", "h03", "p01", "p02", "f01", "c01", "z01", "z02"]);

/** Distances in metres. Clearance mode ignores the overlap depth; hard mode ignores the gap. */
const TOLERANCES: Array<Omit<ClashTolerance, "name"> & { key: string }> = [
  { key: "hard5", id: "hard5", mode: "hard", horizontal: 0.005, vertical: 0.005, clearance: 0, useVolume: false, volume: 0 },
  { key: "hard10", id: "hard10", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0, useVolume: false, volume: 0 },
  { key: "hard25", id: "hard25", mode: "hard", horizontal: 0.025, vertical: 0.025, clearance: 0, useVolume: false, volume: 0 },
  { key: "clearance50", id: "clearance50", mode: "clearance", horizontal: 0.005, vertical: 0.005, clearance: 0.05, useVolume: false, volume: 0 },
  { key: "clearance100", id: "clearance100", mode: "clearance", horizontal: 0.005, vertical: 0.005, clearance: 0.1, useVolume: false, volume: 0 },
  { key: "clearance150", id: "clearance150", mode: "clearance", horizontal: 0.005, vertical: 0.005, clearance: 0.15, useVolume: false, volume: 0 },
  { key: "clearance300", id: "clearance300", mode: "clearance", horizontal: 0.005, vertical: 0.005, clearance: 0.3, useVolume: false, volume: 0 },
  { key: "clearance600", id: "clearance600", mode: "clearance", horizontal: 0.005, vertical: 0.005, clearance: 0.6, useVolume: false, volume: 0 },
];

type Cell = [a: string, b: string, tolerance: string];

/**
 * The enabled tests. A pair not listed is not tested: walls resting on a slab,
 * or a door in its wall, is how a building is made rather than a clash.
 */
const RULES: Cell[] = [
  ["s02", "a01", "hard10"],
  ["h01", "a01", "hard10"],
  ["p02", "a01", "hard10"],
  ["f01", "a01", "hard10"],
  ["z01", "a01", "hard5"],
  ["z02", "a01", "hard5"],
  ["h01", "a02", "hard10"],
  ["h03", "a02", "hard10"],
  ["p01", "a02", "hard10"],
  ["p02", "a02", "hard10"],
  ["e01", "a02", "hard10"],
  ["f01", "a02", "hard10"],
  ["a05", "a03", "hard10"],
  ["a07", "a03", "hard10"],
  ["s01", "a03", "hard10"],
  ["s02", "a03", "hard10"],
  ["h01", "a03", "hard10"],
  ["e02", "a03", "hard10"],
  ["z01", "a03", "hard5"],
  ["a05", "a04", "hard10"],
  ["s01", "a04", "hard10"],
  ["s02", "a04", "hard10"],
  ["h01", "a04", "hard10"],
  ["e02", "a04", "hard10"],
  ["a06", "a05", "hard10"],
  ["a07", "a05", "hard10"],
  ["s01", "a05", "hard10"],
  ["s02", "a05", "hard10"],
  ["h01", "a05", "hard10"],
  ["h02", "a05", "hard10"],
  ["p02", "a05", "hard10"],
  ["e01", "a05", "hard10"],
  ["f01", "a05", "hard10"],
  ["z01", "a05", "hard5"],
  ["z02", "a05", "hard5"],
  ["s02", "a06", "hard10"],
  ["h01", "a06", "hard10"],
  ["h02", "a06", "hard10"],
  ["h03", "a06", "hard10"],
  ["p02", "a06", "hard10"],
  ["e01", "a06", "hard10"],
  ["f01", "a06", "hard10"],
  ["h02", "a07", "hard10"],
  ["e02", "a07", "hard10"],
  ["z01", "a07", "hard5"],
  ["z02", "a07", "hard5"],
  ["h01", "s01", "hard10"],
  ["h02", "s01", "hard10"],
  ["h03", "s01", "hard5"],
  ["p01", "s01", "hard5"],
  ["p02", "s01", "hard10"],
  ["p03", "s01", "hard5"],
  ["e01", "s01", "hard5"],
  ["e02", "s01", "hard10"],
  ["e03", "s01", "hard5"],
  ["f01", "s01", "hard10"],
  ["f02", "s01", "hard5"],
  ["l01", "s01", "hard5"],
  ["v01", "s01", "hard10"],
  ["c01", "s01", "hard10"],
  ["z01", "s01", "hard5"],
  ["z02", "s01", "hard5"],
  ["h01", "s02", "hard10"],
  ["h02", "s02", "hard10"],
  ["h03", "s02", "hard5"],
  ["p01", "s02", "hard5"],
  ["p02", "s02", "hard10"],
  ["p03", "s02", "hard5"],
  ["e01", "s02", "hard5"],
  ["e02", "s02", "hard10"],
  ["e03", "s02", "hard5"],
  ["f01", "s02", "hard10"],
  ["f02", "s02", "hard5"],
  ["l01", "s02", "hard5"],
  ["v01", "s02", "hard10"],
  ["z01", "s02", "hard5"],
  ["z02", "s02", "hard5"],
  ["h03", "s03", "hard5"],
  ["p01", "s03", "hard5"],
  ["p02", "s03", "hard10"],
  ["f01", "s03", "hard10"],
  ["v01", "s03", "hard10"],
  ["c01", "s03", "hard10"],
  ["z01", "s03", "hard5"],
  ["h03", "h01", "clearance100"],
  ["p01", "h01", "clearance100"],
  ["p02", "h01", "clearance100"],
  ["p03", "h01", "hard10"],
  ["e01", "h01", "clearance50"],
  ["e02", "h01", "hard10"],
  ["e03", "h01", "hard10"],
  ["f01", "h01", "clearance100"],
  ["f02", "h01", "clearance100"],
  ["l01", "h01", "hard10"],
  ["v01", "h01", "hard10"],
  ["z01", "h01", "hard5"],
  ["z02", "h01", "hard5"],
  ["h03", "h02", "hard10"],
  ["p01", "h02", "hard10"],
  ["p02", "h02", "hard10"],
  ["p03", "h02", "hard10"],
  ["e01", "h02", "hard10"],
  ["e02", "h02", "hard10"],
  ["e03", "h02", "clearance50"],
  ["f01", "h02", "hard10"],
  ["f02", "h02", "clearance100"],
  ["l01", "h02", "hard10"],
  ["z01", "h02", "hard5"],
  ["z02", "h02", "hard5"],
  ["p01", "h03", "clearance50"],
  ["p02", "h03", "clearance50"],
  ["p03", "h03", "hard10"],
  ["e01", "h03", "clearance50"],
  ["e02", "h03", "hard10"],
  ["f01", "h03", "clearance50"],
  ["f02", "h03", "clearance100"],
  ["c01", "h03", "clearance100"],
  ["z01", "h03", "hard5"],
  ["z02", "h03", "hard5"],
  ["p02", "p01", "clearance50"],
  ["e01", "p01", "clearance50"],
  ["e02", "p01", "clearance150"],
  ["f01", "p01", "clearance50"],
  ["f02", "p01", "clearance100"],
  ["c01", "p01", "clearance100"],
  ["z01", "p01", "hard5"],
  ["z02", "p01", "hard5"],
  ["p03", "p02", "hard10"],
  ["e01", "p02", "clearance100"],
  ["e02", "p02", "clearance150"],
  ["e03", "p02", "hard10"],
  ["f01", "p02", "clearance50"],
  ["f02", "p02", "clearance100"],
  ["l01", "p02", "hard10"],
  ["v01", "p02", "hard10"],
  ["c01", "p02", "clearance100"],
  ["z01", "p02", "hard5"],
  ["z02", "p02", "hard5"],
  ["e01", "p03", "hard10"],
  ["e02", "p03", "clearance150"],
  ["e03", "p03", "hard10"],
  ["f01", "p03", "hard10"],
  ["z01", "p03", "hard5"],
  ["z02", "p03", "hard5"],
  ["e02", "e01", "hard10"],
  ["e03", "e01", "hard10"],
  ["f01", "e01", "clearance50"],
  ["f02", "e01", "clearance100"],
  ["l01", "e01", "hard10"],
  ["v01", "e01", "hard10"],
  ["c01", "e01", "clearance100"],
  ["z01", "e01", "hard5"],
  ["z02", "e01", "hard5"],
  ["f01", "e02", "clearance150"],
  ["f02", "e02", "clearance150"],
  ["l01", "e02", "clearance50"],
  ["v01", "e02", "hard10"],
  ["z01", "e02", "hard5"],
  ["z02", "e02", "hard5"],
  ["f01", "e03", "hard10"],
  ["f02", "e03", "clearance100"],
  ["l01", "e03", "hard10"],
  ["z02", "e03", "hard5"],
  ["v01", "f01", "hard10"],
  ["c01", "f01", "clearance100"],
  ["z01", "f01", "hard5"],
  ["z02", "f01", "hard5"],
  ["l01", "f02", "clearance50"],
  ["z02", "f02", "hard5"],
  ["z02", "l01", "hard5"],
  ["z01", "v01", "hard5"],
  ["z02", "v01", "hard5"],
];

/** A typical residential building, from the coordination workbook described above. */
export function residentialMatrix(label: TemplateLabel): ClashMatrix {
  const groups: ClashGroup[] = GROUPS.map((spec) => ({
    id: `tpl-${spec.key}`,
    name: label(`groups.${spec.key}`),
    discipline: label(`disciplines.${spec.discipline}`),
    filter: {
      ...EMPTY_ELEMENT_FILTER,
      classes: [...spec.classes],
      predefinedTypes: [...(spec.predefinedTypes ?? [])],
      names: [...(spec.names ?? [])],
    },
    ...(GROUPS_NEEDING_SETUP.has(spec.key) ? { note: label(`notes.${spec.key}`) } : {}),
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
      // The workbook's own General Requirements: all three checks on, and
      // elements of the same model are still tested against each other.
      checkOverlap: true,
      checkInside: true,
      checkDuplicate: true,
      ignoreSameModel: false,
    },
  };
}

export function buildTemplate(id: TemplateId, label: TemplateLabel): ClashMatrix {
  switch (id) {
    case "residential":
      return residentialMatrix(label);
  }
}
