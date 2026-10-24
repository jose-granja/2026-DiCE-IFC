/** Display precision only: model values and calculations retain their full precision. */
export const DEFAULT_PROPERTY_DECIMALS = 3;
export const MAX_PROPERTY_DECIMALS = 15;

const formatters = new Map<number, Intl.NumberFormat>();

export function formatPropertyValue(
  value: string | number | boolean | null,
  yes: string,
  no: string,
  unit?: string,
  decimalPlaces = DEFAULT_PROPERTY_DECIMALS,
): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? yes : no;
  // Unitless numbers, identifiers and text keep their original representation.
  if (!unit?.trim() || (typeof value === "string" && !value.trim())) return String(value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const digits = Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= MAX_PROPERTY_DECIMALS
    ? decimalPlaces : DEFAULT_PROPERTY_DECIMALS;
  let formatter = formatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en", { useGrouping: false, maximumFractionDigits: digits });
    formatters.set(digits, formatter);
  }
  const rounded = formatter.format(numeric);
  return `${rounded === "-0" ? "0" : rounded} ${unit}`;
}
