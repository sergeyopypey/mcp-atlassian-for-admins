"""Bulk dump tools — aggregate entire Jira instance config into structured JSON."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..client import JiraClient

logger = logging.getLogger(__name__)


async def _safe(coro, fallback=None, label: str = ""):
    """Run a coroutine and swallow errors so one failing endpoint doesn't kill the dump."""
    try:
        return await coro
    except Exception as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        logger.warning("dump: %s failed — %s (HTTP %s)", label, e, status or "N/A")
        return fallback if fallback is not None else []


def _compact_field(f: dict) -> dict:
    """Slim down a field dict for dump readability."""
    return {
        "id": f.get("id"),
        "name": f.get("name"),
        "custom": f.get("custom", False),
        "type": f.get("schema", {}).get("type") if f.get("schema") else None,
        "customType": f.get("schema", {}).get("custom") if f.get("schema") else None,
    }


# ======================================================================
# dump_global_config
# ======================================================================

async def dump_global_config(client: JiraClient) -> str:
    """Dump global Jira configuration: fields, issue types, statuses, resolutions,
    priorities, link types, server info."""

    server_info, fields, issue_types, statuses, resolutions, priorities, link_types = (
        await asyncio.gather(
            _safe(client.server_info(), {}, "serverInfo"),
            _safe(client.list_fields(), [], "fields"),
            _safe(client.list_issue_types(), [], "issueTypes"),
            _safe(client.list_statuses(), [], "statuses"),
            _safe(client.list_resolutions(), [], "resolutions"),
            _safe(client.list_priorities(), [], "priorities"),
            _safe(client.list_issue_link_types(), [], "linkTypes"),
        )
    )

    result = {
        "serverInfo": {
            "version": server_info.get("version"),
            "deploymentType": server_info.get("deploymentType"),
            "baseUrl": server_info.get("baseUrl"),
        },
        "issueTypes": [
            {"id": it["id"], "name": it["name"], "subtask": it.get("subtask", False),
             "description": it.get("description", "")}
            for it in issue_types
        ],
        "statuses": [
            {"id": s["id"], "name": s["name"],
             "category": s.get("statusCategory", {}).get("name")}
            for s in statuses
        ],
        "resolutions": [
            {"id": r["id"], "name": r["name"]} for r in resolutions
        ],
        "priorities": [
            {"id": p["id"], "name": p["name"]} for p in priorities
        ],
        "issueLinkTypes": [
            {"id": lt["id"], "name": lt["name"],
             "inward": lt.get("inward"), "outward": lt.get("outward")}
            for lt in link_types
        ],
        "fields": {
            "system": [_compact_field(f) for f in fields if not f.get("custom", False)],
            "custom": [_compact_field(f) for f in fields if f.get("custom", False)],
        },
        "fieldCount": {"system": sum(1 for f in fields if not f.get("custom")),
                       "custom": sum(1 for f in fields if f.get("custom"))},
    }
    return json.dumps(result, indent=2)


# ======================================================================
# dump_all_schemes
# ======================================================================

async def dump_all_schemes(client: JiraClient) -> str:
    """Dump every scheme type with associations."""

    (
        wf_schemes, it_schemes,
        screens_list,
        perm_schemes, notif_schemes,
        sec_schemes, prio_schemes,
    ) = await asyncio.gather(
        _safe(client.list_workflow_schemes(), [], "workflowSchemes"),
        _safe(client.list_issue_type_schemes(), [], "issueTypeSchemes"),
        _safe(client.list_screens(), [], "screens"),
        _safe(client.list_permission_schemes(), [], "permissionSchemes"),
        _safe(client.list_notification_schemes(), [], "notificationSchemes"),
        _safe(client.list_issue_security_schemes(), [], "securitySchemes"),
        _safe(client.list_priority_schemes(), [], "prioritySchemes"),
    )

    result = {
        "workflowSchemes": [
            {"id": s.get("id"), "name": s.get("name"), "description": s.get("description"),
             "defaultWorkflow": s.get("defaultWorkflow"),
             "issueTypeMappings": s.get("issueTypeMappings", {})}
            for s in wf_schemes
        ],
        "issueTypeSchemes": [
            {"id": s.get("id"), "name": s.get("name"), "description": s.get("description", "")}
            for s in it_schemes
        ],
        "screens": {
            "count": len(screens_list),
            "note": "Use list_screens and get_screen_tabs_and_fields for details",
        },
        "permissionSchemes": [
            {"id": s.get("id"), "name": s.get("name"),
             "grantCount": len(s.get("permissions", []))}
            for s in perm_schemes
        ],
        "notificationSchemes": [
            {"id": s.get("id"), "name": s.get("name")}
            for s in notif_schemes
        ],
        "issueSecuritySchemes": [
            {"id": s.get("id"), "name": s.get("name")}
            for s in sec_schemes
        ],
        "prioritySchemes": [
            {"id": s.get("id"), "name": s.get("name")}
            for s in prio_schemes
        ],
        "unavailableOnDC10": [
            "screenSchemes", "issueTypeScreenSchemes",
            "fieldConfigurations", "fieldConfigurationSchemes",
        ],
    }
    return json.dumps(result, indent=2)


# ======================================================================
# dump_workflows
# ======================================================================

async def dump_workflows(client: JiraClient) -> str:
    """Dump all workflows with statuses and transitions."""
    workflows = await _safe(client.list_workflows(), [], "workflows")

    result = []
    for wf in workflows:
        entry: dict[str, Any] = {
            "name": wf.get("name") or wf.get("id", {}).get("name"),
            "description": wf.get("description", ""),
            "isDefault": wf.get("isDefault", False),
        }

        # DC 10 workflow entity has "statuses" and "transitions" inline
        # or we may need to fetch them separately
        statuses = wf.get("statuses", [])
        transitions = wf.get("transitions", [])

        if not transitions and wf.get("id"):
            wf_id = wf["id"] if isinstance(wf["id"], (str, int)) else wf["id"].get("name", "")
            transitions = await _safe(
                client.get_workflow_transitions(wf_id), [], f"transitions({wf_id})"
            )

        entry["statuses"] = [
            {"id": s.get("id"), "name": s.get("name"),
             "category": s.get("statusCategory", {}).get("name") if isinstance(s.get("statusCategory"), dict) else None}
            for s in statuses
        ]
        entry["transitions"] = [
            {
                "id": t.get("id"),
                "name": t.get("name"),
                "from": t.get("from", t.get("sourceStatus", {}).get("name") if isinstance(t.get("sourceStatus"), dict) else None),
                "to": t.get("to", t.get("targetStatus", {}).get("name") if isinstance(t.get("targetStatus"), dict) else None),
                "hasConditions": bool(t.get("conditions")),
                "hasValidators": bool(t.get("validators")),
                "hasPostFunctions": bool(t.get("postFunctions")),
                "conditions": t.get("conditions"),
                "validators": t.get("validators"),
                "postFunctions": t.get("postFunctions"),
            }
            for t in transitions
        ]
        entry["statusCount"] = len(entry["statuses"])
        entry["transitionCount"] = len(entry["transitions"])
        result.append(entry)

    return json.dumps(result, indent=2)


# ======================================================================
# dump_automation_rules
# ======================================================================

async def dump_automation_rules(client: JiraClient, automation_cache=None) -> str:
    """Dump all A4J automation rules from the in-memory cache."""
    if automation_cache is not None:
        all_rules = await automation_cache.get_all_rules()
    else:
        # Fallback: direct fetch if cache not available
        all_rules = await _safe(client.export_automation_rules(), [], "a4j_export")

    result = [
        {
            "id": r.get("id"),
            "name": r.get("name"),
            "state": r.get("state", r.get("enabled")),
            "trigger": r.get("trigger"),
            "conditions": r.get("conditions"),
            "actions": r.get("actions") or r.get("components"),
            "created": r.get("created"),
            "updated": r.get("updated"),
        }
        for r in all_rules
    ]
    return json.dumps(result, indent=2)


# ======================================================================
# dump_full_instance (nuclear option)
# ======================================================================

async def dump_full_instance(client: JiraClient, automation_cache=None) -> str:
    """Dump absolutely everything into one massive JSON structure."""
    global_config, schemes, workflows, automation = await asyncio.gather(
        dump_global_config(client),
        dump_all_schemes(client),
        dump_workflows(client),
        dump_automation_rules(client, automation_cache),
    )

    # Also dump screens
    screens_raw = await _safe(client.list_screens(), [], "screens")
    screens = []
    for scr in screens_raw[:100]:  # cap at 100 to avoid massive payloads
        full = await _safe(
            client.get_screen_full(scr["id"]), {"screenId": scr["id"], "tabs": []},
            f"screen({scr['id']})",
        )
        full["name"] = scr.get("name")
        screens.append(full)

    # Dump projects with config
    from .projects import _get_project_config
    projects_raw = await _safe(client.list_projects(), [], "projects")
    projects = []
    for p in projects_raw:
        pconfig = await _safe(
            _get_project_config(client, p["key"]),
            {"key": p["key"], "error": "failed"},
            f"projectConfig({p['key']})",
        )
        projects.append(pconfig)

    result = {
        "global": json.loads(global_config),
        "schemes": json.loads(schemes),
        "workflows": json.loads(workflows),
        "automation": json.loads(automation),
        "screens": screens,
        "projects": projects,
    }
    return json.dumps(result, indent=2)
