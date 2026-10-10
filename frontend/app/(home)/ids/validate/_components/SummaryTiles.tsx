"use client";

import { AlertTriangle, CheckCircle2, CircleSlash, Layers } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ValidationRun } from "@/lib/ids/report";

/**
 * The verdict, above everything else.
 *
 * A validation report is read for one thing first — did it pass — and burying
 * that under six equal-weight tiles makes every reader do arithmetic to find
 * out.
 */
export function SummaryTiles({ run }: { run: ValidationRun }) {
  const { summary } = run;
  const passed = summary.failed === 0;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium",
          passed
            ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "border-destructive/40 bg-destructive/10 text-destructive",
        )}
        role="status"
      >
        {passed ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden />
        ) : (
          <AlertTriangle className="h-4 w-4" aria-hidden />
        )}
        {passed
          ? "All specifications satisfied"
          : `${summary.failed} specification${summary.failed === 1 ? "" : "s"} not satisfied`}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="Passed"
          value={summary.passed}
          tone="pass"
          icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
        />
        <Tile
          label="Failed"
          value={summary.failed}
          tone={summary.failed > 0 ? "fail" : "neutral"}
          icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
        />
        <Tile
          label="Not applicable"
          value={summary.notApplicable}
          tone="neutral"
          icon={<CircleSlash className="h-3.5 w-3.5" aria-hidden />}
        />
        <Tile
          label="Failing elements"
          value={summary.failingEntities}
          tone={summary.failingEntities > 0 ? "fail" : "pass"}
          icon={<Layers className="h-3.5 w-3.5" aria-hidden />}
        />
        <Tile label="Checks" value={summary.totalChecks} tone="neutral" />
        <Tile
          label="Pass rate"
          value={`${summary.passRate.toFixed(1)}%`}
          tone={passed ? "pass" : "fail"}
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  tone: "pass" | "fail" | "neutral";
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <div
        className={cn(
          "flex items-center gap-1 text-lg font-semibold tabular-nums",
          tone === "pass" && "text-emerald-700 dark:text-emerald-400",
          tone === "fail" && "text-destructive",
        )}
      >
        {icon}
        {value}
      </div>
      <p className="text-muted-foreground mt-0.5 text-[11px]">{label}</p>
    </div>
  );
}

export default SummaryTiles;
