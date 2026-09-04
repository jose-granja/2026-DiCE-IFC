import { redirect } from "next/navigation";

/**
 * Georeferencing moved into the viewer.
 *
 * The question it answers — is this model in the right place, facing the right
 * way — is a 3D one, so the basemap now sits under the model in the viewport
 * rather than beside it as a footprint polygon on a separate 2D map. This
 * redirect keeps old links working.
 */
export default function GeorefPage() {
  redirect("/viewer?panel=georef");
}
