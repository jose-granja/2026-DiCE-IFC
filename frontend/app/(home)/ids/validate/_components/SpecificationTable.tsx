"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useValidateStore } from "@/lib/ids/validate-store";
import type { ValidationRun } from "@/lib/ids/report";
import { cn } from "@/lib/utils";

/**
 * One row per specification; clicking one filters the failure table below.
 *
 * Not an accordion holding the failures inline: a specification with 4,000
 * failures inside a collapsible makes the page scroll unusably, and the failure
 * list needs its own virtualisation and its own click-through to the viewer.
 */
export function SpecificationTable({ run }: { run: ValidationRun }) {
  const focused = useValidateStore((s) => s.focusedSpecification);
  const focus = useValidateStore((s) => s.focusSpecification);

  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-xs">
        <caption className="sr-only">
          Specifications, with the number of applicable, passing and failing elements
        </caption>
        <thead className="bg-muted/50">
          <tr>
            <th scope="col" className="w-6" />
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Specification
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Status
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Applicable
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Passed
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Failed
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Pass rate
            </th>
          </tr>
        </thead>
        <tbody>
          {run.specifications.map((specification) => {
            const open = focused === specification.index;
            const clickable = specification.failures.length > 0;

            return (
              <tr
                key={specification.index}
                className={cn("border-t", open && "bg-accent")}
              >
                <td className="pl-1">
                  {clickable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => focus(open ? null : specification.index)}
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} failures for ${specification.name}`}
                    >
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-medium">{specification.name}</span>
                  {specification.cardinality &&
                    !specification.cardinality.passed && (
                      <span className="text-destructive block text-[11px]">
                        {specification.cardinality.message}
                      </span>
                    )}
                </td>
                <td className="px-2 py-1.5">
                  <StatusBadge status={specification.status} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {specification.applicableCount}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {specification.passedCount}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-right tabular-nums",
                    specification.failedCount > 0 && "text-destructive font-medium",
                  )}
                >
                  {specification.failedCount}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {specification.applicableCount === 0
                    ? "—"
                    : `${specification.passRate.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: "pass" | "fail" | "not_applicable" }) {
  if (status === "pass") {
    return (
      <Badge className="h-4 bg-emerald-600 px-1.5 text-[10px] hover:bg-emerald-600">
        Pass
      </Badge>
    );
  }
  if (status === "fail") {
    return (
      <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
        Fail
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
      N/A
    </Badge>
  );
}

export default SpecificationTable;
