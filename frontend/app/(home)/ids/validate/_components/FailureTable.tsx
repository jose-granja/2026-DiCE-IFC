"use client";

import { useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Crosshair } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  describeFailure,
  type Failure,
  type ValidationRun,
} from "@/lib/ids/report";
import { useValidateStore } from "@/lib/ids/validate-store";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { cn } from "@/lib/utils";

/**
 * Every failing element, with the reason and a jump into the viewer.
 *
 * The jump is the point of building the validator inside the viewer rather than
 * as a separate tool: "expected Pset_WallCommon.FireRating, found none" is a
 * sentence, and the wall it is about is three storeys up in a model of forty
 * thousand elements.
 */
export function FailureTable({ run }: { run: ValidationRun }) {
  // `use no memo`: TanStack Virtual returns functions over a mutable instance
  // that the React Compiler cannot memoize safely. Same as the BCF topic list.
  "use no memo";

  const t = useTranslations("viewer.idsPanel.failureTable");
  const tFailure = useTranslations("idsFailureDescription");
  const focused = useValidateStore((s) => s.focusedSpecification);
  const focusedFailure = useValidateStore((s) => s.focusedFailure);
  const focusFailure = useValidateStore((s) => s.focusFailure);

  const failures = useMemo(() => {
    const source =
      focused === null
        ? run.specifications
        : run.specifications.filter((s) => s.index === focused);
    return source.flatMap((specification) => specification.failures);
  }, [run, focused]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: failures.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 10,
  });

  if (failures.length === 0) {
    return (
      <p className="text-muted-foreground rounded-md border p-6 text-center text-xs">
        {run.summary.failed === 0
          ? t("nothingFailed")
          : t("noFailuresForSpecification")}
      </p>
    );
  }

  return (
    <div className="rounded-md border max-h-[-webkit-fill-available] overflow-auto">
      <div
        className="text-muted-foreground border-b px-3 py-1.5 text-[11px]"
        role="status"
        aria-live="polite"
      >
        {t("failingElementCount", { count: failures.length })}
        {focused !== null && t("inThisSpecification")}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[-webkit-fill-available] overflow-auto"
      >
        <ul
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const failure = failures[item.index];

            return (
              <li
                key={failure.id}
                className="absolute top-0 left-0 w-full"
                style={{
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <div
                  className={cn(
                    "flex h-full items-start gap-2 border-b px-3 py-2",
                    focusedFailure === failure.id && "bg-accent",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {failure.name ?? `#${failure.expressId}`}
                      <Badge
                        variant="outline"
                        className="ml-1.5 h-4 px-1 text-[10px]"
                      >
                        {failure.type}
                      </Badge>
                    </p>
                    <p className="text-destructive truncate text-[11px]">
                      {describeFailure(failure, tFailure)}
                    </p>
                    <p className="text-muted-foreground truncate text-[10px]">
                      {failure.modelName}
                      {focused === null && ` · ${failure.specificationName}`}
                    </p>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => {
                      focusFailure(failure.id);
                      showInViewer(
                        failure,
                        t("modelNotLoaded", { name: failure.modelName }),
                      );
                    }}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                    {t("show")}
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

/**
 * Isolate and frame the failing element.
 *
 * No GlobalId lookup needed: the report carries `(modelId, expressId)`, which
 * is exactly the viewer's own selection key. Colouring it as well as isolating
 * it matters when a failure sits inside an assembly — isolation alone can leave
 * several elements on screen with no clue which one is the subject.
 */
function showInViewer(failure: Failure, notLoadedMessage: string) {
  const store = useViewerStore.getState();
  const model = store.models.find((m) => m.summary.id === failure.modelId);

  if (!model || model.load.status !== "ready") {
    toast.warning(notLoadedMessage);
    return;
  }

  const ref = { modelId: failure.modelId, expressId: failure.expressId };

  store.isolate([ref]);
  store.select([ref]);
  store.setColouring([{ ref, colour: "#d24b4b" }]);

  // The bounds only reflect the isolation once the renderer has drawn with it.
  // Not `federationBounds()` — that covers every visible model, which used to
  // fit the camera to the whole building instead of this one element.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const renderer = getActiveRenderer();
      renderer?.fitToBounds(renderer.boundsOfRefs([ref]));
    }),
  );
}

export default FailureTable;
