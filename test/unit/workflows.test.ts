/** Unit tests for get_workflow and search_workflow_rules against a stub client. Run: `npm test`. */

import test from "node:test";
import assert from "node:assert/strict";

import { workflowTools } from "../../src/tools/workflows.js";

// Two steps sharing common action 21; the create transition carries a script.
const XML = `<workflow>
  <meta name="jira.description">Example flow</meta>
  <initial-actions>
    <action id="1" name="Create">
      <validators>
        <validator type="class">
          <arg name="class.name">com.example.plugin.RequiredValidator</arg>
          <arg name="fieldKey">customfield_10001</arg>
        </validator>
      </validators>
      <results>
        <unconditional-result step="1">
          <post-functions>
            <function type="class">
              <arg name="class.name">com.atlassian.jira.workflow.function.issue.IssueCreateFunction</arg>
            </function>
            <function type="class">
              <arg name="class.name">com.example.plugin.ScriptFunction</arg>
              <arg name="script">issue.setCustomFieldValue(customfield_10001, 1)</arg>
            </function>
          </post-functions>
        </unconditional-result>
      </results>
    </action>
  </initial-actions>
  <common-actions>
    <action id="21" name="Hold">
      <meta name="jira.fieldscreen.id">10</meta>
      <restrict-to>
        <conditions type="AND">
          <condition type="class">
            <arg name="class.name">com.atlassian.jira.workflow.condition.AllowOnlyAssignee</arg>
          </condition>
          <condition type="class">
            <arg name="class.name">com.atlassian.jira.workflow.condition.AllowOnlyReporter</arg>
          </condition>
        </conditions>
      </restrict-to>
      <results><unconditional-result step="2"/></results>
    </action>
  </common-actions>
  <steps>
    <step id="1" name="Open">
      <meta name="jira.status.id">1</meta>
      <meta name="jira.permission.worklog.denied">denied</meta>
      <actions><common-action id="21"/></actions>
    </step>
    <step id="2" name="On Hold">
      <meta name="jira.status.id">2</meta>
      <actions><common-action id="21"/></actions>
    </step>
  </steps>
</workflow>`;

const client = {
  exportWorkflowXml: async () => XML,
  listWorkflows: async () => [{ name: "Example" }, { name: "Other" }],
  listStatuses: async () => [
    { id: "1", statusCategory: { name: "To Do" } },
    { id: "2", statusCategory: { name: "In Progress" } },
  ],
  listScreens: async () => [{ id: 10, name: "Hold Screen" }],
};

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const tool = workflowTools.find((t) => t.name === name)!;
  return JSON.parse(await tool.handler({ client } as any, args));
}

test("get_workflow without transition_ids returns structure and rule counts", async () => {
  const wf = await call("get_workflow", { workflow_name: "Example" });
  assert.equal(wf.description, "Example flow");
  assert.equal(wf.meta, undefined);
  assert.deepEqual(wf.statuses[0], {
    stepId: 1,
    statusId: "1",
    name: "Open",
    category: "To Do",
    meta: { "jira.permission.worklog.denied": "denied" },
  });
  assert.equal(wf.transitions.length, 2); // common action 21 listed once
  const hold = wf.transitions.find((t: any) => t.id === 21);
  assert.deepEqual(hold.from, ["Open", "On Hold"]);
  assert.deepEqual(hold.screen, { id: "10", name: "Hold Screen" });
  assert.deepEqual(hold.rules, { conditions: 2 });
  assert.equal(hold.conditions, undefined);
  const create = wf.transitions.find((t: any) => t.id === 1);
  assert.deepEqual(create.from, ["(initial)"]);
  assert.deepEqual(create.rules, { validators: 1, postFunctions: 2 });
});

test("get_workflow with transition_ids returns full rules for those only", async () => {
  const wf = await call("get_workflow", { workflow_name: "Example", transition_ids: [1, 99] });
  const create = wf.transitions.find((t: any) => t.id === 1);
  assert.equal(create.rules, undefined);
  assert.deepEqual(create.postFunctions.map((f: any) => f.type), ["CreateIssue", "ScriptFunction"]);
  assert.equal(create.postFunctions[1].className, "com.example.plugin.ScriptFunction");
  assert.ok(wf.transitions.find((t: any) => t.id === 21).rules);
  assert.deepEqual(wf.notFound, [99]);

  const all = await call("get_workflow", { workflow_name: "Example", transition_ids: "all" });
  assert.equal(all.transitions.find((t: any) => t.id === 21).conditions.operator, "AND");
});

test("search_workflow_rules finds rule args and status meta with their position", async () => {
  const res = await call("search_workflow_rules", {
    query: "CUSTOMFIELD_10001",
    name_contains: "example",
  });
  assert.equal(res.workflowsScanned, 1);
  assert.equal(res.matchCount, 2);
  assert.deepEqual(
    res.matches.map((m: any) => [m.kind, m.position, m.transitionId, m.matches[0].field]),
    [
      ["validator", 1, 1, "args.fieldKey"],
      ["postFunction", 2, 1, "args.script"],
    ],
  );

  const meta = await call("search_workflow_rules", { query: "worklog" });
  assert.equal(meta.workflowsScanned, 2);
  assert.deepEqual(
    meta.matches.map((m: any) => [m.workflow, m.kind, m.status]),
    [
      ["Example", "statusMeta", "Open"],
      ["Other", "statusMeta", "Open"],
    ],
  );
});
