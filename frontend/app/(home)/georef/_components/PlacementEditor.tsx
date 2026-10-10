"use client";

import { useState } from "react";
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
import VerticalDatumField from "./VerticalDatumField";

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
  const patchCrs = useGeorefStore((s) => s.patchCrs);
  const patchSite = useGeorefStore((s) => s.patchSite);
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
        {crs?.accuracy === "approximate" && (
          <p className="text-muted-foreground text-xs">{t("accuracyApproximate")}</p>
        )}
        {crs?.accuracy === "uncertain" && (
          <p className="text-warning text-xs">{t("accuracyUncertain")}</p>
        )}
        {outsideCrs && crs && (
          <p className="text-warning text-xs">
            {t("outsideCrsWarning", { crs: crs.label })}
          </p>
        )}
      </div>

      <fieldset className="space-y-2.5">
        <legend className="text-muted-foreground text-xs font-medium uppercase">
          {t("crsDetailsLegend")}
        </legend>

        <VerticalDatumField
          value={draft.crs?.verticalDatum ?? ""}
          onChange={(verticalDatum) => patchCrs({ verticalDatum })}
        />
        <TextField
          id="georef-geodetic-datum"
          label={t("geodeticDatum")}
          value={draft.crs?.geodeticDatum ?? ""}
          placeholder={crs?.geodeticDatum}
          onChange={(geodeticDatum) => patchCrs({ geodeticDatum })}
        />
        <TextField
          id="georef-map-projection"
          label={t("mapProjection")}
          value={draft.crs?.mapProjection ?? ""}
          onChange={(mapProjection) => patchCrs({ mapProjection })}
        />
        <TextField
          id="georef-map-zone"
          label={t("mapZone")}
          value={draft.crs?.mapZone ?? ""}
          onChange={(mapZone) => patchCrs({ mapZone })}
        />
      </fieldset>

      <fieldset className="space-y-2" data-site-location>
        <legend className="text-muted-foreground text-xs font-medium uppercase">
          {t("siteLegend")}
        </legend>
        <CoordinateField
          id="georef-site-latitude"
          label={t("siteLatitude")}
          value={draft.site?.latitude ?? null}
          limit={90}
          format={formatLatitude}
          invalidLabel={t("siteOutOfRange", { limit: 90 })}
          onChange={(latitude) => patchSite({ latitude })}
        />
        <CoordinateField
          id="georef-site-longitude"
          label={t("siteLongitude")}
          value={draft.site?.longitude ?? null}
          limit={180}
          format={formatLongitude}
          invalidLabel={t("siteOutOfRange", { limit: 180 })}
          onChange={(longitude) => patchSite({ longitude })}
        />
        <CoordinateField
          id="georef-site-elevation"
          label={t("siteElevation")}
          value={draft.site?.elevation ?? null}
          unit={lengthUnit(lengthUnitScale)}
          onChange={(elevation) => patchSite({ elevation })}
        />
        <p className="text-muted-foreground text-xs">{t("siteHint")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!originWgs}
          onClick={() =>
            originWgs &&
            patchSite({
              latitude: Math.round(originWgs.latitude * 1e8) / 1e8,
              longitude: Math.round(originWgs.longitude * 1e8) / 1e8,
            })
          }
        >
          {t("siteFromOrigin")}
        </Button>
      </fieldset>

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

function TextField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 text-xs"
      />
    </div>
  );
}

/**
 * A latitude or longitude in decimal degrees, which may be empty.
 *
 * Held as text while typing (so "-" and "4." survive), committed when it is a
 * number inside its limit, and spelled out in degrees–minutes–seconds under
 * the field — the form `IfcSite` stores it in.
 */
function CoordinateField({
  id,
  label,
  value,
  limit = Infinity,
  format,
  invalidLabel,
  unit = "°",
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  /** Largest magnitude accepted; none by default (an elevation). */
  limit?: number;
  /** Spelled out under the field; none for a plain number. */
  format?: (value: number) => string;
  invalidLabel?: string;
  unit?: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === null ? "" : String(value));
  const parsed = shown.trim() === "" ? null : Number(shown.replace(",", "."));
  const invalid = parsed !== null && (!Number.isFinite(parsed) || Math.abs(parsed) > limit);

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-2">
        <Label htmlFor={id} className="text-xs font-normal">
          {label}
        </Label>
        <div className="relative">
          <Input
            id={id}
            type="text"
            inputMode="decimal"
            value={shown}
            aria-invalid={invalid}
            onChange={(event) => {
              const raw = event.target.value;
              setText(raw);
              const next = raw.trim() === "" ? null : Number(raw.trim().replace(",", "."));
              if (next === null) onChange(null);
              else if (Number.isFinite(next) && Math.abs(next) <= limit) onChange(next);
            }}
            onBlur={() => setText(null)}
            className="h-8 pr-6 font-mono text-xs tabular-nums"
          />
          <span
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px]"
          >
            {unit}
          </span>
        </div>
      </div>
      {invalid ? (
        invalidLabel && <p className="text-warning text-[11px]">{invalidLabel}</p>
      ) : (
        value !== null &&
        format && (
          <p className="text-muted-foreground text-right font-mono text-[11px]">{format(value)}</p>
        )
      )}
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

/** The label for a length unit, when the file's unit is a common one. */
function lengthUnit(scale: number): string {
  if (scale === 1) return "m";
  if (scale === 0.001) return "mm";
  if (scale === 0.01) return "cm";
  return "";
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
