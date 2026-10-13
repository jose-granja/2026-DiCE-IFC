/** Small synthetic E57s: real paged bytes, two optional pose components. */
type Triple = [number, number, number];
export type Scan = {
  points: Triple[];
  translation?: Triple;
  rotation?: [number, number, number, number];
};

export function e57Fixture(scans: Scan[], options: { xmlFirst?: boolean; description?: string } = {}): Uint8Array<ArrayBuffer> {
  const pageSize = 1024;
  const payload = pageSize - 4;
  const physical = (logical: number) => Math.floor(logical / payload) * pageSize + logical % payload;
  // Reserve room for metadata before data when exercising that legal layout.
  let cursor = options.xmlFirst ? payload * 8 : 48;
  const offsets = scans.map(({ points }) => {
    const offset = cursor;
    cursor += 32 + 12 + points.length * 24;
    return offset;
  });
  const floats = (names: string[], values: number[]) => names.map((name, i) => `<${name} type="Float">${values[i]}</${name}>`).join("");
  const xml = new TextEncoder().encode(`<?xml version="1.0"?>
    <e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0">
    <description type="String"><![CDATA[${options.description ?? "Synthetic survey fixture"}]]></description>
    <coordinateMetadata type="String"/>
    <data3D type="Vector" allowHeterogeneousChildren="1">${scans.map((scan, index) => `
      <vectorChild type="Structure"><guid type="String">scan-${index}</guid>
        ${scan.translation || scan.rotation ? `<pose type="Structure">
          ${scan.rotation ? `<rotation type="Structure">${floats(["w", "x", "y", "z"], scan.rotation)}</rotation>` : ""}
          ${scan.translation ? `<translation type="Structure">${floats(["x", "y", "z"], scan.translation)}</translation>` : ""}
        </pose>` : ""}
        <points type="CompressedVector" fileOffset="${physical(offsets[index])}" recordCount="${scan.points.length}">
          <prototype type="Structure">
            <cartesianX type="Float" precision="double"/>
            <cartesianY type="Float" precision="double"/>
            <cartesianZ type="Float" precision="double"/>
          </prototype><codecs type="Vector" allowHeterogeneousChildren="1"/>
        </points>
      </vectorChild>`).join("")}
    </data3D></e57Root>`);
  const xmlOffset = options.xmlFirst ? 48 : cursor;
  if (options.xmlFirst && xmlOffset + xml.length > offsets[0]) throw new Error("Fixture XML too large");
  const logical = new Uint8Array(Math.max(cursor, xmlOffset + xml.length));
  const view = new DataView(logical.buffer);
  logical.set(new TextEncoder().encode("ASTM-E57"));
  view.setUint32(8, 1, true);
  const physicalSize = Math.ceil(logical.length / payload) * pageSize;
  view.setBigUint64(16, BigInt(physicalSize), true);
  view.setBigUint64(24, BigInt(physical(xmlOffset)), true);
  view.setBigUint64(32, BigInt(xml.length), true);
  view.setBigUint64(40, BigInt(pageSize), true);
  logical.set(xml, xmlOffset);

  scans.forEach(({ points }, scanIndex) => {
    const section = offsets[scanIndex];
    const packet = section + 32;
    const packetLength = 12 + points.length * 24;
    view.setUint8(section, 1);
    view.setBigUint64(section + 8, BigInt(32 + packetLength), true);
    view.setBigUint64(section + 16, BigInt(physical(packet)), true);
    view.setUint8(packet, 1);
    view.setUint16(packet + 2, packetLength - 1, true);
    view.setUint16(packet + 4, 3, true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setUint16(packet + 6 + axis * 2, points.length * 8, true);
      points.forEach((point, index) => view.setFloat64(packet + 12 + (axis * points.length + index) * 8, point[axis], true));
    }
  });

  const bytes = new Uint8Array(physicalSize);
  for (let page = 0, from = 0; page < physicalSize; page += pageSize, from += payload) {
    bytes.set(logical.subarray(from, from + payload), page);
    new DataView(bytes.buffer).setUint32(page + payload, crc32c(bytes.subarray(page, page + payload)));
  }
  return bytes;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit += 1) byte = (byte >>> 1) ^ ((byte & 1) ? 0x82f63b78 : 0);
  return byte;
});
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
