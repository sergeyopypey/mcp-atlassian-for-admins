/** Unit tests for the dependency-free zip reader. Run: `npm test`. */

import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { unzipBuffer } from "../../src/zip.js";

interface Item {
  name: string;
  body: Buffer;
  method: 0 | 8; // STORED | DEFLATE
}

/**
 * Build a zip that mimics a streaming writer (like ScriptRunner's chunked
 * export): the general-purpose bit-3 flag is set, the size/crc fields in each
 * local header are zeroed, and the real sizes live only in the central
 * directory (plus a trailing data descriptor). crc32 is left 0 — the reader
 * does not validate it.
 */
function buildStreamingZip(items: Item[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const it of items) {
    const nameBuf = Buffer.from(it.name, "utf8");
    const comp = it.method === 8 ? deflateRawSync(it.body) : it.body;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0008, 6); // bit 3 -> sizes in data descriptor
    local.writeUInt16LE(it.method, 8);
    // crc(14), compSize(18), uncompSize(22) intentionally left 0
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const dataDesc = Buffer.alloc(16);
    dataDesc.writeUInt32LE(0x08074b50, 0);
    dataDesc.writeUInt32LE(0, 4); // crc32
    dataDesc.writeUInt32LE(comp.length, 8);
    dataDesc.writeUInt32LE(it.body.length, 12);

    const localOffset = offset;
    for (const b of [local, nameBuf, comp, dataDesc]) {
      chunks.push(b);
      offset += b.length;
    }

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0008, 8);
    cen.writeUInt16LE(it.method, 10);
    cen.writeUInt32LE(0, 16); // crc32
    cen.writeUInt32LE(comp.length, 20); // authoritative compressed size
    cen.writeUInt32LE(it.body.length, 24); // authoritative uncompressed size
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
  }

  const cdStart = offset;
  const cd = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8); // records on this disk
  eocd.writeUInt16LE(items.length, 10); // total records
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([...chunks, cd, eocd]);
}

test("unzipBuffer decodes STORED and DEFLATE entries via the central directory", () => {
  const stored = Buffer.from("plain stored bytes\n", "utf8");
  const deflated = Buffer.from(
    JSON.stringify({ FIELD_SCRIPT_FILE_OR_SCRIPT: { script: "log.warn('hi')".repeat(50) } }),
    "utf8",
  );

  const zip = buildStreamingZip([
    { name: "scriptListeners/abc.json", body: deflated, method: 8 },
    { name: "default_script_root_scripts/com/x/Util.groovy", body: stored, method: 0 },
  ]);

  const entries = unzipBuffer(zip);
  assert.equal(entries.length, 2);

  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  assert.deepEqual(byPath.get("scriptListeners/abc.json"), deflated);
  assert.deepEqual(byPath.get("default_script_root_scripts/com/x/Util.groovy"), stored);
});

test("unzipBuffer throws on non-zip input", () => {
  assert.throws(() => unzipBuffer(Buffer.from("not a zip at all")), /not a zip/i);
});
