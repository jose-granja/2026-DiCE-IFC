/**
 * Shared types. Nothing here describes a model payload — IFC/BCF/IDS types live
 * in `lib/ifc`, `lib/bcf` and `lib/ids` and never cross a network boundary.
 */

export type SelectOption = {
  value: string | number;
  label: string;
};
