"use client";

import { useId } from "react";
import { Progress } from "@/components/ui/progress";

/** A named progress bar: omit percent while the amount of work is unknown. */
export default function LoadingProgress({
  label,
  detail,
  percent = null,
}: {
  label: string;
  detail?: string;
  percent?: number | null;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5 rounded-md bg-muted/40 p-2" aria-busy="true">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span id={id} className="min-w-0 truncate" title={label}>{label}</span>
        {percent !== null && <span className="shrink-0 tabular-nums">{percent}%</span>}
      </div>
      <Progress value={percent} aria-labelledby={id} className="h-1.5" />
      {detail && <p className="text-muted-foreground truncate text-[11px]" title={detail}>{detail}</p>}
    </div>
  );
}
