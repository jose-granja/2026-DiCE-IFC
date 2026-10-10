/**
 * `IfcCompoundPlaneAngleMeasure`: an angle as a list of integers — degrees,
 * minutes, seconds and, optionally, millionths of a second — which is how
 * `IfcSite.RefLatitude` and `RefLongitude` are written.
 *
 * Every component carries the sign of the angle (IFC requires them to agree),
 * so a western longitude is `(-8,-25,-17,-200000)`, not `(-8,25,17,200000)`.
 */

export type CompoundAngle = [number, number, number, number];

export function degreesToCompoundAngle(degrees: number): CompoundAngle {
  if (!Number.isFinite(degrees)) throw new RangeError("An angle must be a finite number of degrees.");
  const sign = degrees < 0 ? -1 : 1;
  // Whole millionths of a second first, so rounding carries cleanly upward
  // instead of leaving 60 seconds or 1 000 000 millionths behind.
  let total = Math.round(Math.abs(degrees) * 3600 * 1_000_000);
  const micro = total % 1_000_000;
  total = (total - micro) / 1_000_000;
  const seconds = total % 60;
  total = (total - seconds) / 60;
  const minutes = total % 60;
  const wholeDegrees = (total - minutes) / 60;
  const signed = (n: number) => (n === 0 ? 0 : sign * n);
  return [signed(wholeDegrees), signed(minutes), signed(seconds), signed(micro)];
}

/** The STEP text of a compound angle: `(51,54,9,635411)`. */
export function compoundAngleToStep(degrees: number): string {
  return `(${degreesToCompoundAngle(degrees).join(",")})`;
}

export function compoundAngleToDegrees(parts: number[]): number {
  const [d = 0, m = 0, s = 0, micro = 0] = parts;
  const magnitude = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600 + Math.abs(micro) / 3_600_000_000;
  const lead = [d, m, s, micro].find((part) => part !== 0) ?? 0;
  return lead < 0 ? -magnitude : magnitude;
}
