/**
 * The point-cloud file types the viewer reads, told apart by extension.
 *
 * Unlike CityJSON and GeoJSON, which share `.json`, these extensions are
 * unambiguous, so the extension decides — `LAS`/`LAZ` even announce themselves
 * in their first four bytes (`LASF`), which the decoder checks again.
 */

export type PointCloudFormat = "las" | "laz" | "ply" | "pcd" | "e57" | "pts" | "xyz";

export const POINT_CLOUD_FORMATS: readonly PointCloudFormat[] = [
  "las",
  "laz",
  "ply",
  "pcd",
  "e57",
  "pts",
  "xyz",
];

/** For `<input accept>`. */
export const POINT_CLOUD_ACCEPT = POINT_CLOUD_FORMATS.map((format) => `.${format}`).join(",");

export function pointCloudFormat(fileName: string): PointCloudFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const extension = match?.[1].toLowerCase();
  return POINT_CLOUD_FORMATS.find((format) => format === extension) ?? null;
}

export function isPointCloudFile(fileName: string): boolean {
  return pointCloudFormat(fileName) !== null;
}
