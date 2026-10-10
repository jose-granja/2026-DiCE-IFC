import { redirect } from "next/navigation";

/**
 * The BCF manager moved into the viewer.
 *
 * Issues are about elements, and the two useful actions on a topic — open its
 * viewpoint, raise a new one from the current view — both need the viewport
 * beside them. This redirect keeps old links working.
 */
export default function BcfPage() {
  redirect("/viewer?panel=bcf");
}
