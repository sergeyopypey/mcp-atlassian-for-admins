"""Cross-cutting analysis tools — config chain resolution, search, consistency checks."""

from __future__ import annotations

import json
from typing import Any

from ..client import JiraClient
from .projects import _get_project_config


async def analyze_project_config_chain(client: JiraClient, project_key: str) -> str:
    """Resolve the full scheme chain for a project and report potential issues.

    Chain: Project → IssueTypeScheme → (per issue type) →
           WorkflowScheme → Workflow
           IssueTypeScreenScheme → ScreenScheme → Screen (create/edit/view)
           FieldConfigScheme → FieldConfiguration
    """
    config = await _get_project_config(client, project_key)
    issues: list[str] = []
    warnings: list[str] = []

    # ---- Issue types ----
    issue_types = config.get("issueTypes", [])
    if not issue_types:
        issues.append("Project has no issue types configured")

    # ---- Workflow scheme ----
    wf_scheme = config.get("schemes", {}).get("workflowScheme", {})
    wf_mappings = wf_scheme.get("issueTypeMappings", {})
    default_wf = wf_scheme.get("defaultWorkflow")

    for it in issue_types:
        it_id = it["id"]
        assigned_wf = wf_mappings.get(it_id, default_wf)
        if not assigned_wf:
            issues.append(f"Issue type '{it['name']}' (id={it_id}) has no workflow mapped")

    # ---- ITSS chain ----
    itss = config.get("schemes", {}).get("issueTypeScreenScheme", {})
    if not itss.get("id"):
        warnings.append("Project uses default issue type screen scheme")

    # ---- Field config scheme ----
    fcs = config.get("schemes", {}).get("fieldConfigurationScheme", {})
    if not fcs.get("id"):
        warnings.append("Project uses default field configuration scheme (all fields use default config)")

    # Build resolved chain summary
    chain: dict[str, Any] = {
        "project": {"key": config["key"], "name": config["name"]},
        "issueTypes": issue_types,
        "workflowScheme": wf_scheme,
        "issueTypeScreenScheme": itss,
        "fieldConfigurationScheme": fcs,
        "issues": issues,
        "warnings": warnings,
    }

    # Try to resolve deeper — screens per issue type
    if itss.get("id"):
        try:
            itss_items = await client.get_issue_type_screen_scheme_items([itss["id"]])
            screen_scheme_ids: set[int] = set()
            for item in itss_items:
                ssid = item.get("screenSchemeId")
                if ssid:
                    screen_scheme_ids.add(int(ssid))

            chain["resolvedScreenSchemes"] = []
            for ssid in screen_scheme_ids:
                try:
                    ss = await client.get_screen_scheme(ssid)
                    chain["resolvedScreenSchemes"].append(ss)
                except Exception:
                    chain["resolvedScreenSchemes"].append({"id": ssid, "error": "failed to fetch"})
        except Exception:
            pass

    return json.dumps(chain, indent=2)


async def search_config(client: JiraClient, query: str) -> str:
    """Free-text search across all config entities (workflows, fields, screens, schemes).

    Searches names and descriptions case-insensitively.
    """
    import asyncio

    q = query.lower()
    hits: list[dict] = []

    async def _safe(coro, label):
        try:
            return await coro
        except Exception:
            return []

    fields, screens, workflows, wf_schemes, it_schemes, perm_schemes = await asyncio.gather(
        _safe(client.list_fields(), "fields"),
        _safe(client.list_screens(), "screens"),
        _safe(client.list_workflows(), "workflows"),
        _safe(client.list_workflow_schemes(), "workflowSchemes"),
        _safe(client.list_issue_type_schemes(), "issueTypeSchemes"),
        _safe(client.list_permission_schemes(), "permissionSchemes"),
    )

    for f in fields:
        if q in (f.get("name", "") or "").lower() or q in (f.get("id", "") or "").lower():
            hits.append({"type": "field", "id": f["id"], "name": f["name"], "custom": f.get("custom")})

    for s in screens:
        if q in (s.get("name", "") or "").lower():
            hits.append({"type": "screen", "id": s["id"], "name": s["name"]})

    for w in workflows:
        name = w.get("name") or (w.get("id", {}).get("name") if isinstance(w.get("id"), dict) else "")
        if q in (name or "").lower() or q in (w.get("description", "") or "").lower():
            hits.append({"type": "workflow", "name": name})

    for ws in wf_schemes:
        if q in (ws.get("name", "") or "").lower():
            hits.append({"type": "workflowScheme", "id": ws["id"], "name": ws["name"]})

    for its in it_schemes:
        if q in (its.get("name", "") or "").lower():
            hits.append({"type": "issueTypeScheme", "id": its["id"], "name": its["name"]})

    for ps in perm_schemes:
        if q in (ps.get("name", "") or "").lower():
            hits.append({"type": "permissionScheme", "id": ps["id"], "name": ps["name"]})

    return json.dumps({"query": query, "hits": hits, "count": len(hits)}, indent=2)
