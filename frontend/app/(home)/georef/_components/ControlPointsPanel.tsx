"use client";

import { useTranslations } from "next-intl";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";

import {
  fitControlPoints,
  toMapConversion,
  type ControlPoint,
} from "@/lib/georef/fit";
import { useGeorefStore, nextControlPointId } from "@/lib/georef/store";
import { formatLength } from "@/lib/viewer/tools";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Fit the placement from surveyed control points.
 *
 * Points are in metres on both sides — model coordinates converted from project
 * units by the caller, map coordinates as the surveyor supplied them.
 *
 * Locks matter more than they look: a surveyor who knows the grid scale is
 * exactly 1 does not want the solver absorbing their measurement error into a
 * scale factor of 1.0004 and reporting a suspiciously perfect fit.
 */
export function ControlPointsPanel({
  lengthUnitScale,
}: {
  lengthUnitScale: number;
}) {
  const t = useTranslations("viewer.georefPanel.controlPoints");
  const points = useGeorefStore((s) => s.controlPoints);
  const locks = useGeorefStore((s) => s.locks);
  const fit = useGeorefStore((s) => s.fit);
  const fitError = useGeorefStore((s) => s.fitError);
  const addControlPoint = useGeorefStore((s) => s.addControlPoint);
  const updateControlPoint = useGeorefStore((s) => s.updateControlPoint);
  const removeControlPoint = useGeorefStore((s) => s.removeControlPoint);
  const clearControlPoints = useGeorefStore((s) => s.clearControlPoints);
  const setLocks = useGeorefStore((s) => s.setLocks);
  const setFit = useGeorefStore((s) => s.setFit);
  const patchConversion = useGeorefStore((s) => s.patchConversion);

  const residualById = new Map(fit?.residuals.map((r) => [r.id, r]) ?? []);

  const onFit = () => {
    try {
      const result = fitControlPoints(points, locks);
      setFit(result);
      // Applying is deliberate and immediate: a fit the user cannot see on the
      // map is not something they can judge.
      patchConversion(toMapConversion(result.parameters));
      toast.success(
        t("fittedFrom", { count: points.length, rmse: formatLength(result.rmse) }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("fitDidNotConverge");
      setFit(null, message);
      toast.error(message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            addControlPoint({
              id: nextControlPointId(),
              local: { x: 0, y: 0, z: 0 },
              map: { easting: 0, northing: 0, height: 0 },
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addPoint")}
        </Button>
        <Button
          size="sm"
          disabled={points.length < 2}
          onClick={onFit}
          title={
            points.length < 2
              ? t("fitPlacementHint")
              : undefined
          }
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("fitPlacement")}
        </Button>
        {points.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearControlPoints}>
            {t("clear")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-b px-3 py-2">
        <LockToggle
          id="lock-scale"
          label={t("lockScale")}
          checked={locks.scale !== undefined}
          onChange={(on) => setLocks({ ...locks, scale: on ? 1 : undefined })}
        />
        <LockToggle
          id="lock-rotation"
          label={t("lockRotation")}
          checked={locks.rotation !== undefined}
          onChange={(on) => setLocks({ ...locks, rotation: on ? 0 : undefined })}
        />
      </div>

      {fitError && (
        <p className="text-destructive border-b px-3 py-2 text-xs">{fitError}</p>
      )}

      {fit && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-b px-3 py-2 text-xs">
          <dt className="text-muted-foreground">{t("rmse")}</dt>
          <dd className="text-right font-mono tabular-nums">
            {formatLength(fit.rmse)}
          </dd>
          <dt className="text-muted-foreground">{t("worstPoint")}</dt>
          <dd className="text-right font-mono tabular-nums">
            {formatLength(fit.maxResidual)}
          </dd>
          <dt className="text-muted-foreground">{t("rotation")}</dt>
          <dd className="text-right font-mono tabular-nums">
            {fit.parameters.rotationDegrees.toFixed(4)}°
          </dd>
          <dt className="text-muted-foreground">{t("scale")}</dt>
          <dd className="text-right font-mono tabular-nums">
            {fit.parameters.scale.toFixed(8)}
          </dd>
        </dl>
      )}

      {points.length === 0 ? (
        <p className="text-muted-foreground p-3 text-xs">
          {t("noneYet")}
        </p>
      ) : (
        <ul className="divide-y overflow-auto">
          {points.map((point, index) => {
            const residual = residualById.get(point.id);
            return (
              <li key={point.id} className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{t("pointLabel", { index: index + 1 })}</p>
                  <div className="flex items-center gap-2">
                    {residual && (
                      <span
                        className={cn(
                          "font-mono text-[11px] tabular-nums",
                          residual.horizontal > 0.1
                            ? "text-warning"
                            : "text-muted-foreground",
                        )}
                        title={t("horizontalResidual")}
                      >
                        {formatLength(residual.horizontal)}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("removePoint", { index: index + 1 })}
                      onClick={() => removeControlPoint(point.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <PointRow
                  legend={t("modelLegend", { scale: lengthUnitScale })}
                  fields={[
                    { key: "x", label: "X", value: point.local.x },
                    { key: "y", label: "Y", value: point.local.y },
                    { key: "z", label: "Z", value: point.local.z ?? 0 },
                  ]}
                  onChange={(key, value) =>
                    updateControlPoint(point.id, {
                      local: { ...point.local, [key]: value } as ControlPoint["local"],
                    })
                  }
                />

                <PointRow
                  legend={t("surveyedLegend")}
                  fields={[
                    { key: "easting", label: "E", value: point.map.easting },
                    { key: "northing", label: "N", value: point.map.northing },
                    { key: "height", label: "H", value: point.map.height ?? 0 },
                  ]}
                  onChange={(key, value) =>
                    updateControlPoint(point.id, {
                      map: { ...point.map, [key]: value } as ControlPoint["map"],
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LockToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations("viewer.georefPanel.controlPoints");
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor={id} className="cursor-pointer text-xs font-normal">
        {t("lockPrefix", { label })}
      </Label>
    </div>
  );
}

function PointRow({
  legend,
  fields,
  onChange,
}: {
  legend: string;
  fields: Array<{ key: string; label: string; value: number }>;
  onChange: (key: string, value: number) => void;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-[11px]">{legend}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {fields.map((field) => (
          <div key={field.key} className="relative">
            <span
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px]"
            >
              {field.label}
            </span>
            <Input
              aria-label={`${legend} ${field.label}`}
              type="text"
              inputMode="decimal"
              value={String(field.value)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = Number(raw);
                if (raw !== "" && raw !== "-" && Number.isFinite(parsed)) {
                  onChange(field.key, parsed);
                }
              }}
              className="h-8 pl-6 font-mono text-xs tabular-nums"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default ControlPointsPanel;
