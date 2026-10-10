/**
 * Phase 1 engine spike: IFC-lite vs. That Open's web-ifc.
 *
 * Measures, for each engine and each model:
 *   - wall-clock parse time
 *   - peak heap growth (rss delta, best-effort — V8 does not give a true peak)
 *   - whether IfcMapConversion / IfcProjectedCRS survive the read
 *
 * Run:
 *   npx tsx scripts/spike-ifc-engine.mts fixtures/ifc/*.ifc /tmp/synthetic-200mb.ifc
 *
 * The numbers go into docs/adr/001-ifc-engine.md. Re-run it when either engine
 * releases a major version — the ADR's decision is only as good as its data.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** How many elements the property-read benchmark touches. */
const PROPERTY_SAMPLE = 2000;

type Measurement = {
  engine: string;
  file: string;
  sizeMB: number;
  parseMs: number;
  rssDeltaMB: number;
  entityCount: number;
  /**
   * Time to read the property sets of {@link PROPERTY_SAMPLE} elements after
   * the parse. This is the operation the inspector and the IDS validator
   * actually perform, and it is where a lazy parser pays back what it saved at
   * load time — a raw parse number on its own flatters lazy engines.
   */
  propertyReadMs: number;
  propertySetsRead: number;
  /** Did the engine surface the georeferencing block? */
  georef: "mapConversion" | "site-only" | "none" | "n/a";
  crs?: string;
  error?: string;
};

function mb(bytes: number) {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

async function settle() {
  // Give the GC a chance so the rss delta means something.
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 250));
}

async function measureIfcLite(file: string, bytes: ArrayBuffer): Promise<Measurement> {
  const { ifcLiteAdapter, resetIfcLiteAdapter } = await import(
    "../lib/ifc/ifc-lite-adapter.js"
  );

  await settle();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();

  try {
    const model = await ifcLiteAdapter.loadModel({
      name: path.basename(file),
      bytes,
    });
    const parseMs = Math.round(performance.now() - started);
    const rssDelta = process.memoryUsage().rss - rssBefore;

    const walls = await ifcLiteAdapter.getEntities(model.id, {
      types: ["IfcWall"],
      limit: PROPERTY_SAMPLE,
    });
    const propertyStart = performance.now();
    let propertySetsRead = 0;
    for (const wall of walls) {
      propertySetsRead += (
        await ifcLiteAdapter.getProperties(model.id, wall.expressId)
      ).length;
    }
    const propertyReadMs = Math.round(performance.now() - propertyStart);

    const georef = await ifcLiteAdapter.getGeoreferencing(model.id);
    await ifcLiteAdapter.unloadModel(model.id);
    resetIfcLiteAdapter();

    return {
      engine: "ifc-lite",
      file: path.basename(file),
      sizeMB: mb(bytes.byteLength),
      parseMs,
      rssDeltaMB: mb(rssDelta),
      entityCount: model.entityCount,
      propertyReadMs,
      propertySetsRead,
      georef: georef.mapConversion
        ? "mapConversion"
        : georef.site
          ? "site-only"
          : "none",
      crs: georef.projectedCRS?.name,
    };
  } catch (error) {
    return {
      engine: "ifc-lite",
      file: path.basename(file),
      sizeMB: mb(bytes.byteLength),
      parseMs: Math.round(performance.now() - started),
      rssDeltaMB: 0,
      entityCount: 0,
      propertyReadMs: 0,
      propertySetsRead: 0,
      georef: "n/a",
      error: String(error),
    };
  }
}

async function measureWebIfc(file: string, bytes: ArrayBuffer): Promise<Measurement> {
  const WebIFC = await import("web-ifc");

  await settle();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();

  const api = new WebIFC.IfcAPI();
  try {
    await api.Init();
    const modelId = api.OpenModel(new Uint8Array(bytes));
    // web-ifc parses lazily; touching every line is the comparable unit of work
    // to IFC-lite's scan, which also indexes the whole file.
    const allLines = api.GetAllLines(modelId);
    const entityCount = allLines.size();

    const parseMs = Math.round(performance.now() - started);
    const rssDelta = process.memoryUsage().rss - rssBefore;

    // web-ifc has no per-element property index, so the comparable operation is
    // walking IfcRelDefinesByProperties and materialising the sets it points at
    // — which is what @thatopen/components does under the hood.
    const propertyStart = performance.now();
    const wallIds = api.GetLineIDsWithType(modelId, WebIFC.IFCWALL);
    const sampled = new Set<number>();
    for (let i = 0; i < Math.min(wallIds.size(), PROPERTY_SAMPLE); i += 1) {
      sampled.add(wallIds.get(i));
    }

    let propertySetsRead = 0;
    const relIds = api.GetLineIDsWithType(
      modelId,
      WebIFC.IFCRELDEFINESBYPROPERTIES,
    );
    for (let i = 0; i < relIds.size(); i += 1) {
      const rel = api.GetLine(modelId, relIds.get(i)) as {
        RelatedObjects?: Array<{ value: number }>;
        RelatingPropertyDefinition?: { value: number };
      };
      const hit = rel.RelatedObjects?.some((o) => sampled.has(o.value));
      if (!hit || !rel.RelatingPropertyDefinition) continue;
      api.GetLine(modelId, rel.RelatingPropertyDefinition.value, true);
      propertySetsRead += 1;
    }
    const propertyReadMs = Math.round(performance.now() - propertyStart);

    const mapConversions = api.GetLineIDsWithType(
      modelId,
      WebIFC.IFCMAPCONVERSION,
    );
    const projectedCrs = api.GetLineIDsWithType(
      modelId,
      WebIFC.IFCPROJECTEDCRS,
    );

    let crs: string | undefined;
    if (projectedCrs.size() > 0) {
      const line = api.GetLine(modelId, projectedCrs.get(0)) as {
        Name?: { value?: string };
      };
      crs = line?.Name?.value;
    }

    const sites = api.GetLineIDsWithType(modelId, WebIFC.IFCSITE);

    api.CloseModel(modelId);

    return {
      engine: "web-ifc",
      file: path.basename(file),
      sizeMB: mb(bytes.byteLength),
      parseMs,
      rssDeltaMB: mb(rssDelta),
      entityCount,
      propertyReadMs,
      propertySetsRead,
      georef:
        mapConversions.size() > 0
          ? "mapConversion"
          : sites.size() > 0
            ? "site-only"
            : "none",
      crs,
    };
  } catch (error) {
    return {
      engine: "web-ifc",
      file: path.basename(file),
      sizeMB: mb(bytes.byteLength),
      parseMs: Math.round(performance.now() - started),
      rssDeltaMB: 0,
      entityCount: 0,
      propertyReadMs: 0,
      propertySetsRead: 0,
      georef: "n/a",
      error: String(error),
    };
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: tsx scripts/spike-ifc-engine.mts <file.ifc> [...]");
  process.exit(1);
}

const results: Measurement[] = [];

for (const file of files) {
  const buffer = await readFile(file);
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  results.push(await measureIfcLite(file, bytes));
  results.push(await measureWebIfc(file, bytes));
}

console.log(
  `\n| engine | file | size MB | parse ms | rss Δ MB | entities | props ms (${PROPERTY_SAMPLE} walls) | psets | georef | CRS |`,
);
console.log("|---|---|--:|--:|--:|--:|--:|--:|---|---|");
for (const r of results) {
  const dash = (v: number) => (r.error ? "—" : String(v));
  console.log(
    `| ${r.engine} | ${r.file} | ${r.sizeMB} | ${dash(r.parseMs)} | ${dash(
      r.rssDeltaMB,
    )} | ${dash(r.entityCount)} | ${dash(r.propertyReadMs)} | ${dash(
      r.propertySetsRead,
    )} | ${r.error ? `error: ${r.error.slice(0, 60)}` : r.georef} | ${r.crs ?? "—"} |`,
  );
}
