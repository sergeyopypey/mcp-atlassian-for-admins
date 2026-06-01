/** Unit tests for the tricky port helpers. Run: `npm test`. */

import test from "node:test";
import assert from "node:assert/strict";

import { boundedAll } from "../../src/client.js";
import { pythonIsoUtc } from "../../src/tools/fields.js";
import { parseWorkflowXml } from "../../src/lib/workflowXml.js";
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

test("parseWorkflowXml extracts steps and transitions", () => {
  const xml = `<workflow>
    <initial-actions>
      <action id="1" name="Create">
        <results><unconditional-result step="1"/></results>
      </action>
    </initial-actions>
    <steps>
      <step id="1" name="Open">
        <meta name="jira.status.id">1</meta>
        <actions>
          <action id="11" name="Start Progress">
            <results><unconditional-result step="2"/></results>
          </action>
        </actions>
      </step>
      <step id="2" name="In Progress">
        <meta name="jira.status.id">3</meta>
      </step>
    </steps>
  </workflow>`;
  const parsed = parseWorkflowXml(xml);
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].name, "Open");
  assert.equal(parsed.steps[0].statusId, "1");
  assert.equal(parsed.steps[0].actions?.[0].name, "Start Progress");
  assert.equal(parsed.steps[0].actions?.[0].to, "In Progress");
  assert.equal(parsed.steps[1].statusId, "3");
  assert.equal(parsed.initialActions?.[0].name, "Create");
  assert.equal(parsed.initialActions?.[0].to, "Open");
});

test("parseWorkflowXml decodes ScriptRunner base64 arg values", () => {
  // `YCFg…` arg values are base64 of a `` `!` `` marker + JSON {script|scriptPath}.
  const inlineScript =
    "YCFgeyJzY3JpcHQiOiJpc3N1ZS5nZXRDdXN0b21GaWVsZFZhbHVlKDEwMDAxKSAmJiBpc3N1ZS5nZXRDdXN0b21G" +
    "aWVsZFZhbHVlKDEwMDAyKSIsInNjcmlwdFBhdGgiOm51bGx9";
  const externalPath =
    "YCFgeyJzY3JpcHQiOm51bGwsInNjcmlwdFBhdGgiOiJjb20vZXhhbXBsZS93b3JrZmxvd3MvcG9zdGZ1bmN0aW9ucy9l" +
    "eGFtcGxlUG9zdEZ1bmN0aW9uLmdyb292eSJ9";
  const xml = `<workflow>
    <steps>
      <step id="1" name="Open">
        <meta name="jira.status.id">1</meta>
        <actions>
          <action id="11" name="Go">
            <results><unconditional-result step="1"/></results>
            <post-functions>
              <function type="class">
                <arg name="class.name">com.example.Foo</arg>
                <arg name="groovyExpression">${inlineScript}</arg>
                <arg name="scriptDescription">YCFgRXhhbXBsZSBGbGFnID0gWWVz</arg>
                <arg name="scriptPath">${externalPath}</arg>
                <arg name="plain">issue.summary == "x"</arg>
              </function>
            </post-functions>
          </action>
        </actions>
      </step>
    </steps>
  </workflow>`;
  const args = parseWorkflowXml(xml).steps[0].actions?.[0].postFunctions?.[0].args ?? {};
  assert.equal(
    args.groovyExpression,
    "issue.getCustomFieldValue(10001) && issue.getCustomFieldValue(10002)",
  );
  assert.equal(args.scriptDescription, "Example Flag = Yes");
  assert.equal(
    args.scriptPath,
    "scriptPath: com/example/workflows/postfunctions/examplePostFunction.groovy",
  );
  assert.equal(args.plain, 'issue.summary == "x"'); // non-blob values pass through
});
