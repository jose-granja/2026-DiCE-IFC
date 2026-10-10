"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { useIdsStore } from "@/lib/ids/store";
import type { Specification } from "@/lib/ids/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The specification list — reorderable, because IDS documents are read top to
 * bottom by whoever receives them and the order carries meaning.
 *
 * dnd-kit's keyboard sensor is wired up, so reordering works without a pointer:
 * focus a handle, space to lift, arrows to move, space to drop.
 */
export function SpecificationList() {
  const t = useTranslations("idsCreate.specList");
  const specifications = useIdsStore((s) => s.document.specifications);
  const selectedId = useIdsStore((s) => s.selectedId);
  const select = useIdsStore((s) => s.select);
  const addSpecification = useIdsStore((s) => s.addSpecification);
  const reorder = useIdsStore((s) => s.reorderSpecifications);

  const sensors = useSensors(
    // A small activation distance keeps a click from being read as a 1-pixel
    // drag, which otherwise makes the list feel like it swallows clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorder(String(active.id), String(over.id));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={addSpecification}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addSpecification")}
        </Button>
      </div>

      {specifications.length === 0 ? (
        <p className="text-muted-foreground p-3 text-xs">
          {t("noneYet")}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={specifications.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex-1 overflow-auto">
              {specifications.map((specification, index) => (
                <SpecificationRow
                  key={specification.id}
                  specification={specification}
                  index={index}
                  selected={specification.id === selectedId}
                  onSelect={() => select(specification.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SpecificationRow({
  specification,
  index,
  selected,
  onSelect,
}: {
  specification: Specification;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("idsCreate.specList");
  const remove = useIdsStore((s) => s.removeSpecification);
  const duplicate = useIdsStore((s) => s.duplicateSpecification);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: specification.id });

  const requirementCount = specification.requirements.length;
  const applicabilityCount = specification.applicability.facets.length;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-start gap-1 border-b px-1.5 py-2",
        selected && "bg-accent",
        isDragging && "opacity-60",
      )}
    >
      <button
        type="button"
        aria-label={t("reorder", { name: specification.name })}
        className="text-muted-foreground mt-0.5 cursor-grab touch-none p-0.5"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate text-sm font-medium">
          {specification.name || t("unnamedSpecification", { index: index + 1 })}
        </p>
        <p className="text-muted-foreground text-[11px]">
          {applicabilityCount === 0
            ? t("allEntities")
            : t("applicabilityCount", { count: applicabilityCount })}
          {" · "}
          {t("requirementCount", { count: requirementCount })}
          {" · "}
          {specification.ifcVersions.join(", ")}
        </p>
      </button>

      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("duplicate", { name: specification.name })}
          onClick={() => duplicate(specification.id)}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("delete", { name: specification.name })}
          onClick={() => remove(specification.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

export default SpecificationList;
