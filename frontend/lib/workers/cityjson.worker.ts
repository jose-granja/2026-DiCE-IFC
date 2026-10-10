/**
 * CityJSON clipping, off the UI thread.
 *
 * `parseCityJsonClipped` (`lib/georef/cityjson.ts`) is built to avoid
 * `JSON.parse`ing a whole national-cadastre-sized file, but it still has to
 * scan every character of it — tens of seconds for the file this was built
 * against (307 MB, ~275 000 buildings). Per AGENTS.md §7, anything that is
 * CPU-over-the-whole-document runs in a worker; the alternative is a frozen
 * tab for the length of the scan. `ContextModel` already has the file as text
 * (reading it is how the CityJSON/GeoJSON sniff works), so the string crosses
 * once rather than being decoded twice.
 */
import * as Comlink from "comlink";

import {
  parseCityJsonClipped,
  type CityJsonClipOptions,
  type CityJsonParseResult,
} from "@/lib/georef/cityjson";

export const cityJsonApi = {
  clip(text: string, options: CityJsonClipOptions): CityJsonParseResult {
    return parseCityJsonClipped(text, options);
  },
};

export type CityJsonWorkerApi = typeof cityJsonApi;

Comlink.expose(cityJsonApi);
