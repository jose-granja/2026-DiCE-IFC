/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { intersectAreaFeatures } from "@/lib/georef/area-check";

const api = { intersect: intersectAreaFeatures };
export type AreaCheckWorkerApi = typeof api;
Comlink.expose(api);
