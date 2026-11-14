/**
 * The example model offered on an empty viewer.
 *
 * A static file of this app (`public/examples/`), downloaded from this origin
 * and opened exactly as a file the user picked would be: handed to
 * `loadModelFiles`, parsed in a worker. Nothing is sent anywhere; the request
 * names a file every visitor gets the same, so it says nothing about the user
 * (AGENTS.md §1).
 */

export const EXAMPLE_MODEL = {
  name: "VNGaia_example.ifc",
  url: "/examples/VNGaia_example.ifc",
} as const;

/** The example as a `File`, ready for `loadModelFiles`. Throws when it cannot be downloaded. */
export async function fetchExampleModel(signal?: AbortSignal): Promise<File> {
  const response = await fetch(EXAMPLE_MODEL.url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], EXAMPLE_MODEL.name, { type: "application/octet-stream" });
}
