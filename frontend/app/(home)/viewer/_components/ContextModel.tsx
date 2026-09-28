"use client";

/**
 * Load a geospatial file as surrounding context.
 *
 * A basemap answers "is the building in the right place". It does not answer
 * "is it the right height beside its neighbours" — that needs the neighbours,
 * in 3D. This reads a CityJSON file the user already has (many municipalities
 * publish them) and places it in the same scene as the model.
 *
 * The context is **not a model**. It is not in the model list, not in the
 * spatial tree, not validated against an IDS, and not part of the federation
 * bounds — putting someone else's city into the user's validation results would
 * be worse than not having it at all. `renderer.setContextGeometry` is separate
 * from `setModelGeometry` for exactly that reason.
 *
 * Parsed in the tab, like every other file here. It is never uploaded.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Boxes, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { parseCityJson, sniffJsonType } from "@/lib/georef/cityjson";
import { parseGeoJson } from "@/lib/georef/geojson";
import { parseCityGml } from "@/lib/georef/citygml";
import { parseGeoPackage } from "@/lib/georef/geopackage";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import { mapToLocal, type Placement, type WgsPoint } from "@/lib/georef/transform";
import { clipCityJson } from "@/lib/workers/cityjson-client";
import { clipLargeGml } from "@/lib/workers/gml-client";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import type { Vec3 } from "@/lib/ifc/types";

const DEFAULT_CLIP_RADIUS_METRES = 100;
const LARGE_TEXT_FILE_BYTES = 64 * 1024 * 1024;

export function ContextModel({
  placement,
  referencePoint,
  originShift,
  modelOffset,
}: {
  /** The model's map conversion, for putting the city in the same frame. */
  placement: Placement | null;
  /** Where the model sits on the earth — the centre a clip radius is drawn around. */
  referencePoint: WgsPoint | null;
  originShift: Vec3;
  modelOffset: Vec3;
}) {
  const t = useTranslations("viewer.contextModel");
  /**
   * GeoJSON and GeoPackage need to know what to project into, and that comes
   * from the model's own map conversion. GML declares its source CRS and can
   * therefore still be displayed at the local origin when the IFC has none.
   */
  const NEEDS_PLACEMENT = t("needsPlacement");

  const input = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<ContextGeometry | null>(null);
  const [visible, setVisible] = useState(true);
  const [clipEnabled, setClipEnabled] = useState(true);
  const [clipRadius, setClipRadius] = useState(String(DEFAULT_CLIP_RADIUS_METRES));

  const canClip = Boolean(placement && referencePoint);
  const radiusMetres = Number(clipRadius);
  const radiusValid = Number.isFinite(radiusMetres) && radiusMetres > 0;

  const place = (result: ContextGeometry | null, show: boolean) => {
    const renderer = getActiveRenderer();
    if (!renderer) return;

    if (!result || !show) {
      renderer.setContextGeometry(null);
      return;
    }

    // Where the city's local origin sits in the model's own frame. Without the
    // placement there is nothing to align to, so it goes down at the origin and
    // the message below says so.
    let offset: Vec3 = [0, 0, 0];
    if (placement) {
      const local = mapToLocal(
        { easting: result.origin.easting, northing: result.origin.northing },
        placement,
      );
      offset = [
        local.x - originShift[0] + modelOffset[0],
        // Heights are both orthogonal in the map frame, so the model's own
        // datum height is what the city's height is measured against.
        result.origin.height -
          placement.conversion.orthogonalHeight -
          originShift[1] +
          modelOffset[1],
        -(local.y - originShift[2]) + modelOffset[2],
      ];
    }

    renderer.setContextGeometry(
      { positions: result.positions, colours: result.colours },
      offset,
    );
  };

  /**
   * Pick a reader from the file's own contents, not its extension.
   *
   * Both formats are `.json` as often as not — CityJSON's own convention is
   * `.city.json`, and half the GeoJSON published by municipalities is plain
   * `.json`. The `type` member is the thing that actually distinguishes them,
   * and it costs one parse to read.
   */
  const read = async (
    file: File,
    epsg: number | null,
  ): Promise<ContextGeometry> => {
    /*
      Sniff the bytes, not the extension.

      A GeoPackage is a SQLite database and says so in its first 15 bytes; the
      text formats are told apart by their first non-space character and, for
      the two JSON ones, by their `type` member. Extensions decide nothing here
      — CityJSON and GeoJSON are both `.json` as often as not, and `.xml` could
      be either GML or something else entirely.
    */
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (new TextDecoder().decode(head.subarray(0, 15)) === "SQLite format 3") {
      if (epsg === null) throw new Error(NEEDS_PLACEMENT);
      return parseGeoPackage(new Uint8Array(await file.arrayBuffer()), epsg);
    }

    // Detect XML from a small prefix. A national CityGML delivery can be
    // several gigabytes, which is larger than the browser's maximum string;
    // calling `File.text()` before this decision is what produced the false
    // “neither JSON nor XML” message.
    const prefix = await file.slice(0, 64 * 1024).text();
    if (prefix.trimStart().startsWith("<")) {
      if (file.size > LARGE_TEXT_FILE_BYTES) {
        if (
          epsg === null ||
          !clipEnabled ||
          !referencePoint ||
          !radiusValid
        ) {
          throw new Error(t("largeGmlNeedsClip"));
        }
        setProgress(0);
        return clipLargeGml(
          file,
          {
            targetEpsg: epsg,
            reference: referencePoint,
            radiusMetres,
          },
          setProgress,
        );
      }
      return parseCityGml(await file.text(), epsg);
    }

    const text = await file.text();
    return readText(text, file.name, epsg);
  };

  const readText = async (
    text: string,
    name: string,
    epsg: number | null,
  ): Promise<ContextGeometry> => {
    // XML formats first: they are unambiguous from the first non-space
    // character, and trying to sniff a CityGML file as JSON only to report
    // "neither JSON nor XML" would name the wrong problem.
    if (text.trimStart().startsWith("<")) {
      return parseCityGml(text, epsg);
    }

    // A cheap top-level scan rather than `JSON.parse(text).type`: the whole
    // point of clipping is to avoid paying full-parse cost on a file that
    // can be hundreds of megabytes, and sniffing the format is no exception.
    const kind = sniffJsonType(text);
    if (kind === undefined) {
      throw new Error(t("neitherJsonNorXml", { name }));
    }

    if (kind === "CityJSON") {
      if (clipEnabled && canClip && radiusValid) {
        return clipCityJson(text, {
          referenceLongitude: referencePoint!.longitude,
          referenceLatitude: referencePoint!.latitude,
          radiusMetres,
          targetEpsg: epsg!,
        });
      }
      return parseCityJson(text);
    }

    // GeoJSON is longitude/latitude; it can only be placed once we know what to
    // project it into, and that comes from the model's own placement.
    if (epsg === null) throw new Error(NEEDS_PLACEMENT);
    return parseGeoJson(text, epsg);
  };

  const onFile = async (file: File) => {
    setLoading(true);
    try {
      const result = await read(file, placement?.epsg ?? null);
      setLoaded(result);
      setVisible(true);
      place(result, true);

      const summary = result.types
        .slice(0, 3)
        .map((entry) => `${entry.count} ${entry.type}`)
        .join(", ");
      toast.success(t("loaded", { count: result.objectCount, summary }));

      if (placement && result.epsg && placement.epsg && result.epsg !== placement.epsg) {
        // Not fatal: the coordinates may still be close enough to be useful,
        // and saying nothing would leave a plausible-looking misplacement.
        toast.warning(
          t("crsMismatch", { resultEpsg: result.epsg, placementEpsg: placement.epsg }),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("readFailed"),
      );
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const clear = () => {
    setLoaded(null);
    place(null, false);
    if (input.current) input.current.value = "";
  };

  return (
    <div className="space-y-2 border-b p-2">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="georef-context"
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <Boxes className="h-3.5 w-3.5" aria-hidden />
          {t("title")}
          {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {loading && progress !== null && (
            <span className="text-muted-foreground font-normal tabular-nums">
              {t("readingProgress", { percent: progress })}
            </span>
          )}
        </Label>

        {loaded ? (
          <div className="flex items-center gap-1">
            <Switch
              id="georef-context"
              checked={visible}
              onCheckedChange={(on) => {
                setVisible(on);
                place(loaded, on);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={clear}
              aria-label={t("remove")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            onClick={() => input.current?.click()}
            disabled={loading}
          >
            {t("loadContext")}
          </Button>
        )}
      </div>

      <input
        ref={input}
        data-context-file-input
        type="file"
        accept=".json,.city.json,.cityjson,.geojson,.gml,.xml,.citygml,.gpkg,application/json,application/geo+json,application/gml+xml,text/xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
        }}
      />

      {!loaded && canClip && (
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor="georef-context-clip"
            className="text-muted-foreground text-[11px]"
          >
            {t("clipToModel")}
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              step={1}
              value={clipRadius}
              onChange={(event) => setClipRadius(event.target.value)}
              disabled={!clipEnabled}
              aria-label={t("clipRadiusLabel")}
              className="h-6 w-16 text-[11px]"
            />
            <span className="text-muted-foreground text-[11px]">m</span>
            <Switch
              id="georef-context-clip"
              checked={clipEnabled}
              onCheckedChange={setClipEnabled}
            />
          </div>
        </div>
      )}

      {loaded ? (
        <p className="text-muted-foreground text-[11px]">
          {t("summary", {
            count: loaded.objectCount,
            metres: Math.round(loaded.sizeMetres),
            crs: loaded.epsg ? t("summaryCrs", { epsg: loaded.epsg }) : t("summaryNoCrs"),
          })}
          {!placement && ` ${t("noPlacementNote")}`}
        </p>
      ) : (
        <p className="text-muted-foreground text-[11px]">
          {t("formatsHint")}
          {!canClip && ` ${t("clipHint")}`}
        </p>
      )}
    </div>
  );
}

export default ContextModel;
