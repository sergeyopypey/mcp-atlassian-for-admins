# Example Prompts for Jira DC MCP

A collection of real-world prompts organized by use case. Copy-paste these into
Claude (with the MCP connected) to get started.

---

## 1 · First Contact — Understand the Instance

```
Dump the global config and all schemes. Give me a high-level overview:
- How many projects, custom fields, workflows, and automation rules exist?
- Are there any obvious signs of sprawl (too many custom fields, duplicate workflows)?
- Summarize the scheme landscape — which scheme types have the most entries?
```

---

## 2 · Deep-Dive a Project

```
Get the full config chain for project CORE and analyze it.
For each issue type in the project, trace:
  issue type → workflow (from workflow scheme)
  issue type → screen scheme → create/edit/view screens (from ITSS)
  issue type → field configuration (from FC scheme)

Present this as a matrix table so I can see the full picture at a glance.
Flag anything that looks inconsistent or uses defaults where it shouldn't.
```

---

## 3 · Workflow Audit

```
Dump all workflows. For each one:
1. Are there any dead-end statuses (statuses with incoming transitions but no outgoing)?
2. Are there any orphan statuses (statuses with no transitions at all)?
3. Are there transitions that skip validation (no validators or conditions)?
4. Which workflows have more than 15 statuses? (complexity smell)
5. Which workflows allow transitioning backwards from a "Done" category status?

Present findings as a risk report with severity levels.
```

---

## 4 · Find Process Breaches

```
For project SALES:
1. Get the workflow for the "Task" issue type
2. Get the screen used when editing Tasks
3. Get the field configuration for Tasks

Now check:
- Are there required fields in the field config that DON'T appear on the edit screen?
  (This means users can't fill them in but they're required — a breach)
- Are there transitions that should require approval but have no conditions?
- Are there post-functions that auto-set fields that contradict the field config?
```

---

## 5 · Impact Analysis Before a Change

```
We want to add a new custom field "Customer Impact" (select list) to all Bug
screens across the entire instance.

1. Search for all screens that contain "Bug" in their name
2. For each, show me the current field layout
3. Which projects would be affected? (trace back: screen → screen scheme → ITSS → project)
4. Are there any field configurations where this field would be hidden or have
   conflicting settings?

Give me a step-by-step implementation plan with the exact API calls (screen IDs,
tab IDs) needed.
```

---

## 6 · Automation Conflict Detection

```
Dump all automation rules. Analyze them for:
1. Rules with the same trigger type that could fire simultaneously
2. Rules that modify the same field but set different values
3. Rules that are disabled but look like they should be active (based on naming)
4. Rules with no conditions (fire on everything — could be dangerous)
5. Global rules that overlap with project-specific rules

Present a conflict matrix showing which rules could interfere with each other.
```

---

## 7 · Permission Gap Analysis

```
List all permission schemes. For each one:
1. Which projects use it?
2. Does "Browse Projects" include any overly broad groups?
3. Can reporters edit or delete issues after resolution?
4. Is "Administer Projects" granted to non-admin roles?
5. Are there any schemes that grant "Move Issues" without "Edit Issues"?

Rank schemes by risk level (high/medium/low).
```

---

## 8 · Field Sprawl Cleanup

```
List all custom fields. Identify:
1. Fields that exist on zero screens (completely unused)
2. Fields with very similar names (potential duplicates)
3. Fields that are hidden in ALL field configurations (why do they exist?)
4. Fields of type "Text Field (multi-line)" — are any of these actually used for
   structured data and should be select lists instead?
5. Groups of fields that always appear together on screens (candidates for a
   single structured field or field context)

Give me a consolidation plan sorted by impact (most benefit, least risk first).
```

---

## 9 · Notification Noise Audit

```
Get all notification schemes. For each:
1. Count total notification events × recipient types = total notification paths
2. Flag events that notify more than 3 recipient types (noise risk)
3. Flag "All Watchers" + "Current Assignee" + "Reporter" on the same event
   (likely duplicate notifications)
4. Are there events with zero notifications? (gap)

Suggest an optimized notification scheme that reduces noise while maintaining
coverage.
```

---

## 10 · Migration Baseline

```
Dump the full instance config. I need this as a baseline before our DC-to-Cloud
migration. Organize the output as:

1. Global entities (fields, issue types, statuses, priorities, resolutions)
2. Per-project configs with full scheme chains
3. All workflows with transitions
4. All automation rules
5. Summary statistics

For each section, note any DC-specific features that won't have direct Cloud
equivalents (e.g., certain post-functions, custom field types).
```

---

## 11 · Validate a Business Requirement

```
Business requirement: "When a Critical Bug is moved to 'In Review', the team lead
must be auto-assigned, the priority must be locked, and a Slack notification must
be sent."

Check our current Jira config:
1. Does the Bug workflow have an "In Review" status? What transitions lead to it?
2. Is there an automation rule that handles assignment on transition?
3. Is there a validator or condition on the transition that checks priority?
4. Is there any A4J rule or post-function that sends Slack notifications?

Gap analysis: what's already in place vs. what needs to be built?
```

---

## 12 · Cross-Project Standardization Check

```
Compare the configs of projects CORE, SALES, and INFRA:
1. Do they use the same workflow scheme? If not, how do the workflows differ?
2. Do they use the same screen scheme? If not, which fields are missing/extra?
3. Do they use the same permission scheme?
4. Do they use the same field configuration?

Present a deviation matrix: for each config dimension, show which projects match
the "standard" (CORE) and which deviate, and how.
```

---

## 13 · Security Review

```
Perform a security review of our Jira configuration:
1. List all issue security schemes and their levels
2. Check permission schemes for overly permissive grants
3. Look for projects without issue security enabled
4. Find automation rules that modify security-relevant fields (assignee,
   reporter, security level)
5. Check if any screens expose security-level fields to unauthorized operations

Rate each finding: Critical / High / Medium / Low.
```

---

## 14 · Onboarding Documentation Generation

```
Generate process documentation for a new team member joining project CORE.

For each issue type they'll use (Bug, Task, Story):
1. What's the workflow? Describe each status and what it means
2. What fields do they see when creating an issue? Which are required?
3. What fields do they see when editing? Which are required?
4. What transitions are available from each status?
5. Are there any automation rules they should know about?

Write this as a friendly onboarding guide, not technical documentation.
```
