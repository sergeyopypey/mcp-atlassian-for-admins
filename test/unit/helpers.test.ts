/** Unit tests for the tricky port helpers. Run: `npm test`. */

import test from "node:test";
import assert from "node:assert/strict";

import { boundedAll } from "../../src/client.js";
import { pythonIsoUtc } from "../../src/tools/fields.js";
import { dumps } from "../../src/json.js";

test("boundedAll preserves input order and caps concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const thunks = Array.from({ length: 25 }, (_, i) => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });
  const results = await boundedAll(thunks, 10);
  assert.deepEqual(
    results,
    Array.from({ length: 25 }, (_, i) => i),
  );
  assert.ok(maxInFlight <= 10, `maxInFlight=${maxInFlight} should be <= 10`);
});

test("pythonIsoUtc formats like datetime.isoformat()", () => {
  // Whole second → no fractional part.
  assert.equal(pythonIsoUtc(Date.UTC(2024, 0, 15, 10, 30, 45)), "2024-01-15T10:30:45+00:00");
  // Milliseconds → 6-digit microseconds.
  assert.equal(
    pythonIsoUtc(Date.UTC(2024, 0, 15, 10, 30, 45, 678)),
    "2024-01-15T10:30:45.678000+00:00",
  );
});

test("dumps omits undefined keys (JS behaviour)", () => {
  assert.equal(dumps({ a: undefined, b: 1 }), '{\n  "b": 1\n}');
});
