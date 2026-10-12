import { redirect } from "next/navigation";

/** Preserve existing bookmarks after combining both signing formats. */
export default function EmbeddedIfcSignPage() {
  redirect("/sign/ifc");
}
