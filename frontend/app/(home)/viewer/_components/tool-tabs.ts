/**
 * The viewer's tool tabs and the icon each is known by — on its tab, and at the
 * top of its panel. One table, so the two cannot drift apart: the QTO panel's
 * header once showed a calculator under a Σ tab.
 */

import {
  Boxes,
  ClipboardCheck,
  Crosshair,
  Funnel,
  Glasses,
  Globe,
  ListTree,
  MapPinned,
  MessagesSquare,
  Ruler,
  Scissors,
  ShieldCheck,
  Sigma,
  type LucideIcon,
} from "lucide-react";

export type ToolTab =
  | "models"
  | "structure"
  | "classes"
  | "lens"
  | "quantities"
  | "georef"
  | "gis"
  | "section"
  | "measure"
  | "ids"
  | "validation"
  | "clash"
  | "bcf";

export const TOOL_TAB_ICONS: Record<ToolTab, LucideIcon> = {
  models: Boxes,
  structure: ListTree,
  classes: Funnel,
  lens: Glasses,
  quantities: Sigma,
  georef: Globe,
  gis: MapPinned,
  section: Scissors,
  measure: Ruler,
  ids: ClipboardCheck,
  validation: ShieldCheck,
  clash: Crosshair,
  bcf: MessagesSquare,
};
