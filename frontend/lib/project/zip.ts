/**
 * The `.zip` a project folder becomes where a browser cannot write folders.
 *
 * Small and specific rather than fflate's streaming `Zip`/`Unzip`, for two
 * reasons that both bit:
 *
 * - **A streaming writer cannot put an entry's size in front of it**, so it
 *   writes "size follows the data" on every entry. For a *stored* entry a
 *   streaming reader then has no way to find where the entry ends except by
 *   looking for the next signature — and a project is full of entries that are
 *   zips themselves (`.xlsx`, `.bcf`, `.ifczip`), whose own signatures it takes
 *   for the outer archive's. The clash workbook came back as "unknown
 *   compression type". Here every size and CRC is known before the entry is
 *   written, and reading goes through the central directory, which has exact
 *   offsets whatever the entries contain.
 * - **No copy of the files.** Entries are stored, not compressed, and the
 *   archive is a `Blob` made of the original files with headers between them,
 *   so saving a gigabyte of models does not hold a second gigabyte in memory.
 *   Reading slices stored entries out of the archive the same way.
 *
 * Deflated entries are read too (fflate inflates them), because a user may
 * well zip the folder themselves. ZIP64 is not: past 4 GB the archive says so.
 */

import { inflateSync } from "fflate";

export type ZipEntry = { path: string; data: Blob };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** General-purpose flag bit 11: the name is UTF-8 ("Fundações.ifc"). */
const UTF8_NAMES = 0x0800;
const MAX_32 = 0xffffffff;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (the zip polynomial), streamed so a large file is never read whole
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export async function crc32(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i += 1) crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** A stored zip of `entries`, with every size and CRC up front. */
export async function writeZip(entries: ZipEntry[], now = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const size = entry.data.size;
    if (size >= MAX_32 || offset >= MAX_32) {
      throw new ZipFormatError("The project is larger than a .zip can hold (4 GB). Save it as a folder instead.");
    }
    const crc = await crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER, true);
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, CENTRAL_HEADER, true);
    record.setUint16(4, 20, true); // made by: 2.0, MS-DOS attributes
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8_NAMES, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    const centralEntry = new Uint8Array(46 + name.length);
    centralEntry.set(new Uint8Array(record.buffer), 0);
    centralEntry.set(name, 46);
    central.push(centralEntry);

    parts.push(new Uint8Array(local.buffer), name, entry.data);
    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  if (entries.length > 0xffff || offset + centralSize >= MAX_32) {
    throw new ZipFormatError("The project is larger than a .zip can hold (4 GB). Save it as a folder instead.");
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...(central as BlobPart[]), new Uint8Array(end.buffer)], {
    type: "application/zip",
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function bytesOf(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/**
 * Every file in the archive, as `File`s. Stored entries are slices of the
 * archive itself — nothing is read until something reads them.
 */
export async function readZip(archive: Blob): Promise<Array<{ path: string; file: File }>> {
  // The end-of-central-directory record is the last 22 bytes, unless a comment
  // follows it (up to 64 KB), so search backwards from the end.
  const tailStart = Math.max(0, archive.size - 22 - 0xffff);
  const tail = await bytesOf(archive, tailStart, archive.size);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError("Not a zip archive.");

  const count = tail.getUint16(end + 10, true);
  const centralSize = tail.getUint32(end + 12, true);
  const centralOffset = tail.getUint32(end + 16, true);
  if (count === 0xffff || centralSize === MAX_32 || centralOffset === MAX_32) {
    throw new ZipFormatError("This .zip uses ZIP64 (over 4 GB), which cannot be read here. Unzip it and load the folder.");
  }
  if (centralOffset + centralSize > archive.size) throw new ZipFormatError("The zip archive is truncated.");

  const directory = await bytesOf(archive, centralOffset, centralOffset + centralSize);
  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder();
  const files: Array<{ path: string; file: File }> = [];

  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (directory.getUint32(at, true) !== CENTRAL_HEADER) throw new ZipFormatError("The zip directory is damaged.");
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const compressedSize = directory.getUint32(at + 20, true);
    const size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const localOffset = directory.getUint32(at + 42, true);
    const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength);
    // Bit 11 says UTF-8; without it the name is CP437, of which Latin-1 is the
    // closest the platform decodes — right for every ASCII name.
    const path = (flags & UTF8_NAMES ? utf8 : latin1).decode(nameBytes);
    at += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith("/")) continue;
    if (flags & 0x0001) throw new ZipFormatError("The zip archive is encrypted.");
    if (compressedSize === MAX_32 || size === MAX_32 || localOffset === MAX_32) {
      throw new ZipFormatError("This .zip uses ZIP64 (over 4 GB), which cannot be read here. Unzip it and load the folder.");
    }

    // The data starts after the *local* header, whose name and extra field
    // lengths may differ from the central directory's.
    const local = await bytesOf(archive, localOffset, localOffset + 30);
    if (local.getUint32(0, true) !== LOCAL_HEADER) throw new ZipFormatError("The zip archive is damaged.");
    const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const data = archive.slice(start, start + compressedSize);
    const name = path.split("/").pop() ?? path;

    if (method === 0) {
      files.push({ path, file: new File([data], name) });
    } else if (method === 8) {
      const inflated = inflateSync(new Uint8Array(await data.arrayBuffer()), { out: new Uint8Array(size) });
      files.push({ path, file: new File([inflated as BlobPart], name) });
    } else {
      throw new ZipFormatError(`The zip archive uses a compression method (${method}) that cannot be read here.`);
    }
  }
  return files;
}
