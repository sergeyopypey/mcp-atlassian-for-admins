"""Workflow introspection tools."""

from __future__ import annotations

import asyncio
import json
import logging
import xml.etree.ElementTree as ET

from ..client import JiraClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# XML workflow parsing helpers
# ---------------------------------------------------------------------------

def _parse_workflow_xml(xml_str: str) -> dict:
    """Parse OpenSymphony workflow XML into a structured dict with full detail."""
    root = ET.fromstring(xml_str)

    # Parse meta (global info)
    meta = {}
    for m in root.findall("meta"):
        meta[m.get("name", "")] = m.text or ""

    # Parse common-actions (global transitions)
    global_action_ids: set[int] = set()
    for ga in root.findall(".//common-actions/action"):
        aid = ga.get("id")
        if aid:
            global_action_ids.add(int(aid))

    # Parse steps (statuses)
    steps = []
    step_map: dict[int, str] = {}  # step id → step name
    for step in root.findall(".//step"):
        step_id = int(step.get("id", 0))
        step_name = step.get("name", "")
        step_map[step_id] = step_name

        step_meta = {}
        for m in step.findall("meta"):
            step_meta[m.get("name", "")] = m.text or ""

        step_entry = {
            "id": step_id,
            "name": step_name,
            "statusId": step_meta.get("jira.status.id"),
        }

        # Parse step actions (transitions from this step)
        actions = []
        for action in step.findall(".//action"):
            actions.append(_parse_action(action, step_name, step_map))
        if actions:
            step_entry["actions"] = actions

        steps.append(step_entry)

    # Parse initial-actions (create transitions)
    initial_actions = []
    for action in root.findall(".//initial-actions/action"):
        initial_actions.append(_parse_action(action, "(initial)", step_map))

    # Parse common-actions
    common_actions = []
    for action in root.findall(".//common-actions/action"):
        common_actions.append(_parse_action(action, "(global)", step_map))

    # Parse global-actions
    for action in root.findall(".//global-actions/action"):
        common_actions.append(_parse_action(action, "(global)", step_map))

    result: dict = {
        "steps": steps,
    }
    if initial_actions:
        result["initialActions"] = initial_actions
    if common_actions:
        result["globalActions"] = common_actions

    return result


def _parse_action(action_el: ET.Element, from_step: str, step_map: dict[int, str]) -> dict:
    """Parse a single action (transition) element."""
    action_id = int(action_el.get("id", 0))
    action_name = action_el.get("name", "")

    # Determine target step
    results = action_el.findall(".//unconditional-result") + action_el.findall(".//default-result")
    target_step = None
    target_status = None
    for r in results:
        step_id = r.get("step")
        if step_id:
            step_id_int = int(step_id)
            target_step = step_id_int
            target_status = step_map.get(step_id_int, f"step-{step_id}")
            break

    action_meta = {}
    for m in action_el.findall("meta"):
        action_meta[m.get("name", "")] = m.text or ""

    entry: dict = {
        "id": action_id,
        "name": action_name,
        "from": from_step,
        "to": target_status,
    }

    if action_meta.get("jira.fieldscreen.id"):
        entry["screenId"] = action_meta["jira.fieldscreen.id"]

    # Parse conditions
    conditions = _parse_conditions(action_el.find("restrict-to"))
    if conditions:
        entry["conditions"] = conditions

    # Parse validators
    validators = _parse_functions(action_el, "validators/validator")
    if validators:
        entry["validators"] = validators

    # Parse pre-functions
    pre_functions = _parse_functions(action_el, "pre-functions/function")
    if pre_functions:
        entry["preFunctions"] = pre_functions

    # Parse post-functions
    post_functions = _parse_functions(action_el, "post-functions/function")
    if post_functions:
        entry["postFunctions"] = post_functions

    return entry


def _parse_conditions(restrict_el: ET.Element | None) -> list | dict | None:
    """Parse restrict-to/conditions block recursively."""
    if restrict_el is None:
        return None

    conditions_el = restrict_el.find("conditions")
    if conditions_el is None:
        return None

    return _parse_condition_block(conditions_el)


def _parse_condition_block(cond_el: ET.Element) -> dict | list | None:
    """Recursively parse a conditions block (can be AND/OR with nesting)."""
    cond_type = cond_el.get("type", "AND")

    items = []

    # Direct condition children
    for c in cond_el.findall("condition"):
        func_type = c.get("type", "")
        negate = c.get("negate", "false").lower() == "true"
        args = {}
        for arg in c.findall("arg"):
            args[arg.get("name", "")] = arg.text or ""

        condition_entry: dict = {
            "type": _simplify_class(args.pop("class.name", func_type)),
        }
        if negate:
            condition_entry["negate"] = True
        if args:
            condition_entry["args"] = args
        items.append(condition_entry)

    # Nested conditions blocks
    for nested in cond_el.findall("conditions"):
        nested_parsed = _parse_condition_block(nested)
        if nested_parsed:
            items.append(nested_parsed)

    if not items:
        return None
    if len(items) == 1:
        return items[0]

    return {"operator": cond_type, "items": items}


def _parse_functions(parent: ET.Element, path: str) -> list[dict]:
    """Parse validator or function elements."""
    result = []
    for func in parent.findall(f".//{path}"):
        func_type = func.get("type", "")
        args = {}
        for arg in func.findall("arg"):
            args[arg.get("name", "")] = arg.text or ""

        class_name = args.pop("class.name", func_type)
        entry: dict = {"type": _simplify_class(class_name)}
        if args:
            # Clean up common noise args
            args.pop("full.module.key", None)
            if args:
                entry["args"] = args
        result.append(entry)
    return result


def _simplify_class(class_name: str) -> str:
    """Simplify Java class names to readable short names."""
    # Map of known Jira/plugin class names to human-readable labels
    known = {
        "com.atlassian.jira.workflow.condition.AllowOnlyAssignee": "OnlyAssignee",
        "com.atlassian.jira.workflow.condition.AllowOnlyReporter": "OnlyReporter",
        "com.atlassian.jira.workflow.condition.PermissionCondition": "HasPermission",
        "com.atlassian.jira.workflow.condition.SubTaskBlockingCondition": "SubTaskBlocking",
        "com.atlassian.jira.workflow.function.issue.UpdateIssueStatusFunction": "UpdateStatus",
        "com.atlassian.jira.workflow.function.issue.UpdateIssueFieldFunction": "UpdateField",
        "com.atlassian.jira.workflow.function.issue.AssignToCurrentUserFunction": "AssignToCurrentUser",
        "com.atlassian.jira.workflow.function.issue.AssignToLeadFunction": "AssignToLead",
        "com.atlassian.jira.workflow.function.issue.AssignToReporterFunction": "AssignToReporter",
        "com.atlassian.jira.workflow.function.misc.CreateCommentFunction": "CreateComment",
        "com.atlassian.jira.workflow.function.event.FireIssueEventFunction": "FireEvent",
        "com.atlassian.jira.workflow.function.issue.GenerateChangeHistoryFunction": "GenerateChangeHistory",
        "com.atlassian.jira.workflow.function.issue.IssueReindexFunction": "ReindexIssue",
        "com.atlassian.jira.workflow.function.issue.IssueCreateFunction": "CreateIssue",
        "com.atlassian.jira.workflow.function.issue.IssueStoreFunction": "StoreIssue",
        "com.atlassian.jira.workflow.validator.PermissionValidator": "PermissionValidator",
        "com.atlassian.jira.workflow.validator.UserPermissionValidator": "UserPermissionValidator",
        "com.atlassian.jira.workflow.validator.FieldRequiredValidator": "FieldRequired",
        "com.atlassian.servicedesk.plugins.automation.action.AutomationRuleInvokerFunction": "JSM_AutomationInvoker",
        "com.atlassian.servicedesk.internal.feature.approval.ApprovalFunction": "JSM_Approval",
    }
    if class_name in known:
        return known[class_name]
    # Fall back to last segment of class name
    if "." in class_name:
        return class_name.rsplit(".", 1)[-1]
    return class_name


async def list_workflows(client: JiraClient) -> str:
    """List all workflows with summary stats."""
    workflows = await client.list_workflows()
    result = []
    for wf in workflows:
        name = wf.get("name") or (wf.get("id", {}).get("name") if isinstance(wf.get("id"), dict) else wf.get("id"))
        result.append({
            "name": name,
            "description": wf.get("description", ""),
            "isDefault": wf.get("isDefault", wf.get("default", False)),
            "steps": wf.get("steps"),
            "statusCount": len(wf.get("statuses", [])),
            "transitionCount": len(wf.get("transitions", [])),
        })
    return json.dumps(result, indent=2)


async def get_workflow_detail(client: JiraClient, workflow_name: str) -> str:
    """Get full workflow detail: statuses, transitions with conditions/validators/post-functions.

    Uses the ScriptRunner XML export endpoint for rich detail (actual condition/validator/
    post-function class names and arguments). Falls back to REST API if unavailable.
    """
    # Try ScriptRunner XML export first
    xml_str = await client.export_workflow_xml(workflow_name)
    if xml_str:
        try:
            parsed = _parse_workflow_xml(xml_str)
            parsed["name"] = workflow_name
            parsed["source"] = "scriptrunner-xml"
            return json.dumps(parsed, indent=2)
        except ET.ParseError as e:
            logger.warning("Failed to parse workflow XML for '%s': %s", workflow_name, e)

    # Fallback to REST API
    wf = await client.get_workflow_by_name(workflow_name)
    if not wf:
        return json.dumps({"error": f"Workflow '{workflow_name}' not found"})

    statuses = wf.get("statuses", [])
    transitions = wf.get("transitions", [])

    if not transitions and wf.get("id"):
        wf_id = wf["id"] if isinstance(wf["id"], (str, int)) else wf["id"].get("name", "")
        try:
            transitions = await client.get_workflow_transitions(wf_id)
        except Exception:
            pass

    result = {
        "name": workflow_name,
        "description": wf.get("description", ""),
        "isDefault": wf.get("isDefault", False),
        "source": "rest-api",
        "statuses": [
            {
                "id": s.get("id"),
                "name": s.get("name"),
                "category": s.get("statusCategory", {}).get("name")
                if isinstance(s.get("statusCategory"), dict) else None,
            }
            for s in statuses
        ],
        "transitions": [
            {
                "id": t.get("id"),
                "name": t.get("name"),
                "from": _extract_status_ref(t, "from", "sourceStatus"),
                "to": _extract_status_ref(t, "to", "targetStatus"),
                "conditions": t.get("conditions"),
                "validators": t.get("validators"),
                "postFunctions": t.get("postFunctions"),
                "properties": t.get("properties"),
            }
            for t in transitions
        ],
    }
    return json.dumps(result, indent=2)


def _extract_status_ref(t: dict, key1: str, key2: str):
    """Extract status name from transition — handles different DC 10 response shapes."""
    val = t.get(key1)
    if val and isinstance(val, dict):
        return val.get("name") or val.get("id")
    if val:
        return val
    alt = t.get(key2)
    if isinstance(alt, dict):
        return alt.get("name") or alt.get("id")
    return alt


async def list_workflow_schemes(client: JiraClient) -> str:
    """List all workflow schemes."""
    schemes = await client.list_workflow_schemes()
    result = [
        {
            "id": s.get("id"),
            "name": s.get("name"),
            "description": s.get("description", ""),
            "defaultWorkflow": s.get("defaultWorkflow"),
            "issueTypeMappings": s.get("issueTypeMappings", {}),
        }
        for s in schemes
    ]
    return json.dumps(result, indent=2)


async def get_workflow_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get a workflow scheme with full issue-type-to-workflow mappings."""
    scheme = await client.get_workflow_scheme(scheme_id)
    return json.dumps(scheme, indent=2)


async def get_workflow_statuses_and_transitions(client: JiraClient, workflow_name: str) -> str:
    """Get full workflow detail via the Workflow Designer API.

    Returns all statuses with Jira status IDs and status categories,
    all transitions with source/target, transition screens (with tab/field
    details), and rule counts (conditions, validators, post-functions).
    Also detects JSM approval patterns (Waiting for approval status
    with Approved/Declined transitions).
    """
    designer = await client.get_workflow_designer(workflow_name)
    if not designer:
        return json.dumps({"error": f"Workflow '{workflow_name}' not found or workflowDesigner plugin unavailable"})

    layout = designer.get("layout", {})
    raw_statuses = layout.get("statuses", [])
    raw_transitions = layout.get("transitions", [])

    # Build internal ID → status info map
    id_map: dict[str, dict] = {}
    for s in raw_statuses:
        sid = s.get("id")
        id_map[sid] = {
            "name": s.get("name", "?"),
            "statusId": s.get("statusId"),
            "initial": s.get("initial", False),
        }

    # Resolve status categories by fetching Jira status metadata
    status_ids = [str(s.get("statusId")) for s in raw_statuses if s.get("statusId")]
    status_category_map: dict[str, str] = {}
    if status_ids:
        try:
            all_statuses = await client.list_statuses()
            for st in all_statuses:
                cat = st.get("statusCategory", {}).get("name") if isinstance(st.get("statusCategory"), dict) else None
                status_category_map[str(st["id"])] = cat
        except Exception:
            pass

    # Build statuses output
    statuses_out = []
    for s in raw_statuses:
        if s.get("initial") and not s.get("statusId"):
            continue  # skip the virtual "Create" node
        status_id = s.get("statusId")
        statuses_out.append({
            "name": s.get("name"),
            "statusId": status_id,
            "category": status_category_map.get(str(status_id)) if status_id else None,
            "initial": s.get("initial", False),
        })

    # Collect screen IDs referenced by transitions (for batch fetch)
    screen_ids: set[int] = set()
    for t in raw_transitions:
        scr_id = t.get("screenId")
        if scr_id:
            screen_ids.add(int(scr_id))

    # Build screen ID → name map from transitions
    screen_name_map: dict[int, str] = {}
    for t in raw_transitions:
        scr_id = t.get("screenId")
        scr_name = t.get("screenName")
        if scr_id and scr_name:
            screen_name_map[int(scr_id)] = scr_name

    # Batch-fetch screen details (tabs + fields)
    screen_details: dict[int, dict] = {}
    for scr_id in screen_ids:
        try:
            full = await client.get_screen_full(scr_id)
            tabs = []
            for tab in full.get("tabs", []):
                tabs.append({
                    "name": tab.get("name"),
                    "fields": [
                        {"id": f.get("id"), "name": f.get("name")}
                        for f in tab.get("fields", [])
                    ],
                })
            screen_details[scr_id] = {
                "name": screen_name_map.get(scr_id, f"Screen {scr_id}"),
                "tabs": tabs,
            }
        except Exception as e:
            logger.warning("Failed to fetch screen %s: %s", scr_id, e)

    # Detect JSM approval pattern
    approval_statuses = set()
    approval_transitions = {}
    for s in raw_statuses:
        name_lower = (s.get("name") or "").lower()
        if "approv" in name_lower or "waiting for approval" in name_lower:
            approval_statuses.add(s.get("id"))
    for t in raw_transitions:
        if t.get("sourceId") in approval_statuses:
            name_lower = (t.get("name") or "").lower()
            if "approv" in name_lower or "declin" in name_lower or "reject" in name_lower:
                approval_transitions[t.get("id")] = t.get("name")

    # Build transitions output
    transitions_out = []
    for t in raw_transitions:
        src_info = id_map.get(t.get("sourceId"), {})
        tgt_info = id_map.get(t.get("targetId"), {})

        # Extract rule counts from transitionOptions
        conditions_count = 0
        validators_count = 0
        postfunctions_count = 0
        for opt in t.get("transitionOptions", []):
            key = opt.get("key", "")
            if "conditions" in key:
                conditions_count = opt.get("count", 0)
            elif "validators" in key:
                validators_count = opt.get("count", 0)
            elif "postfunctions" in key:
                postfunctions_count = opt.get("count", 0)

        transition_entry: dict = {
            "name": t.get("name"),
            "actionId": t.get("actionId"),
            "from": src_info.get("name", t.get("sourceId")),
            "to": tgt_info.get("name", t.get("targetId")),
            "global": t.get("globalTransition", False),
            "rules": {
                "conditions": conditions_count,
                "validators": validators_count,
                "postFunctions": postfunctions_count,
            },
        }

        # Add screen details if present
        scr_id = t.get("screenId")
        if scr_id and int(scr_id) in screen_details:
            transition_entry["screen"] = screen_details[int(scr_id)]
        elif t.get("screenName"):
            transition_entry["screen"] = {"name": t.get("screenName"), "id": scr_id}

        # Flag JSM approval transitions
        if t.get("id") in approval_transitions:
            transition_entry["jsmApproval"] = True

        transitions_out.append(transition_entry)

    # Build JSM approval summary if detected
    jsm_approval = None
    if approval_statuses:
        approval_status_names = [
            id_map[sid]["name"] for sid in approval_statuses if sid in id_map
        ]
        jsm_approval = {
            "detected": True,
            "approvalStatuses": approval_status_names,
            "approvalTransitions": list(approval_transitions.values()),
        }

    result = {
        "name": workflow_name,
        "description": designer.get("description", ""),
        "statusCount": len(statuses_out),
        "transitionCount": len(transitions_out),
        "statuses": statuses_out,
        "transitions": transitions_out,
    }
    if jsm_approval:
        result["jsmApproval"] = jsm_approval

    return json.dumps(result, indent=2)
