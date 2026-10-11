"use client";

import { useTranslations } from "next-intl";
import { EyeOff, Layers, Shapes } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sameClassRefs, sameStoreyRefs } from "@/lib/viewer/context-actions";
import { refKey, useViewerStore, type EntityRef } from "@/lib/viewer/store";

export type ViewerContextMenuState = {
  /** Where the pointer was, in viewport pixels. */
  x: number;
  y: number;
  /** The element that was right-clicked. */
  target: EntityRef;
} | null;

/**
 * The viewport's right-click menu.
 *
 * A dropdown opened by hand rather than a browser-style context menu, and
 * opened on pointer *up*. A context menu opens when the button goes down on
 * macOS, which would make it impossible to drag with the right button — and
 * that is how the camera pans. Waiting for the release, and for the pointer not
 * to have travelled, lets the same button do both.
 *
 * It acts on what was clicked: the click has already made that element the
 * selection (or kept the selection it was part of), so "Hide selected" means
 * exactly what the user sees highlighted.
 */
export function ViewerContextMenu({
  state,
  onClose,
}: {
  state: ViewerContextMenuState;
  onClose: () => void;
}) {
  const t = useTranslations("viewer.contextMenu");
  const models = useViewerStore((s) => s.models);
  const typeByRef = useViewerStore((s) => s.entityTypeByRef);
  const selectionCount = useViewerStore((s) => s.selection.length);

  if (!state) return null;

  const type = typeByRef.get(refKey(state.target));
  const tree = models.find((m) => m.summary.id === state.target.modelId)?.spatialTree ?? null;
  const floor = sameStoreyRefs(state.target, tree, typeByRef, (ref) =>
    useViewerStore.getState().isVisible(ref),
  );

  const hideSelected = () => {
    const { selection, hide, clearSelection } = useViewerStore.getState();
    hide(selection);
    // A hidden element left selected stays highlighted in the tree and properties
    // panel while it is nowhere to be seen.
    clearSelection();
  };

  const selectSameClass = () => {
    const store = useViewerStore.getState();
    const refs = sameClassRefs(state.target, store.entityTypeByRef, store.isVisible);
    store.select(refs, "replace");
    toast.success(t("selectedClass", { count: refs.length, type: type ?? "" }));
  };

  const selectSameFloor = () => {
    if (!floor) return;
    useViewerStore.getState().select(floor.refs, "replace");
    toast.success(t("selectedFloor", { count: floor.refs.length, floor: floor.storeyName }));
  };

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        {/* The anchor: nothing to see or hit, only a place for the menu to attach. */}
        <span
          aria-hidden
          style={{ position: "fixed", left: state.x, top: state.y, width: 1, height: 1, pointerEvents: "none" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" data-viewer-context-menu className="min-w-56">
        {type && <DropdownMenuLabel className="text-xs">{type}</DropdownMenuLabel>}
        <DropdownMenuItem disabled={selectionCount === 0} onSelect={hideSelected}>
          <EyeOff />
          {t("hideSelected")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!type} onSelect={selectSameClass}>
          <Shapes />
          {type ? t("selectSameClass", { type }) : t("selectSameClassUnknown")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!floor} onSelect={selectSameFloor}>
          <Layers />
          {floor ? t("selectSameFloor") : t("noFloor")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ViewerContextMenu;
