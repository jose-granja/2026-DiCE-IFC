"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  Layers,
} from "lucide-react";

import type { SpatialNodeView } from "@/lib/ifc/types";
import { subtreeRefs } from "@/lib/viewer/hierarchy";
import {
  refKey,
  useViewerStore,
  type EntityRef,
  type ViewerModel,
} from "@/lib/viewer/store";
import { cn } from "@/lib/utils";

/**
 * The federated spatial tree: one root per model, then that model's own
 * hierarchy. Selecting a spatial node selects every object in that subtree;
 * its action buttons apply the same scope to visibility and isolation.
 */
export function SpatialTree() {
  const t = useTranslations("viewer.spatialTree");
  const models = useViewerStore((state) => state.models);

  if (models.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">{t("loadModel")}</p>
    );
  }

  return (
    <div role="tree" aria-label={t("treeLabel")} className="py-1 text-sm">
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
        onClick={() => setOpen((value) => !value)}
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
  // Open down to storeys (project → site → building → storey). Storeys stay
  // collapsed because a single one can contain tens of thousands of elements.
  const t = useTranslations("viewer.spatialTree");
  const [open, setOpen] = useState(depth < 4);
  const select = useViewerStore((state) => state.select);
  const selection = useViewerStore((state) => state.selection);
  const refs = useMemo(() => subtreeRefs(node, modelId), [modelId, node]);
  const selectedKeys = useMemo(
    () => new Set(selection.map(refKey)),
    [selection],
  );
  const selectedCount = refs.reduce(
    (count, ref) => count + Number(selectedKeys.has(refKey(ref))),
    0,
  );
  const hasSelection = selectedCount > 0;
  const fullySelected = refs.length > 0 && selectedCount === refs.length;

  const hasChildren = node.children.length > 0 || node.elementIds.length > 0;
  // Reveal a single element picked in the viewport. A subtree selection can
  // contain thousands of refs, so it must not force every descendant open.
  const expanded = open || (selection.length === 1 && hasSelection);
  const label = node.name || `#${node.expressId}`;

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={hasSelection}
    >
      <div
        className={cn(
          "hover:bg-accent flex items-center gap-1",
          fullySelected && "bg-accent text-accent-foreground",
          hasSelection && !fullySelected && "bg-accent/50",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? t("collapse") : t("expand")}
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 p-0.5"
          >
            <Chevron open={expanded} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <button
          type="button"
          onClick={(event) => {
            if (event.shiftKey) {
              // Shift adds a subtree. If it is already fully selected, the
              // same gesture removes it as a group.
              select(refs, fullySelected ? "toggle" : "add");
            } else {
              select(refs, "replace");
            }
          }}
          className="min-w-0 flex-1 truncate py-1 text-left"
          title={label}
        >
          {label}
          {node.elevation !== undefined && (
            <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
              {node.elevation.toFixed(2)} m
            </span>
          )}
        </button>

        <VisibilityActions refs={refs} label={label} />
      </div>

      {expanded && (
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

/** A storey can hold tens of thousands of elements; the entity list handles that scale. */
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
  const select = useViewerStore((state) => state.select);
  const selection = useViewerStore((state) => state.selection);
  const selected = useMemo(() => new Set(selection.map(refKey)), [selection]);
  const shown = elementIds.slice(0, ELEMENT_CAP);

  return (
    <>
      {shown.map((expressId) => {
        const ref = { modelId, expressId };
        const key = refKey(ref);
        const isSelected = selected.has(key);
        const label = `#${expressId}`;

        return (
          <div
            key={expressId}
            role="treeitem"
            ref={(element) => {
              // Group selection highlights many rows. Scrolling is useful only
              // for a single element picked from the viewport.
              if (isSelected && selection.length === 1 && element) {
                element.scrollIntoView({ block: "nearest" });
              }
            }}
            aria-selected={isSelected}
            className={cn(
              "hover:bg-accent flex items-center gap-1 py-0.5 text-xs",
              isSelected && "bg-accent text-accent-foreground",
            )}
            style={{ paddingLeft: `${depth * 12 + 28}px` }}
          >
            <button
              type="button"
              onClick={(event) =>
                select([ref], event.shiftKey ? "toggle" : "replace")
              }
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <Layers className="text-muted-foreground h-3 w-3 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
            <VisibilityActions refs={[ref]} label={label} compact />
          </div>
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

function VisibilityActions({
  refs,
  label,
  compact = false,
}: {
  refs: EntityRef[];
  label: string;
  compact?: boolean;
}) {
  const t = useTranslations("viewer.spatialTree");
  const hidden = useViewerStore((state) => state.hidden);
  const isolated = useViewerStore((state) => state.isolated);
  const hide = useViewerStore((state) => state.hide);
  const show = useViewerStore((state) => state.show);
  const isolate = useViewerStore((state) => state.isolate);
  const clearIsolation = useViewerStore((state) => state.clearIsolation);
  const keys = refs.map(refKey);
  const hasHidden = keys.some((key) => hidden.has(key));
  const isIsolated =
    isolated !== null &&
    isolated.size === keys.length &&
    keys.every((key) => isolated.has(key));
  const buttonClass = cn(
    "hover:bg-background/80 shrink-0 rounded p-1",
    compact ? "h-5 w-5" : "h-6 w-6",
  );

  return (
    <span className="mr-1 flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        className={cn(buttonClass, hasHidden && "text-muted-foreground")}
        aria-label={t(hasHidden ? "show" : "hide", { name: label })}
        title={t(hasHidden ? "show" : "hide", { name: label })}
        onClick={() => (hasHidden ? show(refs) : hide(refs))}
      >
        {hasHidden ? (
          <EyeOff className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      <button
        type="button"
        className={cn(
          buttonClass,
          isIsolated && "bg-primary/15 text-primary",
        )}
        aria-label={t(isIsolated ? "clearIsolation" : "isolate", {
          name: label,
        })}
        title={t(isIsolated ? "clearIsolation" : "isolate", { name: label })}
        aria-pressed={isIsolated}
        onClick={() => (isIsolated ? clearIsolation() : isolate(refs))}
      >
        <Filter className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
  ) : (
    <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
  );
}

export default SpatialTree;
