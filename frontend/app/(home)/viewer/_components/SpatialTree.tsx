"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";

import type { SpatialNodeView } from "@/lib/ifc/types";
import { refKey, useViewerStore, type ViewerModel } from "@/lib/viewer/store";
import { cn } from "@/lib/utils";

/**
 * The federated spatial tree: one root per model, then that model's own
 * hierarchy.
 *
 * This is also the accessible alternative to the 3D canvas. It is a real
 * `tree`/`treeitem` structure with keyboard navigation, so everything the
 * viewport offers — find an element, select it, isolate it — is reachable
 * without a pointer.
 */
export function SpatialTree() {
  const t = useTranslations("viewer.spatialTree");
  const models = useViewerStore((s) => s.models);

  if (models.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("loadModel")}
      </p>
    );
  }

  return (
    <div
      role="tree"
      aria-label={t("treeLabel")}
      className="py-1 text-sm"
    >
      {models.map((model) => (
        <ModelBranch key={model.summary.id} model={model} />
      ))}
    </div>
  );
}

function ModelBranch({ model }: { model: ViewerModel }) {
  const t = useTranslations("viewer.spatialTree");
  const [open, setOpen] = useState(true);

  return (
    <div
      role="treeitem"
      aria-expanded={open}
      aria-selected={false}
      aria-label={model.summary.name}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        <Chevron open={open} />
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ backgroundColor: model.colour }}
        />
        <span className="truncate font-medium">{model.summary.name}</span>
      </button>

      {open && (
        <div role="group">
          {model.spatialTree ? (
            <TreeNode
              node={model.spatialTree}
              modelId={model.summary.id}
              depth={1}
            />
          ) : (
            <p className="text-muted-foreground py-1 pl-8 text-xs">
              {t("readingStructure")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  modelId,
  depth,
}: {
  node: SpatialNodeView;
  modelId: string;
  depth: number;
}) {
  // Open down to storeys (project → site → building → storey), because the
  // spatial structure is what the panel is for. Storeys stay collapsed: their
  // children are the elements, and a storey can hold tens of thousands.
  const t = useTranslations("viewer.spatialTree");
  const [open, setOpen] = useState(depth < 4);
  const select = useViewerStore((s) => s.select);

  /**
   * Open to reveal a selection made elsewhere.
   *
   * Picking an element in the viewport marks its row `aria-selected`, which is
   * invisible if the branch holding it is collapsed — and storeys start
   * collapsed because they can hold tens of thousands of elements. So a node
   * opens itself when the selection is somewhere beneath it.
   *
   * Only ever opens. Collapsing on deselect would fight the user, who may have
   * opened the branch deliberately.
   */
  const holdsSelection = useViewerStore((s) =>
    s.selection.some(
      (ref) => ref.modelId === modelId && containsElement(node, ref.expressId),
    ),
  );
  if (holdsSelection && !open) setOpen(true);

  const isSelected = useViewerStore((s) =>
    s.selection.some(
      (r) => r.modelId === modelId && r.expressId === node.expressId,
    ),
  );

  const hasChildren = node.children.length > 0 || node.elementIds.length > 0;

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={isSelected}
    >
      <div
        className={cn(
          "hover:bg-accent flex items-center gap-1",
          isSelected && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? t("collapse") : t("expand")}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 p-0.5"
          >
            <Chevron open={open} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <button
          type="button"
          onClick={(e) =>
            select(
              [{ modelId, expressId: node.expressId }],
              e.shiftKey ? "toggle" : "replace",
            )
          }
          className="min-w-0 flex-1 truncate py-1 text-left"
          title={node.name}
        >
          {node.name || `#${node.expressId}`}
          {node.elevation !== undefined && (
            <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
              {node.elevation.toFixed(2)} m
            </span>
          )}
        </button>
      </div>

      {open && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.expressId}
              node={child}
              modelId={modelId}
              depth={depth + 1}
            />
          ))}
          {node.elementIds.length > 0 && (
            <ElementList
              elementIds={node.elementIds}
              modelId={modelId}
              depth={depth + 1}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Contained elements, capped.
 *
 * A storey can hold 40 000 elements and rendering them all would freeze the
 * panel. The cap is honest about what it is hiding, and the entity list panel
 * (virtualised) is where large sets belong.
 */
const ELEMENT_CAP = 200;

function ElementList({
  elementIds,
  modelId,
  depth,
}: {
  elementIds: number[];
  modelId: string;
  depth: number;
}) {
  const t = useTranslations("viewer.spatialTree");
  const select = useViewerStore((s) => s.select);
  const selection = useViewerStore((s) => s.selection);
  const selected = useMemo(
    () => new Set(selection.map(refKey)),
    [selection],
  );

  const shown = elementIds.slice(0, ELEMENT_CAP);

  return (
    <>
      {shown.map((expressId) => {
        const key = refKey({ modelId, expressId });
        const isSelected = selected.has(key);
        return (
          <button
            key={expressId}
            type="button"
            role="treeitem"
            /*
              Bring a selection made in the viewport onto the screen.

              Revealing the row is not enough on its own: a storey's element
              list can be hundreds long, so the row is usually below the fold.
              `nearest` rather than `center` so a row already in view does not
              jump.
            */
            ref={(element) => {
              if (isSelected && element) {
                element.scrollIntoView({ block: "nearest" });
              }
            }}
            aria-selected={isSelected}
            onClick={(e) =>
              select(
                [{ modelId, expressId }],
                e.shiftKey ? "toggle" : "replace",
              )
            }
            className={cn(
              "hover:bg-accent flex w-full items-center gap-1.5 py-0.5 text-left text-xs",
              selected.has(key) && "bg-accent text-accent-foreground",
            )}
            style={{ paddingLeft: `${depth * 12 + 28}px` }}
          >
            <Layers className="text-muted-foreground h-3 w-3 shrink-0" />
            <span className="truncate">#{expressId}</span>
          </button>
        );
      })}
      {elementIds.length > ELEMENT_CAP && (
        <p
          className="text-muted-foreground py-1 text-xs"
          style={{ paddingLeft: `${depth * 12 + 28}px` }}
        >
          {t("moreElements", { count: elementIds.length - ELEMENT_CAP })}
        </p>
      )}
    </>
  );
}

/** Whether `expressId` is this node or anywhere beneath it. */
function containsElement(node: SpatialNodeView, expressId: number): boolean {
  if (node.expressId === expressId) return true;
  if (node.elementIds.includes(expressId)) return true;
  return node.children.some((child) => containsElement(child, expressId));
}

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
  ) : (
    <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
  );
}

export default SpatialTree;
