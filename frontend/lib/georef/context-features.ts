import { z } from "zod";
import { parseCityGml } from "./citygml";
import { parseGeoJson } from "./geojson";
import { OgcError } from "./ogc-service";

const schema = z.object({
  type:z.literal("DiCEContextFeatures"),version:z.literal(1),
  name:z.string(), attribution:z.string(), crs:z.string(), body:z.string(),
});
export type FeatureSnapshot = z.infer<typeof schema>;

/** Refuse incomplete service responses rather than showing a silently partial layer. */
export function checkFeatureResponse(text: string) {
  let matched: number, returned: number;
  if (text.trimStart().startsWith("{")) {
    const data = JSON.parse(text);
    if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new OgcError("serviceError");
    matched=Number(data.numberMatched ?? data.totalFeatures); returned=data.features.length;
  } else {
    const document = new DOMParser().parseFromString(text,"application/xml");
    const root=document.documentElement;
    if (document.querySelector("parsererror") || root.localName !== "FeatureCollection") throw new OgcError("serviceError");
    matched=Number(root.getAttribute("numberMatched") ?? "unknown");
    returned=Number(root.getAttribute("numberReturned") ?? root.getAttribute("numberOfFeatures") ?? [...root.children].reduce((sum,c) => sum + (c.localName === "featureMembers" ? c.children.length : /^(member|featureMember)$/.test(c.localName) ? 1 : 0),0));
    if (root.hasAttribute("next")) throw new OgcError("tooManyFeatures");
  }
  if (returned >= 10001 || (Number.isFinite(matched) && matched>returned)) throw new OgcError("tooManyFeatures");
  if (returned === 0) throw new OgcError("noFeatures");
}

export function featureSnapshotFile(snapshot: FeatureSnapshot): File {
  return new File([JSON.stringify(schema.parse(snapshot))],`${snapshot.name.replace(/[^\p{L}\p{N}._-]/gu,"_")}.context-features`,{type:"application/json"});
}

export function readFeatureSnapshot(text: string, targetEpsg: number | null) {
  const result=schema.safeParse(JSON.parse(text));
  if (!result.success) throw new OgcError("invalidFeatureFile");
  const {body,crs,attribution}=result.data;
  const json=body.trimStart().startsWith("{");
  const geometry=json ? parseGeoJson(body,targetEpsg ?? 3857) : parseCityGml(body,targetEpsg,{sourceCrs:crs});
  for (const feature of geometry.features ?? []) feature.source="WFS";
  geometry.attribution=attribution;
  return geometry;
}
