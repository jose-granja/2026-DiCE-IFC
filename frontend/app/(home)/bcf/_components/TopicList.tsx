"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarClock, MessageSquare, Camera, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { isClosed } from "@/lib/bcf/filter";
import { useBcfStore, useVisibleTopics } from "@/lib/bcf/store";
import type { BcfTopic } from "@/lib/bcf/types";
import { cn } from "@/lib/utils";
import { useNow } from "./useNow";

/**
 * The topic list.
 *
 * Virtualised: a coordination BCF from a weekly clash review runs to a few
 * thousand topics, and rendering them all makes filtering feel broken.
 */
export function TopicList({
  onOpenTopic,
  onEditTopic,
  openingGuid,
}: {
  onOpenTopic: (topic: BcfTopic) => void;
  onEditTopic: (topic: BcfTopic) => void;
  openingGuid: string | null;
}) {
  // `useVirtualizer` returns functions that read a mutable instance, so the
  // React Compiler cannot memoize this component safely — it says so itself
  // via react-hooks/incompatible-library. Opting this one component out is
  // TanStack Virtual's documented answer; memoizing it produces a list that
  // stops updating as you scroll. Scoped to this component deliberately.
  "use no memo";

  const t = useTranslations("viewer.bcfPanel");
  const topics = useVisibleTopics();
  const now = useNow();
  const total = useBcfStore((s) => s.file.topics.length);
  const selectedGuid = useBcfStore((s) => s.selectedGuid);
  const checked = useBcfStore((s) => s.checked);
  const toggleChecked = useBcfStore((s) => s.toggleChecked);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The "use no memo" directive above is what actually fixes this; the rule
  // reports the call site regardless, so it is silenced here rather than left
  // as standing noise that trains everyone to ignore lint output.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: topics.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
  });

  if (total === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t.rich("noTopics", { code: (chunks) => <code>{chunks}</code> })}
      </p>
    );
  }

  if (topics.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("noTopicsMatch")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-topic-list>
      <div
        className="text-muted-foreground border-b px-3 py-1.5 text-[11px]"
        role="status"
        aria-live="polite"
      >
        {topics.length === total
          ? t("topicCount", { count: total })
          : t("topicCountFiltered", { shown: topics.length, count: total })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <ul
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const topic = topics[item.index];

            return (
              <li
                key={topic.guid}
                className="absolute top-0 left-0 w-full"
                style={{
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <div
                  className={cn(
                    "flex h-full items-start gap-2 border-b px-2 py-2",
                    selectedGuid === topic.guid && "bg-accent",
                  )}
                >
                  <Checkbox
                    className="mt-1"
                    checked={checked.has(topic.guid)}
                    onCheckedChange={() => toggleChecked(topic.guid)}
                    aria-label={t("selectForBulkEdit", { title: topic.title })}
                  />

                  <button
                    type="button"
                    onClick={() => onOpenTopic(topic)}
                    disabled={openingGuid !== null}
                    className="min-w-0 flex-1 text-left"
                    aria-current={selectedGuid === topic.guid}
                  >
                    <p className="truncate text-xs font-medium">{topic.title}</p>

                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {topic.topicStatus && (
                        <Badge
                          variant={isClosed(topic) ? "secondary" : "default"}
                          className="h-4 px-1.5 text-[10px]"
                        >
                          {topic.topicStatus}
                        </Badge>
                      )}
                      {topic.priority && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          {topic.priority}
                        </Badge>
                      )}
                      <TopicMeta topic={topic} now={now} />
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="mt-0.5"
                    aria-label={t("editTopic", { title: topic.title })}
                    title={t("editTopic", { title: topic.title })}
                    onClick={() => onEditTopic(topic)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function TopicMeta({ topic, now }: { topic: BcfTopic; now: number }) {
  const t = useTranslations("viewer.bcfPanel");
  const overdue =
    topic.dueDate && !isClosed(topic) && Date.parse(topic.dueDate) < now;

  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
      {topic.comments.length > 0 && (
        <span className="flex items-center gap-0.5">
          <MessageSquare className="h-3 w-3" aria-hidden />
          <span className="sr-only">{t("comments")} </span>
          {topic.comments.length}
        </span>
      )}
      {topic.viewpoints.length > 0 && (
        <span className="flex items-center gap-0.5">
          <Camera className="h-3 w-3" aria-hidden />
          <span className="sr-only">{t("viewpoints")} </span>
          {topic.viewpoints.length}
        </span>
      )}
      {overdue && (
        <span className="text-destructive flex items-center gap-0.5">
          <CalendarClock className="h-3 w-3" aria-hidden />
          {t("overdue")}
        </span>
      )}
      {topic.assignedTo && <span className="truncate">{topic.assignedTo}</span>}
    </span>
  );
}

export default TopicList;
