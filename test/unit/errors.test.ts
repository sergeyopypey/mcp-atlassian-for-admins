/** Unit tests for HTTP error messages. Run: `npm test`. */

import test from "node:test";
import assert from "node:assert/strict";

import { HttpStatusError, errorDetail } from "../../src/errors.js";

test("errorDetail joins Jira errorMessages and errors", () => {
  const body = JSON.stringify({
    errorMessages: ['No matching attribute for AQL clause ("Foo" = x)'],
    errors: { iql: "bad clause" },
  });
  assert.equal(errorDetail(body), 'No matching attribute for AQL clause ("Foo" = x); iql: bad clause');
});

test("errorDetail falls back to a plain-text body and truncates it", () => {
  assert.equal(errorDetail("Service Unavailable"), "Service Unavailable");
  const long = errorDetail("x".repeat(1000));
  assert.equal(long.length, 501);
  assert.ok(long.endsWith("…"));
});

test("errorDetail ignores HTML pages and empty bodies", () => {
  assert.equal(errorDetail("\n\n<!DOCTYPE html><html>…</html>"), "");
  assert.equal(errorDetail(""), "");
  assert.equal(errorDetail(JSON.stringify({ errorMessages: [], errors: {} })), JSON.stringify({ errorMessages: [], errors: {} }));
});

test("HttpStatusError puts the detail in the message unless one is given", () => {
  const body = JSON.stringify({ errorMessages: ["Issue Does Not Exist"], errors: {} });
  assert.equal(
    new HttpStatusError(404, body, "https://jira.yourcompany.com/rest/api/2/issue/PROJ-1").message,
    "HTTP 404 for https://jira.yourcompany.com/rest/api/2/issue/PROJ-1: Issue Does Not Exist",
  );
  assert.equal(new HttpStatusError(500, "<html/>", "u").message, "HTTP 500 for u");
  assert.equal(new HttpStatusError(400, body, "u", "custom").message, "custom");
});
