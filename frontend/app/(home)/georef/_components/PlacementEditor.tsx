"use client";

import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";

import { findCrs, isWithinBounds } from "@/config/epsg";
import { useGeorefStore, hasChanges } from "@/lib/georef/store";
import {
  gridRotation,
  isSupportedCrs,
  localToWgs84,
  rotationFromDegrees,
} from "@/lib/georef/transform";
import { formatLatitude, formatLongitude } from "@/lib/georef/logeoref";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CrsPicker from "./CrsPicker";

/**
 * Edit the map conversion.
 *
 * Every field updates the draft immediately, so the map footprint moves as the
 * user types — georeferencing is a spatial task and the feedback loop has to be
 * spatial. Nothing here touches the model; the draft is written back only by
 * the export action.
 */
export function PlacementEditor({ lengthUnitScale }: { lengthUnitScale: number }) {
  const t = useTranslations("viewer.georefPanel.placementEditor");
  const draft = useGeorefStore((s) => s.draft);
  const original = useGeorefStore((s) => s.original);
  const patchConversion = useGeorefStore((s) => s.patchConversion);
  const setEpsg = useGeorefStore((s) => s.setEpsg);
  const revert = useGeorefStore((s) => s.revert);

  const dirty = hasChanges(original, draft);
  const crs = findCrs(draft?.epsg);

  const rotationDegrees = draft ? gridRotation(draft.conversion).degrees : 0;

  // Where the model origin lands, so a wrong CRS or a transposed easting is
  // visible as a coordinate rather than only as a dot in the wrong ocean.
  // Computed per render rather than memoised: it is one proj4 call, and the
  // React Compiler cannot preserve a useMemo wrapping a try/catch.
  const originWgs = projectOrigin(draft, lengthUnitScale);

  const outsideCrs =
    crs && originWgs
      ? !isWithinBounds(crs, originWgs.longitude, originWgs.latitude)
      : false;

  if (!draft) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {t("selectModel")}
      </p>
    );
  }

  const conversion = draft.conversion;

  return (
    <div className="space-y-4 p-3">
      <div className="space-y-1.5">
        <Label htmlFor="georef-crs">{t("crsLabel")}</Label>
        <CrsPicker
          id="georef-crs"
          value={draft.epsg}
          onChange={setEpsg}
        />
        {outsideCrs && crs && (
          <p className="text-warning text-xs">
            {t("outsideCrsWarning", { crs: crs.label })}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-xs font-medium uppercase">
          {t("originLegend")}
        </legend>

        <NumberField
          id="georef-eastings"
          label={t("eastings")}
          unit="m"
          value={conversion.eastings}
          onChange={(eastings) => patchConversion({ eastings })}
        />
        <NumberField
          id="georef-northings"
          label={t("northings")}
          unit="m"
          value={conversion.northings}
          onChange={(northings) => patchConversion({ northings })}
        />
        <NumberField
          id="georef-height"
          label={t("orthogonalHeight")}
          unit="m"
          value={conversion.orthogonalHeight}
          onChange={(orthogonalHeight) => patchConversion({ orthogonalHeight })}
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-xs font-medium uppercase">
          {t("orientationLegend")}
        </legend>

        <NumberField
          id="georef-rotation"
          label={t("gridRotation")}
          unit="°"
          value={rotationDegrees}
          onChange={(degrees) => patchConversion(rotationFromDegrees(degrees))}
        />
        <NumberField
          id="georef-scale"
          label={t("scale")}
          value={conversion.scale ?? 1}
          onChange={(scale) => patchConversion({ scale })}
        />
        <p className="text-muted-foreground text-xs">
          {t("scaleHint")}
        </p>
      </fieldset>

      {originWgs && (
        <div className="bg-muted/40 rounded border p-2 text-xs">
          <p className="text-muted-foreground">{t("originLandsAt")}</p>
          <p className="mt-0.5 font-mono">
            {formatLatitude(originWgs.latitude)}
            <br />
            {formatLongitude(originWgs.longitude)}
          </p>
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        disabled={!dirty}
        onClick={revert}
        className="w-full"
      >
        <RotateCcw className="h-4 w-4" />
        {t("revertToFile")}
      </Button>
    </div>
  );
}

/**
 * A labelled numeric field.
 *
 * The value is held as text while editing, so typing "-" or "1." does not
 * commit `NaN` and blank the field mid-keystroke.
 */
function NumberField({
  id,
  label,
  unit,
  value,
  onChange,
}: {
  id: string;
  label: string;
  unit?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-2">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={String(value)}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const parsed = Number(raw);
            if (raw !== "" && raw !== "-" && Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          className="h-8 pr-8 font-mono text-xs tabular-nums"
        />
        {unit && (
          <span
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px]"
          >
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

/** The model origin in WGS84, or null when the CRS or values make it undefined. */
function projectOrigin(
  draft: { epsg: number; conversion: Parameters<typeof gridRotation>[0] } | null,
  lengthUnitScale: number,
) {
  if (!draft || !isSupportedCrs(draft.epsg)) return null;
  try {
    return localToWgs84(
      { x: 0, y: 0, z: 0 },
      { conversion: draft.conversion, epsg: draft.epsg, lengthUnitScale },
    );
  } catch {
    // A wild coordinate can put proj4 outside its domain; an empty readout is
    // better than a crashed panel.
    return null;
  }
}

export default PlacementEditor;
