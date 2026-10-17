/** OGC discovery and read-only requests. No request contains model contents. */
import { mapToWgs84, wgs84ToMap, type WgsPoint } from "./transform";
import { transformClipBox, type ClipBox } from "./vector-context";

export type OgcKind = "WFS" | "WMS";
export type OgcLayer = { name: string; title: string; crs: string[]; attribution: string; attributionUrl?: string };
export type OgcService = { kind: OgcKind; version: string; title: string; url: string; formats: string[]; layers: OgcLayer[] };
export class OgcError extends Error {
  constructor(readonly code: string) { super(code); }
}
const descendants = (node: Element, name: string) => [...node.getElementsByTagNameNS("*", name)];
const children = (node: Element, name: string) => [...node.children].filter((child) => child.localName === name);
const childText = (node: Element, name: string) => children(node, name)[0]?.textContent?.trim() ?? "";
const href = (node: Element | undefined) => node && [...node.attributes].find((a) => a.localName === "href")?.value;

export function ogcUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new OgcError("invalidUrl"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || value.length > 4096) throw new OgcError("invalidUrl");
  return url;
}

/** Ignore stale operation parameters on pasted GetMap/GetFeature links. */
export function requestUrl(endpoint: string, params: Record<string, string>): string {
  const url = ogcUrl(endpoint);
  const reserved = new Set(["service", "request", "version", "acceptversions", "layers", "styles", "crs", "srs", "bbox", "width", "height", "format", "transparent", "typenames", "typename", "srsname", "outputformat", "count", "maxfeatures", "startindex", "filter", "cql_filter", "resulttype", "featureid", "resourceid"]);
  for (const key of [...url.searchParams.keys()]) if (reserved.has(key.toLowerCase())) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

export function capabilitiesUrl(endpoint: string, kind: OgcKind): string {
  return requestUrl(endpoint, { SERVICE: kind, REQUEST: "GetCapabilities" });
}

export function readCapabilities(text: string, fallbackUrl?: string): OgcService | null {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (!root || document.querySelector("parsererror")) throw new OgcError("invalidXml");
  if (/ExceptionReport|ServiceExceptionReport/.test(root.localName)) throw new OgcError("serviceError");
  const kind = root.localName === "WFS_Capabilities" ? "WFS" : /^(WMS_Capabilities|WMT_MS_Capabilities)$/.test(root.localName) ? "WMS" : null;
  if (!kind) return null;
  const version = root.getAttribute("version") ?? (kind === "WMS" ? "1.3.0" : "2.0.0");
  if (!(kind === "WMS" ? ["1.1.1", "1.3.0"] : ["1.0.0", "1.1.0", "2.0.0", "2.0.2"]).includes(version)) throw new OgcError("unsupportedVersion");
  const operationName = kind === "WMS" ? "GetMap" : "GetFeature";
  const operation = descendants(root, "Operation").find((node) => node.getAttribute("name") === operationName)
    ?? descendants(root, operationName)[0];
  const get = operation && descendants(operation, "Get")[0];
  const endpoint = href(get) ?? (get && (href(descendants(get, "OnlineResource")[0]) ?? get.getAttribute("onlineResource"))) ?? fallbackUrl;
  if (!endpoint) throw new OgcError("missingEndpoint");
  let url: string;
  try { url = ogcUrl(new URL(endpoint, fallbackUrl).href).href; } catch { throw new OgcError("invalidUrl"); }
  const title = descendants(root, "ServiceIdentification")[0] ?? descendants(root, "Service")[0];
  const serviceTitle = title ? childText(title, "Title") : kind;
  const formats = operation ? kind === "WMS"
    ? descendants(operation, "Format").map((node) => node.textContent?.trim() ?? "")
    : descendants(operation, "Parameter").filter((node) => node.getAttribute("name") === "outputFormat").flatMap((node) => descendants(node, "Value").map((v) => v.textContent?.trim() ?? "")) : [];
  const layers: OgcLayer[] = [];
  if (kind === "WFS") {
    for (const node of descendants(root, "FeatureType")) {
      const name = childText(node, "Name");
      if (!name) continue;
      const crs = ["DefaultCRS", "OtherCRS", "DefaultSRS", "OtherSRS", "SRS"].flatMap((key) => children(node, key).map((c) => c.textContent?.trim() ?? ""));
      layers.push({ name, title: childText(node, "Title") || name, crs, attribution: serviceTitle });
    }
  } else {
    const visit = (node: Element, inherited: string[], credit: string, creditUrl?: string) => {
      const crs = [...new Set([...inherited, ...["CRS", "SRS"].flatMap((key) => children(node, key).flatMap((c) => (c.textContent ?? "").trim().split(/\s+/)))])];
      const attribution = children(node, "Attribution")[0];
      const text = attribution ? childText(attribution, "Title") || credit : credit;
      let attributionUrl = creditUrl;
      const resource = attribution && href(descendants(attribution, "OnlineResource")[0]);
      if (resource) {
        try { attributionUrl = ogcUrl(new URL(resource, url).href).href; } catch { /* Keep the text credit for an unusable link. */ }
      }
      const name = childText(node, "Name");
      if (name) layers.push({ name, title: childText(node, "Title") || name, crs, attribution: text, attributionUrl });
      for (const child of children(node, "Layer")) visit(child, crs, text, attributionUrl);
    };
    const capability = descendants(root, "Capability")[0];
    for (const layer of capability ? children(capability, "Layer") : []) visit(layer, [], serviceTitle);
  }
  if (!layers.length) throw new OgcError("noLayers");
  return { kind, version, title: serviceTitle || kind, url, formats, layers };
}

export function crsCode(crs: string): number | null {
  if (/CRS:?84$/i.test(crs)) return 4326;
  return /EPSG.*?(\d+)$/i.test(crs) ? Number(/(\d+)$/.exec(crs)![1]) : null;
}

export type OgcRequest = { url: string; crs: string; box: ClipBox; epsg: number; json: boolean };
export function layerRequest(service: OgcService, layer: OgcLayer, targetEpsg: number, reference: WgsPoint, radius: number): OgcRequest {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 100_000) throw new OgcError("invalidRadius");
  // These CRSs have known axis conventions. Avoid silently treating every EPSG
  // coordinate system as east/north (e.g. EPSG:3035 is north/east in WMS 1.3).
  const supported = [3763, 3857, 4326];
  const preferences = [...new Set([targetEpsg, 3857, 4326])].filter((code) => supported.includes(code));
  let crs = preferences.flatMap((code) => layer.crs.filter((c) => crsCode(c) === code))[0];
  if (!crs) throw new OgcError("unsupportedCrs");
  const jsonFormat = service.formats.find((f) => /^(application\/(geo\+)?json|json)$/i.test(f));
  const json = service.kind === "WFS" && Boolean(jsonFormat) && layer.crs.some((c) => crsCode(c) === 4326);
  // GeoJSON is always requested as longitude/latitude WGS84.
  if (json) crs = "EPSG:4326";
  const epsg = crsCode(crs)!;
  if (service.kind === "WMS" && !/CRS:?84$/i.test(crs)) crs = `EPSG:${epsg}`;
  const centre = wgs84ToMap(reference, targetEpsg);
  const targetBox = { minX: centre.easting-radius, minY: centre.northing-radius, maxX: centre.easting+radius, maxY: centre.northing+radius };
  const box = epsg === targetEpsg ? targetBox : transformClipBox(targetBox, ([x,y,z]) => {
    const wgs = mapToWgs84({ easting:x, northing:y }, targetEpsg);
    const p = wgs84ToMap(wgs, epsg); return [p.easting, p.northing, z];
  });
  const geographic = epsg === 4326 && !/CRS:?84$/i.test(crs);
  const swap = geographic && (service.kind === "WMS" ? service.version === "1.3.0" : service.version !== "1.0.0");
  // Use an unambiguous URI in WFS 1.1/2.0. GeoJSON keeps lon/lat coordinates,
  // but the BBOX CRS still follows the declared CRS axis order.
  const requestCrs = service.kind === "WFS" && service.version !== "1.0.0" && geographic ? "urn:ogc:def:crs:EPSG::4326" : crs;
  const bbox = (swap ? [box.minY,box.minX,box.maxY,box.maxX] : [box.minX,box.minY,box.maxX,box.maxY]).join(",");
  const params: Record<string,string> = { SERVICE:service.kind, VERSION:service.version, REQUEST:service.kind === "WMS" ? "GetMap" : "GetFeature", BBOX: bbox };
  if (service.kind === "WMS") {
    const format = service.formats.find((f) => f.toLowerCase() === "image/png") ?? service.formats.find((f) => f.toLowerCase() === "image/jpeg");
    if (!format) throw new OgcError("unsupportedImage");
    Object.assign(params, { LAYERS:layer.name, STYLES:"", FORMAT:format, TRANSPARENT:"TRUE", WIDTH:"1024", HEIGHT:"1024", [service.version === "1.3.0" ? "CRS" : "SRS"]:crs });
  } else {
    Object.assign(params, { [service.version.startsWith("2.") ? "TYPENAMES" : "TYPENAME"]:layer.name, SRSNAME:requestCrs,
      [service.version.startsWith("2.") ? "COUNT" : "MAXFEATURES"]:"10001", BBOX:`${bbox},${requestCrs}` });
    if (json) params.OUTPUTFORMAT = jsonFormat!;
  }
  return { url:requestUrl(service.url, params), crs:requestCrs, box, epsg, json };
}

export async function fetchOgc(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/ogc?url=${encodeURIComponent(ogcUrl(url).href)}`, { signal, cache:"no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new OgcError(typeof body?.error === "string" ? body.error : "serviceError");
  }
  return response.blob();
}
