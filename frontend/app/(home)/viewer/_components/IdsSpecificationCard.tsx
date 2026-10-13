"use client";

/**
 * One specification of a validation run, as a card that opens.
 *
 * Collapsed, it says how the specification went — status, how many elements it
 * applied to, how many passed and failed — so a run with forty specifications
 * reads as forty lines. Opened, it breaks that down the two ways a coordinator
 * needs, as ifclite.com does:
 *
 * - **By requirement.** Each requirement with its own pass/fail count, opening
 *   onto the elements that failed it — "FireRating is missing on 40 walls" is
 *   one thing to ask the author for, not forty.
 * - **By element.** Each failing element with every requirement it failed —
 *   "what is wrong with this wall".
 *
 * A specification that failed on its count alone ("there must be a column")
 * has no element to list, so the reason is shown as a row of its own.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, CheckCircle2, ChevronRight, Crosshair, MinusCircle, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  cardinalityFailure,
  describeRequirements,
  issueCount,
  type AggregatedSpecification,
  type Failure,
  type RequirementBreakdown,
} from "@/lib/ids/report";
import { useValidateStore } from "@/lib/ids/validate-store";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { cn } from "@/lib/utils";

type Status = "pass" | "fail" | "not_applicable";

function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const Icon = status === "pass" ? CheckCircle2 : status === "fail" ? XCircle : MinusCircle;
  return (
    <Icon
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 shrink-0",
        status === "pass" && "text-emerald-600 dark:text-emerald-400",
        status === "fail" && "text-destructive",
        status === "not_applicable" && "text-muted-foreground",
        className,
      )}
    />
  );
}

function PassRateBar({ passRate, applicable }: { passRate: number; applicable: boolean }) {
  return (
    <div className="bg-muted h-1 w-full overflow-hidden rounded-full" aria-hidden>
      {applicable && (
        <div
          className={cn("h-full", passRate >= 100 ? "bg-emerald-500" : "bg-destructive")}
          style={{ width: `${Math.max(0, Math.min(100, passRate))}%` }}
        />
      )}
    </div>
  );
}

export function IdsSpecificationCard({ specification }: { specification: AggregatedSpecification }) {
  const t = useTranslations("viewer.idsPanel.card");
  const [open, setOpen] = useState(false);
  const count = cardinalityFailure(specification);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn("rounded-lg border", open && "border-primary/50")}
        data-ids-specification={specification.name}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start gap-1.5 p-2 text-left"
            aria-label={`${specification.name} — ${t(`status.${specification.status}`)}`}
          >
            <ChevronRight
              aria-hidden
              className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-1.5">
                <StatusIcon status={specification.status} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{specification.name}</span>
                {specification.failedCount > 0 && (
                  <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[10px]">
                    {specification.failedCount}
                  </Badge>
                )}
                {specification.failedCount === 0 && count && (
                  <AlertTriangle className="text-destructive h-3 w-3 shrink-0" aria-label={t("countFailed")} />
                )}
              </div>
              {specification.description && (
                <p className="text-muted-foreground line-clamp-2 text-[11px]">{specification.description}</p>
              )}
              <p className="text-muted-foreground text-[11px]" data-ids-specification-counts>
                {t("elements", { count: specification.applicableCount })}
                {specification.applicableCount > 0 && (
                  <>
                    {" · "}
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {t("passed", { count: specification.passedCount })}
                    </span>
                    {" · "}
                    <span className={cn(specification.failedCount > 0 && "text-destructive")}>
                      {t("failed", { count: specification.failedCount })}
                    </span>
                  </>
                )}
              </p>
              <PassRateBar passRate={specification.passRate} applicable={specification.applicableCount > 0} />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-2 border-t p-2">
            {count && (
              <div className="flex items-start gap-2 rounded-md border px-2 py-1.5" data-failure-count-row>
                <AlertTriangle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{t("countFailureTitle")}</p>
                  <p className="text-destructive text-[11px] break-words">{count.message}</p>
                  <p className="text-muted-foreground truncate text-[10px]">{count.modelName}</p>
                </div>
              </div>
            )}

            {specification.requirements.length > 0 && (
              <section className="space-y-1">
                <h4 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                  {t("byRequirement")}
                </h4>
                <ul className="space-y-1">
                  {specification.requirements.map((requirement) => (
                    <RequirementRow
                      key={requirement.id}
                      requirement={requirement}
                      applicable={specification.applicableCount > 0}
                    />
                  ))}
                </ul>
              </section>
            )}

            {specification.failures.length > 0 && (
              <section className="space-y-1">
                <h4 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                  {t("byElement")}
                </h4>
                <p className="text-muted-foreground text-[11px]" role="status">
                  {t("failingElements", { count: specification.failures.length })}
                  {t("issues", { count: issueCount(specification.failures) })}
                </p>
                <ElementList failures={specification.failures} />
              </section>
            )}

            {specification.failures.length === 0 && !count && (
              <p className="text-muted-foreground text-[11px]">
                {specification.applicableCount === 0 ? t("nothingApplied") : t("allPassed")}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function RequirementRow({
  requirement,
  applicable,
}: {
  requirement: RequirementBreakdown;
  applicable: boolean;
}) {
  const t = useTranslations("viewer.idsPanel.card");
  const [open, setOpen] = useState(false);
  const status: Status = !applicable ? "not_applicable" : requirement.failedCount > 0 ? "fail" : "pass";
  const canOpen = requirement.failedCount > 0;

  return (
    <li className="rounded-md border" data-ids-requirement>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild disabled={!canOpen}>
          <button
            type="button"
            className={cn("flex w-full items-start gap-1.5 px-2 py-1.5 text-left", !canOpen && "cursor-default")}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "mt-0.5 h-3 w-3 shrink-0 transition-transform",
                open && "rotate-90",
                !canOpen && "invisible",
              )}
            />
            <StatusIcon status={status} className="mt-0.5 h-3 w-3" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] break-words" data-ids-requirement-label>
                {requirement.label}
                {requirement.optionality !== "required" && (
                  <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">
                    {t(`optionality.${requirement.optionality}`)}
                  </Badge>
                )}
              </p>
              {applicable && (
                <p className="text-muted-foreground text-[10px]" data-ids-requirement-counts>
                  {t("passed", { count: requirement.passedCount })}
                  {" · "}
                  <span className={cn(requirement.failedCount > 0 && "text-destructive")}>
                    {t("failed", { count: requirement.failedCount })}
                  </span>
                </p>
              )}
              {requirement.instructions && (
                <p className="text-muted-foreground mt-0.5 text-[10px] italic">{requirement.instructions}</p>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t p-1">
            <ElementList failures={requirement.failures} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * Failing elements, each with its reasons and a jump into the viewer.
 *
 * Virtualised inside a bounded height: a requirement can fail on thousands of
 * elements, and rendering every row would cost more than the validation did.
 * Rows are measured, since an element can list one reason or many.
 */
function ElementList({ failures }: { failures: Failure[] }) {
  // `use no memo`: TanStack Virtual returns functions over a mutable instance
  // that the React Compiler cannot memoize safely. Same as the BCF topic list.
  "use no memo";

  const t = useTranslations("viewer.idsPanel.failureTable");
  const tFailure = useTranslations("idsFailureDescription");
  const focusedFailure = useValidateStore((s) => s.focusedFailure);
  const focusFailure = useValidateStore((s) => s.focusFailure);
  const scrollRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: failures.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  return (
    <div ref={scrollRef} className="max-h-64 overflow-auto" data-failure-list>
      <ul className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const failure = failures[item.index];
          const reasons = describeRequirements(failure, tFailure);
          return (
            <li
              key={`${failure.id}:${item.index}`}
              ref={virtualizer.measureElement}
              data-index={item.index}
              data-failure-row
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <div
                className={cn(
                  "flex items-start gap-2 border-b px-2 py-1.5",
                  focusedFailure === failure.id && "bg-accent",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {failure.name ?? `#${failure.expressId}`}
                    <Badge variant="outline" className="ml-1.5 h-4 px-1 text-[10px]">
                      {failure.type}
                    </Badge>
                  </p>
                  <ul className="text-destructive mt-0.5 space-y-0.5 text-[11px]">
                    {reasons.map((reason, index) => (
                      <li key={index} className="break-words" data-failure-reason>
                        {reasons.length > 1 && "• "}
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground truncate text-[10px]">{failure.modelName}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => {
                    focusFailure(failure.id);
                    showInViewer(failure, t("modelNotLoaded", { name: failure.modelName }));
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

export default IdsSpecificationCard;
