/**
 * Annotations drawn on a viewpoint's snapshot — arrows, clouds, text — the
 * markup a coordinator scribbles on a screenshot before sending it.
 *
 * ## Baked in, and still editable
 *
 * BCF has no vector markup for a snapshot: a snapshot is a PNG, and every tool
 * that reads the topic shows that PNG. So the annotations are **drawn into the
 * snapshot**, and the image another tool shows is the annotated one.
 *
 * To edit them later, the PNG also carries what it was made from — the clean
 * image and the shapes — in one private ancillary chunk (`dcAn`). PNG readers
 * skip ancillary chunks they do not know (ISO 15948 §5.4), so the file stays an
 * ordinary snapshot to everyone else, the BCF archive keeps exactly its usual
 * files, and the annotations survive anything that keeps the snapshot: the
 * OPFS draft, a project folder, an export read back in.
 *
 * The chunk is read as untrusted input — a topic can come from anyone — and its
 * shapes go through a schema before anything draws them.
 *
 * ## Coordinates are fractions of the image
 *
 * `x` and `y` run 0–1 across and down the image, and line widths and text
 * sizes are per 1000 px of image height. A snapshot is the canvas at whatever
 * size the viewport had, and "Update viewpoint" may capture a different one;
 * proportional shapes land in the same place on either.
 */

import { z } from "zod";

export type AnnotationPoint = { x: number; y: number };

type Style = {
  id: string;
  /** CSS hex. */
  colour: string;
  /** Line width, per 1000 px of image height. */
  stroke: number;
};

export type Annotation =
  | (Style & { kind: "arrow" | "line" | "rect" | "ellipse" | "cloud"; from: AnnotationPoint; to: AnnotationPoint })
  | (Style & { kind: "pen"; points: AnnotationPoint[] })
  | (Style & { kind: "text"; at: AnnotationPoint; text: string; size: number });

export type AnnotationKind = Annotation["kind"];

/** Data, not theme: the colours drawn into an image someone else will read. */
export const ANNOTATION_COLOURS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#ffffff", "#111111"];
export const ANNOTATION_STROKES = [3, 6, 10];
export const ANNOTATION_TEXT_SIZES = [28, 40, 60];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const unit = z.number().finite().min(-1).max(2);
const point = z.object({ x: unit, y: unit });
const style = {
  id: z.string().min(1).max(200),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  stroke: z.number().finite().min(0.5).max(100),
};

export const annotationSchema = z.union([
  z.object({ ...style, kind: z.enum(["arrow", "line", "rect", "ellipse", "cloud"]), from: point, to: point }),
  z.object({ ...style, kind: z.literal("pen"), points: z.array(point).min(1).max(20_000) }),
  z.object({
    ...style,
    kind: z.literal("text"),
    at: point,
    text: z.string().min(1).max(2_000),
    size: z.number().finite().min(4).max(400),
  }),
]);

const payloadSchema = z.object({
  format: z.literal("dice-ifc-annotations"),
  version: z.number().int().positive(),
  shapes: z.array(annotationSchema).max(2_000),
});

// ---------------------------------------------------------------------------
// The PNG chunk
// ---------------------------------------------------------------------------

/** Ancillary, private, reserved bit clear, safe to copy — the case of each letter says so. */
const CHUNK = "dcAn";
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export type AnnotatedSnapshot = {
  /** The snapshot as captured, without annotations. */
  base: Uint8Array;
  shapes: Annotation[];
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array) {
  return bytes.length >= 8 && SIGNATURE.every((value, index) => bytes[index] === value);
}

type Chunk = { type: string; start: number; end: number; data: Uint8Array };

/** The PNG's chunks, or null when it is not one or is cut short. */
function chunks(png: Uint8Array): Chunk[] | null {
  if (!isPng(png)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > png.length) return null;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    out.push({ type, start: offset, end, data: png.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  return out;
}

/** The clean image and shapes a snapshot was annotated from, or null for a plain snapshot. */
export function readAnnotatedSnapshot(png: Uint8Array): AnnotatedSnapshot | null {
  const chunk = chunks(png)?.find((entry) => entry.type === CHUNK);
  if (!chunk || chunk.data.length < 4) return null;
  const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  const jsonLength = view.getUint32(0);
  if (4 + jsonLength > chunk.data.length) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(chunk.data.subarray(4, 4 + jsonLength)));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(raw);
  const base = chunk.data.slice(4 + jsonLength);
  if (!parsed.success || !isPng(base)) return null;
  return { base, shapes: parsed.data.shapes as Annotation[] };
}

/** `composited` with the clean image and the shapes in it, replacing any it had. */
export function writeAnnotatedSnapshot(composited: Uint8Array, base: Uint8Array, shapes: Annotation[]): Uint8Array {
  const list = chunks(composited);
  const iend = list?.find((entry) => entry.type === "IEND");
  if (!list || !iend) throw new Error("The snapshot is not a PNG.");

  const json = new TextEncoder().encode(JSON.stringify({ format: "dice-ifc-annotations", version: 1, shapes }));
  const data = new Uint8Array(4 + json.length + base.length);
  new DataView(data.buffer).setUint32(0, json.length);
  data.set(json, 4);
  data.set(base, 4 + json.length);

  const typeAndData = new Uint8Array(4 + data.length);
  typeAndData.set([...CHUNK].map((letter) => letter.charCodeAt(0)), 0);
  typeAndData.set(data, 4);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeAndData, 4);
  view.setUint32(8 + data.length, crc32(typeAndData));

  // Everything but an old annotation chunk, with the new one just before IEND.
  const kept = list.filter((entry) => entry.type !== CHUNK && entry.type !== "IEND");
  const parts = [composited.subarray(0, 8), ...kept.map((entry) => composited.subarray(entry.start, entry.end)), chunk,
    composited.subarray(iend.start, iend.end)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The clean image and the shapes to start editing from — a plain snapshot is its own base. */
export function annotationsOf(png: Uint8Array): AnnotatedSnapshot {
  return readAnnotatedSnapshot(png) ?? { base: png, shapes: [] };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Px = { x: number; y: number };
const px = (p: AnnotationPoint, width: number, height: number): Px => ({ x: p.x * width, y: p.y * height });

/** Scale of the per-1000-px units. */
export const unitScale = (height: number) => height / 1000;

/**
 * The points of a revision cloud around the rectangle `a`–`b`: the corners of
 * a run of scallops, each bulging outwards, sized to the rectangle so a small
 * cloud is not a single lump and a large one not a fringe.
 */
export function cloudScallops(a: Px, b: Px, stroke: number): Array<{ from: Px; to: Px; control: Px }> {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const w = right - left;
  const h = bottom - top;
  if (w < 1 || h < 1) return [];
  const step = Math.max(stroke * 4, Math.min(w, h) / 4, 8);
  // Clockwise on screen (y down), so the outward normal of a step (dx, dy) is (dy, −dx).
  const corners: Px[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const out: Array<{ from: Px; to: Px; control: Px }> = [];
  for (let side = 0; side < 4; side += 1) {
    const start = corners[side];
    const end = corners[(side + 1) % 4];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const count = Math.max(1, Math.round(length / step));
    const dx = (end.x - start.x) / count;
    const dy = (end.y - start.y) / count;
    const bulge = Math.hypot(dx, dy) * 0.6;
    const nx = dy / Math.hypot(dx, dy);
    const ny = -dx / Math.hypot(dx, dy);
    for (let i = 0; i < count; i += 1) {
      const from = { x: start.x + dx * i, y: start.y + dy * i };
      const to = { x: start.x + dx * (i + 1), y: start.y + dy * (i + 1) };
      out.push({ from, to, control: { x: (from.x + to.x) / 2 + nx * bulge, y: (from.y + to.y) / 2 + ny * bulge } });
    }
  }
  return out;
}

/** The two barbs of an arrowhead at `to`, sized to the line width. */
export function arrowHead(from: Px, to: Px, stroke: number): [Px, Px] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(12, stroke * 4.5);
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

function distanceToSegment(p: Px, a: Px, b: Px) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A text's lines and box, in px — `measure` is the canvas's, or an estimate without one. */
export function textBox(
  shape: Extract<Annotation, { kind: "text" }>,
  width: number,
  height: number,
  measure: (line: string, fontPx: number) => number = (line, fontPx) => line.length * fontPx * 0.58,
) {
  const fontPx = shape.size * unitScale(height);
  const lines = shape.text.split("\n");
  const at = px(shape.at, width, height);
  const boxWidth = Math.max(...lines.map((line) => measure(line, fontPx)));
  return { lines, fontPx, lineHeight: fontPx * 1.2, x: at.x, y: at.y, width: boxWidth, height: lines.length * fontPx * 1.2 };
}

/** The topmost shape under `point` (in px), within `tolerance` px of its line. */
export function hitTest(
  shapes: Annotation[],
  point: Px,
  width: number,
  height: number,
  tolerance = 8,
): Annotation | null {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    const reach = tolerance + (shape.stroke * unitScale(height)) / 2;
    if (shape.kind === "text") {
      const box = textBox(shape, width, height);
      if (point.x >= box.x - reach && point.x <= box.x + box.width + reach && point.y >= box.y - reach &&
        point.y <= box.y + box.height + reach) return shape;
      continue;
    }
    if (shape.kind === "pen") {
      const points = shape.points.map((p) => px(p, width, height));
      if (points.some((p, i) => distanceToSegment(point, p, points[Math.min(i + 1, points.length - 1)]) <= reach)) {
        return shape;
      }
      continue;
    }
    const a = px(shape.from, width, height);
    const b = px(shape.to, width, height);
    if (shape.kind === "arrow" || shape.kind === "line") {
      if (distanceToSegment(point, a, b) <= reach) return shape;
      continue;
    }
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    if (shape.kind === "ellipse") {
      const rx = (right - left) / 2;
      const ry = (bottom - top) / 2;
      const cx = left + rx;
      const cy = top + ry;
      // Near the outline, measured along the ray from the centre.
      const angle = Math.atan2(point.y - cy, point.x - cx);
      const edge = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
      if (Math.hypot(point.x - edge.x, point.y - edge.y) <= reach) return shape;
      continue;
    }
    // A rectangle or a cloud is picked by its outline, or inside it.
    const cloud = shape.kind === "cloud" ? Math.max(shape.stroke * 4 * unitScale(height), 8) : 0;
    if (point.x >= left - reach - cloud && point.x <= right + reach + cloud && point.y >= top - reach - cloud &&
      point.y <= bottom + reach + cloud) return shape;
  }
  return null;
}

/** The box a shape covers, in px, for a selection outline. */
export function annotationBounds(shape: Annotation, width: number, height: number) {
  if (shape.kind === "text") {
    const box = textBox(shape, width, height);
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  const points = (shape.kind === "pen" ? shape.points : [shape.from, shape.to]).map((p) => px(p, width, height));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** `shape` moved by a fraction of the image. */
export function moveAnnotation(shape: Annotation, dx: number, dy: number): Annotation {
  const move = (p: AnnotationPoint) => ({ x: p.x + dx, y: p.y + dy });
  if (shape.kind === "pen") return { ...shape, points: shape.points.map(move) };
  if (shape.kind === "text") return { ...shape, at: move(shape.at) };
  return { ...shape, from: move(shape.from), to: move(shape.to) };
}

/** Too small to be what anyone meant to draw — a click, not a drag. */
export function isDegenerate(shape: Annotation, width: number, height: number): boolean {
  if (shape.kind === "text") return shape.text.trim().length === 0;
  if (shape.kind === "pen") return shape.points.length < 2;
  const a = px(shape.from, width, height);
  const b = px(shape.to, width, height);
  return Math.hypot(b.x - a.x, b.y - a.y) < 4;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Draw the shapes onto a canvas the size of the image (`width`×`height` px). */
export function drawAnnotations(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  shapes: Annotation[],
  width: number,
  height: number,
) {
  const scale = unitScale(height);
  for (const shape of shapes) {
    const stroke = Math.max(1, shape.stroke * scale);
    context.save();
    context.strokeStyle = shape.colour;
    context.fillStyle = shape.colour;
    context.lineWidth = stroke;
    context.lineCap = "round";
    context.lineJoin = "round";

    if (shape.kind === "text") {
      const box = textBox(shape, width, height, (line, fontPx) => {
        context.font = font(fontPx);
        return context.measureText(line).width;
      });
      context.font = font(box.fontPx);
      context.textBaseline = "top";
      // A halo in the opposite tone, so the words read over any part of the model.
      context.lineWidth = Math.max(2, box.fontPx / 7);
      context.strokeStyle = isLight(shape.colour) ? "#111111" : "#ffffff";
      box.lines.forEach((line, index) => {
        const y = box.y + index * box.lineHeight;
        context.strokeText(line, box.x, y);
        context.fillText(line, box.x, y);
      });
      context.restore();
      continue;
    }

    context.beginPath();
    if (shape.kind === "pen") {
      const points = shape.points.map((p) => px(p, width, height));
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      if (points.length === 1) context.lineTo(points[0].x + 0.1, points[0].y);
      context.stroke();
      context.restore();
      continue;
    }

    const a = px(shape.from, width, height);
    const b = px(shape.to, width, height);
    if (shape.kind === "line" || shape.kind === "arrow") {
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      if (shape.kind === "arrow") {
        const [left, right] = arrowHead(a, b, stroke);
        context.beginPath();
        context.moveTo(b.x, b.y);
        context.lineTo(left.x, left.y);
        context.lineTo(right.x, right.y);
        context.closePath();
        context.fill();
      }
    } else if (shape.kind === "rect") {
      context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (shape.kind === "ellipse") {
      context.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0,
        Math.PI * 2);
      context.stroke();
    } else {
      const scallops = cloudScallops(a, b, stroke);
      if (scallops.length > 0) {
        context.moveTo(scallops[0].from.x, scallops[0].from.y);
        for (const scallop of scallops) context.quadraticCurveTo(scallop.control.x, scallop.control.y, scallop.to.x, scallop.to.y);
        context.closePath();
        context.stroke();
      }
    }
    context.restore();
  }
}

const font = (fontPx: number) => `600 ${fontPx}px system-ui, sans-serif`;

function isLight(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

/**
 * The snapshot with its annotations drawn in, carrying the clean image and the
 * shapes for the next edit. No shapes gives back the clean image itself.
 */
export async function composeAnnotatedSnapshot(base: Uint8Array, shapes: Annotation[]): Promise<Uint8Array> {
  if (shapes.length === 0) return base;
  const bitmap = await createImageBitmap(new Blob([base as BlobPart], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas is available to draw the annotations.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  drawAnnotations(context, shapes, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The annotated snapshot could not be encoded.");
  return writeAnnotatedSnapshot(new Uint8Array(await blob.arrayBuffer()), base, shapes);
}
