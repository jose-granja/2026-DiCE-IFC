/**
 * The lenses that come with the app, as on ifclite.com: colour by class, type,
 * material, storey or model, and four discipline views built from rules.
 *
 * Names here are English fallbacks; the panel shows `viewer.lens.builtin.*`.
 * A built-in cannot be edited — "Duplicate" makes an editable copy.
 */

import { EMPTY_ELEMENT_FILTER, type ElementFilter } from "@/lib/ifc/types";
import type { Lens, LensRule } from "./types";

const classes = (...patterns: string[]): ElementFilter => ({ ...EMPTY_ELEMENT_FILTER, classes: patterns });

function rule(id: string, name: string, colour: string, filter: ElementFilter): LensRule {
  return { id, name, enabled: true, filter, action: "colour", colour };
}

export const BUILTIN_LENSES: Lens[] = [
  { id: "builtin:by-class", name: "By IFC class", kind: "auto", source: { kind: "class" }, unmatched: "ghost", builtin: true },
  { id: "builtin:by-type", name: "By type", kind: "auto", source: { kind: "objectType" }, unmatched: "ghost", builtin: true },
  { id: "builtin:by-material", name: "By material", kind: "auto", source: { kind: "material" }, unmatched: "ghost", builtin: true },
  { id: "builtin:by-storey", name: "By storey", kind: "auto", source: { kind: "storey" }, unmatched: "ghost", builtin: true },
  { id: "builtin:by-model", name: "By model", kind: "auto", source: { kind: "model" }, unmatched: "ghost", builtin: true },
  {
    id: "builtin:structural",
    name: "Structural",
    kind: "rules",
    unmatched: "ghost",
    builtin: true,
    rules: [
      rule("columns", "Columns", "#e53935", classes("IfcColumn*")),
      rule("beams", "Beams", "#1e88e5", classes("IfcBeam*", "IfcMember*")),
      rule("slabs", "Slabs", "#fdd835", classes("IfcSlab*")),
      rule("foundations", "Foundations", "#43a047", classes("IfcFooting*", "IfcPile*")),
      rule("load-bearing", "Load-bearing walls", "#fb8c00", {
        ...classes("IfcWall*"),
        properties: [{ setName: "Pset_WallCommon", propertyName: "LoadBearing", operator: "equals", value: "TRUE" }],
      }),
    ],
  },
  {
    id: "builtin:envelope",
    name: "Building envelope",
    kind: "rules",
    unmatched: "ghost",
    builtin: true,
    rules: [
      rule("roofs", "Roofs", "#8e24aa", classes("IfcRoof*")),
      rule("curtain-walls", "Curtain walls", "#00acc1", classes("IfcCurtainWall*", "IfcPlate*")),
      rule("windows", "Windows", "#1e88e5", classes("IfcWindow*")),
      rule("doors", "Doors", "#6d4c41", classes("IfcDoor*")),
      rule("external-walls", "External walls", "#fb8c00", {
        ...classes("IfcWall*"),
        properties: [{ setName: "Pset_WallCommon", propertyName: "IsExternal", operator: "equals", value: "TRUE" }],
      }),
    ],
  },
  {
    id: "builtin:openings",
    name: "Openings and circulation",
    kind: "rules",
    unmatched: "ghost",
    builtin: true,
    rules: [
      rule("doors", "Doors", "#6d4c41", classes("IfcDoor*")),
      rule("windows", "Windows", "#1e88e5", classes("IfcWindow*")),
      rule("stairs", "Stairs", "#e53935", classes("IfcStair*")),
      rule("ramps", "Ramps", "#43a047", classes("IfcRamp*")),
      rule("railings", "Railings", "#fdd835", classes("IfcRailing*")),
    ],
  },
  {
    id: "builtin:mep",
    name: "MEP systems",
    kind: "rules",
    unmatched: "ghost",
    builtin: true,
    rules: [
      rule("ducts", "Ductwork", "#00acc1", classes("IfcDuct*", "IfcAirTerminal*")),
      rule("pipes", "Pipework", "#1e88e5", classes("IfcPipe*", "IfcValve*", "IfcSanitaryTerminal*")),
      rule("electrical", "Electrical", "#fdd835", classes("IfcCable*", "IfcLight*", "IfcOutlet*", "IfcSwitchingDevice*")),
      rule("equipment", "Equipment", "#8e24aa", classes("IfcFlow*", "IfcEnergyConversionDevice*", "IfcUnitaryEquipment*", "IfcPump*", "IfcFan*")),
    ],
  },
];

export function builtinLens(id: string): Lens | undefined {
  return BUILTIN_LENSES.find((lens) => lens.id === id);
}
