/**
 * What `IfcMapConversion.Scale` means for the size of a model on screen.
 *
 * The attribute is one number that files use for two different things:
 *
 * - **Units.** The schema defines it as the factor from the project's length unit
 *   to the map CRS's — so a millimetre project in a metric CRS carries `0.001`,
 *   a foot project `0.3048`. Authoring tools write it that way.
 * - **Grid scale.** A true projection scale factor, close to 1 (`0.9996`).
 *
 * The geometry the engine hands over is already in **metres** — it applies the
 * project unit itself — so a unit-conversion `Scale` must not be applied a
 * second time. Doing so shrank a millimetre model with `Scale = 0.001` a
 * thousandfold: right place, wrong size.
 *
 * What the factor between render metres and map metres actually is:
 *
 * - as a grid scale: `Scale`;
 * - as a unit conversion: `Scale / lengthUnitScale` (`0.001 / 0.001 = 1`).
 *
 * Which one a file means is not recorded. But the two readings differ by the unit
 * factor, which is 1000 or 3.28 and never plausible as a real distortion, so the
 * one nearer 1 is the right one: a building is not stretched a thousandfold by
 * its coordinate system. For a metre project the two readings are the same number
 * and it is applied as written.
 */
export function effectiveScale(scale: number | undefined, lengthUnitScale: number | undefined): number {
  const declared = scale ?? 1;
  const unit = lengthUnitScale ?? 1;
  if (!Number.isFinite(declared) || declared <= 0) return 1;
  if (!Number.isFinite(unit) || unit <= 0 || unit === 1) return declared;

  const asUnitConversion = declared / unit;
  return Math.abs(Math.log(asUnitConversion)) < Math.abs(Math.log(declared)) ? asUnitConversion : declared;
}
