"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

import type { GeoreferenceView } from "@/lib/ifc/types";
import { findVerticalCrs, useCrsIndex } from "@/lib/georef/crs-index";
import { describeLevel, gradeGeoreferencing, resolveEpsgCode, siteDisagreement } from "@/lib/georef/logeoref";
import { isSupportedCrs } from "@/lib/georef/transform";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LEVEL_TONE: Record<number, string> = {
  0: "border-destructive/40 text-destructive",
  20: "border-warning/40 text-warning",
  30: "border-warning/40 text-warning",
  40: "border-warning/40 text-warning",
  50: "border-success/40 text-success",
};

/**
 * The LoGeoRef report.
 *
 * Every check that is not a pass carries a remedy, because "IfcMapConversion:
 * fail" tells a modeller nothing they can act on. The level is shown as a
 * number *and* a sentence: LoGeoRef numbers are jargon outside the small group
 * of people who already know them.
 */
export function GeorefReportPanel({ view }: { view: GeoreferenceView }) {
  const t = useTranslations("viewer.georefPanel.reportPanel");
  const report = gradeGeoreferencing(view);
  const verticalDatum = view.projectedCRS?.verticalDatum?.trim() || undefined;
  // Projecting the map conversion needs the full EPSG index when the model's
  // CRS is not one of the curated systems.
  const declared = resolveEpsgCode(view.projectedCRS?.name);
  const needsIndex = declared !== null && !isSupportedCrs(declared);
  const ready = useCrsIndex(/^EPSG:\d{4,6}$/i.test(verticalDatum ?? "") || needsIndex);
  const disagreement = siteDisagreement(view);
  const verticalName = ready && verticalDatum ? findVerticalCrs(verticalDatum)?.name : undefined;

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 border-b p-3">
        <Badge
          variant="outline"
          className={cn("shrink-0 font-mono text-sm", LEVEL_TONE[report.level])}
        >
          {t("logeoref", { level: report.level })}
        </Badge>
        <div className="min-w-0">
          <p className="text-sm font-medium">{describeLevel(report.level)}</p>
          {!report.isMappable && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("notMappableHint")}
            </p>
          )}
        </div>
      </div>

      <ul className="divide-y">
        {report.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2.5 px-3 py-2.5">
            <StatusIcon status={check.status} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                {check.label}
                <span className="text-muted-foreground font-mono text-[11px]">
                  {t("logeoref", { level: check.level })}
                </span>
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">{check.detail}</p>
              {check.remedy && (
                <p className="text-muted-foreground mt-1 text-xs italic">
                  {check.remedy}
                </p>
              )}
            </div>
          </li>
        ))}
        <li
          className="flex items-start gap-2.5 px-3 py-2.5"
          data-vertical-datum-report
          data-filled={Boolean(verticalDatum)}
        >
          <StatusIcon status={verticalDatum ? "pass" : "warn"} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("verticalDatum")}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {verticalDatum
                ? verticalName
                  ? `${verticalDatum} — ${verticalName}`
                  : verticalDatum
                : t("verticalDatumNotSet")}
            </p>
          </div>
        </li>
        {disagreement && (
          <li className="flex items-start gap-2.5 px-3 py-2.5" data-site-disagreement>
            <StatusIcon status="warn" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("siteDisagreement")}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("siteDisagreementDetail", {
                  metres: Math.round(disagreement.metres),
                  direction: compass(disagreement.bearingDegrees),
                })}
              </p>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (degrees: number) => COMPASS[Math.round(degrees / 45) % 8];

function StatusIcon({ status }: { status: "pass" | "fail" | "warn" }) {
  const t = useTranslations("viewer.georefPanel.reportPanel");
  if (status === "pass") {
    return <CheckCircle2 className="text-success mt-0.5 h-4 w-4 shrink-0" aria-label={t("pass")} />;
  }
  if (status === "warn") {
    return <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-label={t("warning")} />;
  }
  return <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-label={t("fail")} />;
}

export default GeorefReportPanel;
