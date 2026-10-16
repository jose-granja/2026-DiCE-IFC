import type { ContextFeature } from "./context-geometry";

const FEATURES = new Set([
  "Building", "BuildingPart", "Road", "TrafficArea", "WaterBody", "PlantCover",
  "SolitaryVegetationObject", "ReliefFeature", "TINRelief", "LandUse", "Bridge",
  "CityFurniture", "Tunnel", "GenericCityObject",
]);
const GEOMETRY = /^(?:Multi.*(?:Surface|Solid|Curve|Point|Geometry)|Composite.*|Solid|Shell|Surface|Polygon|PolygonPatch|Triangle|TriangulatedSurface|Tin|LinearRing|Ring|LineString|Curve|Point|Envelope|posList|pos|coordinates|coord)$/;
const MEMBER = /^(?:cityObjectMember|featureMember|member)$/;

function addProperty(feature: ContextFeature, key: string, value: string) {
  if (!key || !value) return;
  const previous = Object.prototype.hasOwnProperty.call(feature.properties, key) ? feature.properties[key] : undefined;
  // Define an own property even for an XML field named __proto__.
  Object.defineProperty(feature.properties, key, {
    value: previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value],
    enumerable: true, writable: true, configurable: true,
  });
  if (key === "name" && !feature.name) feature.name = value;
}

/** DOM and streaming readers share the same feature/attribute rules. */
export function gmlFeatureElement(polygon: Element): Element {
  for (let element: Element | null = polygon; element; element = element.parentElement) {
    if (FEATURES.has(element.localName) || MEMBER.test(element.parentElement?.localName ?? "")) return element;
  }
  return polygon;
}

export function readGmlFeature(element: Element, fallbackId: string): ContextFeature {
  const feature: ContextFeature = {
    id: [...element.attributes].find((attribute) => attribute.localName === "id")?.value ?? fallbackId,
    type: element.localName, source: "CityGML / GML", properties: {},
  };
  const visit = (node: Element, path: string) => {
    if (node !== element && (GEOMETRY.test(node.localName) || FEATURES.has(node.localName))) return;
    for (const attribute of node.attributes) {
      if (attribute.name.startsWith("xmlns") || attribute.localName === "id") continue;
      addProperty(feature, `${path ? `${path}.` : ""}@${attribute.name}`, attribute.value);
    }
    if (!node.children.length) addProperty(feature, path, node.textContent?.trim() ?? "");
    for (const child of node.children) {
      const name = child.getAttribute("name") ?? child.localName;
      visit(child, path ? `${path}.${name}` : name);
    }
  };
  visit(element, "");
  return feature;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity] ?? match;
  });
}

type Frame = { name: string; path: string; text: string; children: boolean; geometry: boolean; feature?: ContextFeature };

/**
 * Metadata-only XML scanner for the large-file worker. Coordinate text is
 * never passed here. A feature object remains live until its closing tag, so
 * attributes following its geometry are included without retaining the XML.
 * Only predefined/numeric entities are decoded; external entities never load.
 */
export class GmlMetadataStream {
  private pending = "";
  private readonly stack: Frame[] = [];
  private sequence = 0;

  get feature(): ContextFeature | undefined { return this.stack.at(-1)?.feature; }

  feed(xml: string) {
    this.pending += xml;
    let cursor = 0;
    while (cursor < this.pending.length) {
      const opening = this.pending.indexOf("<", cursor);
      if (opening < 0) break; // Keep split entity/text until its following tag.
      this.addText(this.pending.slice(cursor, opening));
      cursor = opening;
      const rest = this.pending.slice(opening);
      if (rest.startsWith("<!--") || rest.startsWith("<![CDATA[")) {
        const cdata = rest.startsWith("<![CDATA[");
        const closing = this.pending.indexOf(cdata ? "]]>" : "-->", opening + (cdata ? 9 : 4));
        if (closing < 0) break;
        if (cdata) this.addText(this.pending.slice(opening + 9, closing), false);
        cursor = closing + 3;
        continue;
      }
      const tag = /^<(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(rest)?.[0];
      if (!tag) break;
      cursor = opening + tag.length;
      if (/^<[!?]/.test(tag)) continue;
      if (tag.startsWith("</")) { this.close(); continue; }
      const qualifiedName = /^<([^\s/>]+)/.exec(tag)?.[1];
      if (!qualifiedName) continue;
      const name = qualifiedName.split(":").at(-1)!;
      const attributes = Object.fromEntries([...tag.matchAll(/([^\s=<>]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
        .map((match) => [match[1], decodeXml(match[3])]));
      const parent = this.stack.at(-1);
      if (parent) parent.children = true;
      const isFeature = FEATURES.has(name) || MEMBER.test(parent?.name ?? "");
      const fallbackSurface = !parent?.feature && /^(?:Polygon|PolygonPatch|Triangle)$/.test(name);
      const feature = isFeature || fallbackSurface ? {
        id: Object.entries(attributes).find(([key]) => key.split(":").at(-1) === "id")?.[1] ?? String(++this.sequence),
        type: name, source: "CityGML / GML", properties: {},
      } : parent?.feature;
      const path = isFeature || fallbackSurface ? "" : [parent?.path, attributes.name ?? name].filter(Boolean).join(".");
      const geometry = isFeature ? false : (parent?.geometry ?? false) || GEOMETRY.test(name);
      if (feature && (!geometry || fallbackSurface)) {
        for (const [key, value] of Object.entries(attributes)) {
          if (key.startsWith("xmlns") || key.split(":").at(-1) === "id") continue;
          addProperty(feature, `${path ? `${path}.` : ""}@${key}`, value);
        }
      }
      this.stack.push({ name, path, text: "", children: false, geometry, feature });
      if (/\/\s*>$/.test(tag)) this.close();
    }
    this.pending = this.pending.slice(cursor);
  }

  private addText(text: string, decode = true) {
    const frame = this.stack.at(-1);
    if (frame?.feature && !frame.geometry) frame.text += decode ? decodeXml(text) : text;
  }

  private close() {
    const frame = this.stack.pop();
    if (frame?.feature && !frame.geometry && !frame.children) addProperty(frame.feature, frame.path, frame.text.trim());
  }
}
