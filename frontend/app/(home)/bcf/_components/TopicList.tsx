"use client";

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarClock, MessageSquare, Camera } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
export function TopicList() {
  // `useVirtualizer` returns functions that read a mutable instance, so the
  // React Compiler cannot memoize this component safely — it says so itself
  // via react-hooks/incompatible-library. Opting this one component out is
  // TanStack Virtual's documented answer; memoizing it produces a list that
  // stops updating as you scroll. Scoped to this component deliberately.
  "use no memo";

  const topics = useVisibleTopics();
  const now = useNow();
  const total = useBcfStore((s) => s.file.topics.length);
  const selectedGuid = useBcfStore((s) => s.selectedGuid);
  const select = useBcfStore((s) => s.select);
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
        No topics yet. Import a <code>.bcf</code> file, or create a topic from a
        view in the viewer.
      </p>
    );
  }

  if (topics.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        No topics match the current filters.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="text-muted-foreground border-b px-3 py-1.5 text-[11px]"
        role="status"
        aria-live="polite"
      >
        {topics.length === total
          ? `${total} topic${total === 1 ? "" : "s"}`
          : `${topics.length} of ${total} topics`}
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
                    aria-label={`Select ${topic.title} for bulk editing`}
                  />

                  <button
                    type="button"
                    onClick={() => select(topic.guid)}
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
  const overdue =
    topic.dueDate && !isClosed(topic) && Date.parse(topic.dueDate) < now;

  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
      {topic.comments.length > 0 && (
        <span className="flex items-center gap-0.5">
          <MessageSquare className="h-3 w-3" aria-hidden />
          <span className="sr-only">Comments: </span>
          {topic.comments.length}
        </span>
      )}
      {topic.viewpoints.length > 0 && (
        <span className="flex items-center gap-0.5">
          <Camera className="h-3 w-3" aria-hidden />
          <span className="sr-only">Viewpoints: </span>
          {topic.viewpoints.length}
        </span>
      )}
      {overdue && (
        <span className="text-destructive flex items-center gap-0.5">
          <CalendarClock className="h-3 w-3" aria-hidden />
          Overdue
        </span>
      )}
      {topic.assignedTo && <span className="truncate">{topic.assignedTo}</span>}
    </span>
  );
}

export default TopicList;
