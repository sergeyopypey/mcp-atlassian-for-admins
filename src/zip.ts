/**
 * Minimal, dependency-free ZIP reader.
 *
 * Only what the ScriptRunner "Export all scripts" bundle needs: STORED (0) and
 * DEFLATE (8) entries, decoded with Node's built-in `node:zlib`. Parsing is
 * driven entirely by the central directory, so it is correct even for zips
 * produced by streaming writers — ScriptRunner serves the export with
 * `Transfer-Encoding: chunked`, which leaves the per-entry size fields in the
 * local file headers zeroed (bit-3 / data-descriptor mode). The authoritative
 * sizes live in the central directory.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Slash-separated path as stored in the archive (may end in "/" for dirs). */
  path: string;
  /** Decompressed bytes (empty for directory entries). */
  data: Buffer;
}

const EOCD_SIG = 0x06054b50; // end of central directory record
const CEN_SIG = 0x02014b50; // central directory file header
const LOC_SIG = 0x04034b50; // local file header

/** Extract every entry from a ZIP held entirely in memory. */
export function unzipBuffer(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10); // total central directory records
  let cen = buf.readUInt32LE(eocd + 16); // offset of central directory start

  const entries: ZipEntry[] = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(cen) !== CEN_SIG) {
      throw new Error(`Corrupt zip: bad central directory signature at offset ${cen}`);
    }
    const method = buf.readUInt16LE(cen + 10);
    const compSize = buf.readUInt32LE(cen + 20);
    const nameLen = buf.readUInt16LE(cen + 28);
    const extraLen = buf.readUInt16LE(cen + 30);
    const commentLen = buf.readUInt16LE(cen + 32);
    const localOff = buf.readUInt32LE(cen + 42);
    const name = buf.toString("utf8", cen + 46, cen + 46 + nameLen);

    // The local header repeats the name/extra (always correct, even in
    // streaming mode) — use it to locate where the entry's data begins.
    if (buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error(`Corrupt zip: bad local header for "${name}" at offset ${localOff}`);
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(comp); // STORED
    } else if (method === 8) {
      data = inflateRawSync(comp); // DEFLATE
    } else {
      throw new Error(`Unsupported zip compression method ${method} for "${name}"`);
    }

    entries.push({ path: name, data });
    cen += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Scan backwards for the end-of-central-directory record (handles a comment). */
function findEocd(buf: Buffer): number {
  if (buf.length < 22) throw new Error("Not a zip file: too small");
  const min = Math.max(0, buf.length - 22 - 0xffff); // max comment length is 0xffff
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("Not a zip file: end-of-central-directory record not found");
}
