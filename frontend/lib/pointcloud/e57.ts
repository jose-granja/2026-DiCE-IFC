/**
 * Compatibility for E57 poses with an omitted identity component.
 *
 * @ifc-lite/pointcloud 0.12 discards a pose unless BOTH rotation and translation
 * exist. Survey exports can legitimately omit the identity rotation (as does
 * CloudCompare). Make those defaults explicit in a private Blob view, then
 * keep using the package's streaming decoder. Never rewrite the user's file
 * or buffer its point data: only the header page and bounded XML are read.
 */
import { parseE57FileHeader } from "@ifc-lite/pointcloud";

const MAX_XML_BYTES = 16 * 1024 * 1024;

function completePoses(xml: string): string {
  // Tokenise markup, treating comments, CDATA and quoted attributes as opaque.
  // Only direct children of a Data3D scan's pose are relevant; text mentioning
  // <pose> and image poses must not be rewritten. The decoder validates XML.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;
  const stack: string[] = [];
  let pose: { rotation: boolean; translation: boolean } | null = null;
  let copied = 0;
  let result = "";
  for (const match of xml.matchAll(tokens)) {
    const tag = match[0];
    if (tag.startsWith("<!") || tag.startsWith("<?")) continue;
    const name = /^<\/?\s*([\w:.-]+)/.exec(tag)?.[1];
    if (!name) continue;
    if (tag.startsWith("</")) {
      if (pose && stack.join("/") === "e57Root/data3D/vectorChild/pose") {
        const identity = (!pose.rotation
          ? '<rotation type="Structure"><w type="Float">1</w><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></rotation>'
          : "") + (!pose.translation
          ? '<translation type="Structure"><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></translation>'
          : "");
        if (identity) {
          result += xml.slice(copied, match.index) + identity;
          copied = match.index;
        }
        pose = null;
      }
      stack.pop();
    } else {
      if (pose && stack.join("/") === "e57Root/data3D/vectorChild/pose") {
        if (name === "rotation") pose.rotation = true;
        if (name === "translation") pose.translation = true;
      }
      if (!tag.endsWith("/>")) {
        stack.push(name);
        if (stack.join("/") === "e57Root/data3D/vectorChild/pose") {
          pose = { rotation: false, translation: false };
        }
      }
    }
  }
  return copied ? result + xml.slice(copied) : xml;
}

/** E57 page checksums are CRC-32C, stored most-significant byte first. */
function checksumPage(page: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of page.subarray(0, page.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  new DataView(page.buffer, page.byteOffset, page.byteLength).setUint32(page.length - 4, (crc ^ 0xffffffff) >>> 0);
}

export async function prepareE57(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const header = parseE57FileHeader(new Uint8Array(await blob.slice(0, 48).arrayBuffer()));
  const { pageSize, xmlLogicalOffset, xmlLogicalLength } = header;
  if (!Number.isSafeInteger(pageSize) || pageSize < 52 || pageSize > MAX_XML_BYTES) {
    throw new Error("E57: invalid page size.");
  }
  if (!Number.isSafeInteger(xmlLogicalLength) || xmlLogicalLength < 0 || xmlLogicalLength > MAX_XML_BYTES) {
    throw new Error("E57: XML metadata exceeds the size limit.");
  }
  const payload = pageSize - 4;
  const physical = (logical: number) => Math.floor(logical / payload) * pageSize + logical % payload;
  const start = physical(xmlLogicalOffset);
  const end = physical(xmlLogicalOffset + xmlLogicalLength);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 48 || end > blob.size) {
    throw new Error("E57: XML metadata runs past the end of the file.");
  }
  const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  signal?.throwIfAborted();
  const xmlBytes = new Uint8Array(xmlLogicalLength);
  for (let source = 0, target = 0; target < xmlLogicalLength;) {
    const take = Math.min(payload - (start + source) % pageSize, xmlLogicalLength - target);
    xmlBytes.set(bytes.subarray(source, source + take), target);
    target += take;
    source += take + 4;
  }
  const xml = new TextDecoder().decode(xmlBytes);
  const normalized = completePoses(xml);
  if (normalized === xml) return blob;

  const encoded = new TextEncoder().encode(normalized);
  if (encoded.length > MAX_XML_BYTES) throw new Error("E57: XML metadata exceeds the size limit.");
  const pages = new Uint8Array(Math.ceil(encoded.length / payload) * pageSize);
  for (let offset = 0, from = 0; offset < pages.length; offset += pageSize, from += payload) {
    const page = pages.subarray(offset, offset + pageSize);
    page.set(encoded.subarray(from, from + payload));
    checksumPage(page);
  }
  // Append XML instead of moving it in place: all compressed-vector offsets
  // remain valid, even in a file whose XML precedes its point data.
  const xmlOffset = Math.ceil(blob.size / pageSize) * pageSize;
  const firstPage = new Uint8Array(await blob.slice(0, pageSize).arrayBuffer());
  signal?.throwIfAborted();
  if (firstPage.length !== pageSize) throw new Error("E57: truncated header page.");
  const view = new DataView(firstPage.buffer);
  view.setBigUint64(16, BigInt(xmlOffset + pages.length), true);
  view.setBigUint64(24, BigInt(xmlOffset), true);
  view.setBigUint64(32, BigInt(encoded.length), true);
  checksumPage(firstPage);
  return new Blob([firstPage, blob.slice(pageSize), new Uint8Array(xmlOffset - blob.size), pages]);
}
