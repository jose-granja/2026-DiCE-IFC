"use client";

/**
 * BCF topics that refer to whatever is selected in the viewport.
 *
 * Selecting an element and being told nothing about the issues raised against
 * it is the gap this closes: the whole point of holding the model and the
 * issues in one viewer is that a click can answer "has anyone complained about
 * this?".
 *
 * Matched on **IFC GlobalId**, not express id. Express ids are per-file and
 * change when a model is re-exported; the GlobalId is the identity BCF was
 * designed around, and is what makes a topic raised in another tool resolve
 * here at all.
 */

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getModelHandle } from "@/lib/viewer/loader";
import { useBcfStore } from "@/lib/bcf/store";
import { useViewerStore } from "@/lib/viewer/store";
import type { BcfTopic } from "@/lib/bcf/types";

export function RelatedTopics() {
  const t = useTranslations("viewer.relatedTopics");
  const selection = useViewerStore((s) => s.selection);
  const ref = selection[selection.length - 1] ?? null;

  const topics = useBcfStore((s) => s.file.topics);
  const select = useBcfStore((s) => s.select);
  const selectedTopic = useBcfStore((s) => s.selectedGuid);

  // The GlobalId of the selected element. Cheap, and cached per element.
  const { data: globalId } = useQuery({
    queryKey: ["element-guid", ref?.modelId ?? null, ref?.expressId ?? null],
    enabled: ref !== null,
    staleTime: Infinity,
    queryFn: async () => {
      const handle = getModelHandle(ref!.modelId);
      const entity = handle ? await handle.getEntity(ref!.expressId) : null;
      return entity?.globalId ?? null;
    },
  });

  if (!ref || !globalId) return null;

  const related = topics.filter((topic) => mentions(topic, globalId));
  if (related.length === 0) {
    return (
      <p className="text-muted-foreground border-b p-2 text-[11px]">
        {t("none")}
      </p>
    );
  }

  return (
    <section className="border-b p-2" data-related-topics>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <MessageSquare className="h-3.5 w-3.5" aria-hidden />
        {t("about")}
        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
          {related.length}
        </Badge>
      </p>
      <ul className="space-y-0.5">
        {related.map((topic) => (
          <li key={topic.guid}>
            <button
              type="button"
              onClick={() => select(topic.guid)}
              aria-current={topic.guid === selectedTopic ? "true" : undefined}
              className="hover:bg-accent w-full truncate rounded px-1.5 py-1 text-left text-[11px]"
              title={topic.title}
            >
              {topic.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Whether a topic points at this element.
 *
 * Every place BCF can name a component: the selection, the visibility
 * exceptions, and the colouring. A topic that only *colours* an element is
 * still about it — ignoring those would answer "no issues here" when there are.
 */
function mentions(topic: BcfTopic, globalId: string): boolean {
  return topic.viewpoints.some((viewpoint) => {
    const components = viewpoint.components;
    if (!components) return false;

    if (components.selection.some((entry) => entry.ifcGuid === globalId)) return true;
    if (components.exceptions.some((entry) => entry.ifcGuid === globalId)) return true;
    return components.coloring.some((colour) =>
      colour.components.some((entry) => entry.ifcGuid === globalId),
    );
  });
}

export default RelatedTopics;
