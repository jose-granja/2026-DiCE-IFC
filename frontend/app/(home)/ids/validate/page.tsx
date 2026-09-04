import { redirect } from "next/navigation";

/**
 * IDS validation moved into the viewer.
 *
 * It is a panel there rather than a page here, because the useful action on a
 * failure is "show me that element" and that needs the viewport. This redirect
 * keeps old links and bookmarks working instead of 404ing.
 */
export default function IdsValidatePage() {
  redirect("/viewer?panel=ids");
}
