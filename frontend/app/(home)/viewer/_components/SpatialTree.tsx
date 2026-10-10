"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  Layers,
  Shapes,
} from "lucide-react";

import type { SpatialNodeView } from "@/lib/ifc/types";
import { subtreeRefs } from "@/lib/viewer/hierarchy";
import { getModelHandle } from "@/lib/viewer/loader";
import {
  refKey,
  useViewerStore,
  type EntityRef,
  type ViewerModel,
} from "@/lib/viewer/store";
import { Badge } from "@/components/ui/badge";
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

  // A storey's spatial children are almost always a flat run of `IfcSpace` —
  // one per room — which read as noise interleaved with the rare storey/zone
  // that also nests there. Grouped the same way `ElementList` groups
  // elements by class, just one level up: spaces are spatial nodes in their
  // own right (they can contain elements), not entries in `elementIds` — see
  // `getSpatialTree`'s own comment on why.
  const { spaces, otherChildren } = useMemo(() => {
    const spaces: SpatialNodeView[] = [];
    const otherChildren: SpatialNodeView[] = [];
    for (const child of node.children) {
      (child.type === "IfcSpace" ? spaces : otherChildren).push(child);
    }
    return { spaces, otherChildren };
  }, [node.children]);

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
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          title={label}
        >
          <span className="min-w-0 flex-1 truncate">
            {label}
            {node.elevation !== undefined && (
              <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                {node.elevation.toFixed(2)} m
              </span>
            )}
          </span>
          {/* Every spatial-structure class the engine reports — project, site,
              building, storey, space, spatial zone — not a hardcoded list, so
              a class this tree has never special-cased still gets a badge. */}
          {node.type && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[10px] font-normal"
            >
              {node.type}
            </Badge>
          )}
        </button>

        <VisibilityActions refs={refs} label={label} />
      </div>

      {expanded && (
        <div role="group">
          {otherChildren.map((child) => (
            <TreeNode
              key={child.expressId}
              node={child}
              modelId={modelId}
              depth={depth + 1}
            />
          ))}
          {spaces.length > 0 && (
            <SpaceGroup spaces={spaces} modelId={modelId} depth={depth + 1} />
          )}
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
 * A storey's `IfcSpace` children, collapsed into one group.
 *
 * Unlike an `ElementList` row, a space is a full `SpatialNodeView` — it can
 * contain its own elements (furniture, boundary members) — so each one stays
 * a real, independently expandable `TreeNode` rather than a flattened row.
 * Only the *listing* is grouped, not the node itself.
 */
function SpaceGroup({
  spaces,
  modelId,
  depth,
}: {
  spaces: SpatialNodeView[];
  modelId: string;
  depth: number;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-accent flex w-full items-center gap-1 py-1 text-left text-xs"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <Chevron open={open} />
        <Shapes className="text-muted-foreground h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">IfcSpace</span>
        <span className="text-muted-foreground mr-1 shrink-0 tabular-nums">
          {spaces.length}
        </span>
      </button>

      {open && (
        <div role="group">
          {spaces.map((space) => (
            <TreeNode
              key={space.expressId}
              node={space}
              modelId={modelId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single class group can hold tens of thousands of elements; capped per group, not per storey — a storey of 5000 walls and 3 doors used to bury the doors under the flat cap. */
const ELEMENT_CAP = 200;

/** Grouping key for an element `entityTypeByRef` has no entry for yet — still loading, or a class-less mesh. */
const UNKNOWN_CLASS = "";

/**
 * A storey's elements, grouped by IFC class.
 *
 * The class comes from `entityTypeByRef` — already populated from the loaded
 * geometry, so grouping is instant and needs no fetch. Names are a separate,
 * lazy fetch: only the rows actually shown (capped per group) are resolved,
 * keyed on the exact id list so switching groups open/closed re-triggers it
 * only when the shown set really changes.
 */
function ElementList({
  elementIds,
  modelId,
  depth,
}: {
  elementIds: number[];
  modelId: string;
  depth: number;
}) {
  const entityTypeByRef = useViewerStore((state) => state.entityTypeByRef);

  const groups = useMemo(() => {
    const byType = new Map<string, number[]>();
    for (const expressId of elementIds) {
      const type =
        entityTypeByRef.get(refKey({ modelId, expressId })) ?? UNKNOWN_CLASS;
      const list = byType.get(type);
      if (list) list.push(expressId);
      else byType.set(type, [expressId]);
    }
    return [...byType.entries()]
      .map(([type, ids]) => ({ type, ids, shown: ids.slice(0, ELEMENT_CAP) }))
      .sort((a, b) => b.ids.length - a.ids.length || a.type.localeCompare(b.type));
  }, [elementIds, entityTypeByRef, modelId]);

  const shownIds = useMemo(
    () => groups.flatMap((group) => group.shown),
    [groups],
  );

  // One fetch for every visible row across every group in this storey, rather
  // than one per group — a storey with forty classes should not cost forty
  // worker round trips for a panel the user has to scroll to see most of.
  const { data: entities } = useQuery({
    queryKey: ["spatial-tree-names", modelId, shownIds],
    enabled: shownIds.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const handle = getModelHandle(modelId);
      if (!handle) return [];
      return handle.getEntities({ expressIds: shownIds });
    },
  });
  const namesById = useMemo(() => {
    const map = new Map<number, string>();
    for (const entity of entities ?? []) map.set(entity.expressId, entity.name);
    return map;
  }, [entities]);

  // `entityTypeByRef` comes from geometry and has no entry for an element with
  // no representation (an `IfcWall` can legally have `Representation = $`) —
  // this properties fetch knows its class regardless, so feed it back into the
  // same cache `entityTypeByRef` already is. The group that element sits in
  // corrects itself on the next render instead of staying "Unspecified" forever.
  const registerEntityTypes = useViewerStore((state) => state.registerEntityTypes);
  useEffect(() => {
    if (entities && entities.length > 0) registerEntityTypes(modelId, entities);
  }, [entities, modelId, registerEntityTypes]);

  return (
    <>
      {groups.map((group) => (
        <ClassGroup
          key={group.type || UNKNOWN_CLASS}
          type={group.type}
          count={group.ids.length}
          shown={group.shown}
          namesById={namesById}
          modelId={modelId}
          depth={depth}
        />
      ))}
    </>
  );
}

function ClassGroup({
  type,
  count,
  shown,
  namesById,
  modelId,
  depth,
}: {
  type: string;
  count: number;
  shown: number[];
  namesById: Map<number, string>;
  modelId: string;
  depth: number;
}) {
  const t = useTranslations("viewer.spatialTree");
  const [open, setOpen] = useState(true);
  const label = type || t("unknownClass");

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-accent flex w-full items-center gap-1 py-1 text-left text-xs"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <Chevron open={open} />
        <Shapes className="text-muted-foreground h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="text-muted-foreground mr-1 shrink-0 tabular-nums">
          {count}
        </span>
      </button>

      {open && (
        <div role="group">
          {shown.map((expressId) => (
            <ElementRow
              key={expressId}
              expressId={expressId}
              modelId={modelId}
              type={type}
              name={namesById.get(expressId)}
              depth={depth + 1}
            />
          ))}
          {count > shown.length && (
            <p
              className="text-muted-foreground py-1 text-xs"
              style={{ paddingLeft: `${(depth + 1) * 12 + 28}px` }}
            >
              {t("moreElements", { count: count - shown.length })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ElementRow({
  expressId,
  modelId,
  type,
  name,
  depth,
}: {
  expressId: number;
  modelId: string;
  type: string;
  name: string | undefined;
  depth: number;
}) {
  const select = useViewerStore((state) => state.select);
  const selection = useViewerStore((state) => state.selection);
  const isSelected = useMemo(
    () => selection.some((ref) => ref.modelId === modelId && ref.expressId === expressId),
    [selection, modelId, expressId],
  );
  const ref = { modelId, expressId };
  // A name still loading reads as the express id, the same fallback the tree
  // always used — never a blank row while the fetch is in flight.
  const label = name || `#${expressId}`;

  return (
    <div
      role="treeitem"
      ref={(element) => {
        // Group selection highlights many rows. Scrolling is useful only for
        // a single element picked from the viewport.
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
        {type && (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[10px] font-normal"
          >
            {type}
          </Badge>
        )}
      </button>
      <VisibilityActions refs={[ref]} label={label} compact />
    </div>
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
        onClick={() =>
          isIsolated ? clearIsolation() : isolate(refs, "intersect")
        }
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
