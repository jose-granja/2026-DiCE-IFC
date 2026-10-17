/** Offline WMS snapshots: georeferencing + image, saved with the project. */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { z } from "zod";
import { GeometryBuilder, type ContextGeometry } from "./context-geometry";
import { mapToWgs84, wgs84ToMap } from "./transform";
import { OgcError } from "./ogc-service";

const finite = z.number().finite();
export const mapSnapshotSchema = z.object({
  format:z.literal("dice-context-map"), version:z.literal(1),
  name:z.string().max(4096), attribution:z.string().max(8192),
  attributionUrl:z.string().url().refine((url) => /^https?:\/\//i.test(url)).optional(),
  sourceEpsg:z.number().int().positive(),
  box:z.object({minX:finite,minY:finite,maxX:finite,maxY:finite}).refine((b) => b.maxX>b.minX && b.maxY>b.minY),
  height:finite,
  mimeType:z.enum(["image/png","image/jpeg"]),
});
export type MapSnapshot = z.infer<typeof mapSnapshotSchema>;

export async function saveMapSnapshot(metadata: MapSnapshot, image: Blob): Promise<File> {
  const bytes = zipSync({ "map.json":strToU8(JSON.stringify(mapSnapshotSchema.parse(metadata))), "map-image":new Uint8Array(await image.arrayBuffer()) }, {level:0});
  return new File([bytes as Uint8Array<ArrayBuffer>], `${metadata.name.replace(/[^\p{L}\p{N}._-]/gu,"_")}.context-map`, {type:"application/zip"});
}

/** A grid retains the map's georeferencing when its CRS differs from the IFC. */
export function mapGeometry(metadata: MapSnapshot, targetEpsg: number): ContextGeometry & { uvs: Float32Array } {
  const {box,height,sourceEpsg} = metadata;
  const project = (x: number,y: number): [number,number,number] => {
    if (sourceEpsg === targetEpsg) return [x,y,height];
    const p = wgs84ToMap(mapToWgs84({easting:x,northing:y},sourceEpsg),targetEpsg);
    return [p.easting,p.northing,height];
  };
  const centre = project((box.minX+box.maxX)/2,(box.minY+box.maxY)/2);
  const origin = {easting:centre[0],northing:centre[1],height};
  const builder = new GeometryBuilder(), uvs: number[] = [];
  const n=32;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (let y=0;y<n;y++) for (let x=0;x<n;x++) {
    const corners = [[x,y],[x+1,y],[x+1,y+1],[x,y+1]].map(([i,j]) => ({uv:[i/n,1-j/n], point:project(box.minX+(box.maxX-box.minX)*i/n,box.maxY-(box.maxY-box.minY)*j/n)}));
    for (const corner of corners) {
      if (!corner.point.every(Number.isFinite)) throw new OgcError("unsupportedCrs");
      minX=Math.min(minX,corner.point[0]); maxX=Math.max(maxX,corner.point[0]);
      minY=Math.min(minY,corner.point[1]); maxY=Math.max(maxY,corner.point[1]);
    }
    for (const indices of [[0,2,1],[0,3,2]]) {
      builder.triangle(corners[indices[0]].point,corners[indices[1]].point,corners[indices[2]].point,[1,1,1],origin);
      for (const i of indices) uvs.push(...corners[i].uv);
    }
  }
  builder.addFeature({id:metadata.name,name:metadata.name,type:"WMS",source:"WMS",properties:{Layer:metadata.name,Attribution:metadata.attribution}},0);
  return {...builder.finish(),uvs:new Float32Array(uvs),origin,epsg:targetEpsg,objectCount:1,types:[{type:"WMS",count:1}],sizeMetres:Math.max(maxX-minX,maxY-minY),attribution:metadata.attribution,attributionUrl:metadata.attributionUrl};
}

export async function readMapSnapshot(file: Blob, targetEpsg: number | null): Promise<ContextGeometry> {
  if (file.size>24*1024*1024) throw new OgcError("tooLarge");
  let entries: ReturnType<typeof unzipSync>;
  try {
    entries=unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:(entry) => (entry.name === "map.json" && entry.originalSize<32768) || (entry.name === "map-image" && entry.originalSize<=20*1024*1024)});
  } catch { throw new OgcError("invalidMapFile"); }
  let document: unknown;
  try { document=JSON.parse(strFromU8(entries["map.json"] ?? new Uint8Array())); } catch { throw new OgcError("invalidMapFile"); }
  const parsed = mapSnapshotSchema.safeParse(document);
  if (!parsed.success || !entries["map-image"]) throw new OgcError("invalidMapFile");
  const {uvs,...geometry} = mapGeometry(parsed.data,targetEpsg ?? (parsed.data.sourceEpsg === 4326 ? 3857 : parsed.data.sourceEpsg));
  // ImageBitmap orientation must be applied at decode time, not via Texture.flipY.
  const image = await createImageBitmap(new Blob([entries["map-image"] as Uint8Array<ArrayBuffer>],{type:parsed.data.mimeType}),{imageOrientation:"flipY"}).catch(() => {throw new OgcError("unsupportedImage");});
  if (image.width>4096 || image.height>4096) {image.close();throw new OgcError("tooLarge");}
  return {...geometry,raster:{image,uvs}};
}
