"""Field and field configuration tools."""

from __future__ import annotations

import json
import logging

from ..client import JiraClient, bounded_gather

logger = logging.getLogger(__name__)


async def list_fields(client: JiraClient, custom_only: bool = False, field_ids: list[str] | None = None) -> str:
    """List all fields (system + custom), optionally filtered to custom only or by specific IDs."""
    fields = await client.list_fields()
    if field_ids:
        id_set = set(field_ids)
        fields = [f for f in fields if f.get("id") in id_set]
    elif custom_only:
        fields = [f for f in fields if f.get("custom", False)]

    result = [
        {
            "id": f.get("id"),
            "name": f.get("name"),
            "custom": f.get("custom", False),
            "type": f.get("schema", {}).get("type") if f.get("schema") else None,
            "customType": f.get("schema", {}).get("custom") if f.get("schema") else None,
            "searchable": f.get("searchable"),
            "clauseNames": f.get("clauseNames", []),
        }
        for f in fields
    ]
    return json.dumps(result, indent=2)


async def get_field_configuration(client: JiraClient, fc_id: int) -> str:
    """Get field configuration items — required, hidden, renderer, description per field.

    Served by the jiraMcpFieldConfigurations ScriptRunner endpoint; the native
    /rest/api/2/fieldconfiguration endpoint 404s on Jira DC.
    """
    fc_list = await client.list_field_configurations()
    fc = next((c for c in fc_list if c.get("id") == fc_id), None)
    if fc is None:
        return json.dumps({"error": f"Field configuration {fc_id} not found"})

    result = {
        "fieldConfigurationId": fc.get("id"),
        "name": fc.get("name"),
        "description": fc.get("description", ""),
        "isDefault": fc.get("isDefault", False),
        "fields": [
            {
                "fieldId": item.get("fieldId"),
                "fieldName": item.get("fieldName"),
                "description": item.get("description", ""),
                "isRequired": item.get("isRequired", False),
                "isHidden": item.get("isHidden", False),
                "renderer": item.get("rendererType"),
            }
            for item in fc.get("fields", [])
        ],
    }
    return json.dumps(result, indent=2)


async def get_field_configuration_scheme(client: JiraClient, scheme_id: int) -> str:
    """Get field configuration scheme — maps issue types to field configurations.

    Served by the jiraMcpFieldConfigurationSchemes ScriptRunner endpoint; the
    native /rest/api/2/fieldconfigurationscheme endpoint 404s on Jira DC.
    """
    schemes = await client.list_field_configuration_schemes()
    scheme = next((s for s in schemes if s.get("id") == scheme_id), None)
    if scheme is None:
        return json.dumps({"error": f"Field configuration scheme {scheme_id} not found"})

    result = {
        "id": scheme.get("id"),
        "name": scheme.get("name"),
        "description": scheme.get("description", ""),
        "mappings": [
            {
                "issueTypeId": m.get("issueTypeId"),
                "issueTypeName": m.get("issueTypeName"),
                "fieldConfigurationId": m.get("fieldConfigId"),
                "fieldConfigurationName": m.get("fieldConfigName"),
            }
            for m in scheme.get("mappings", [])
        ],
        "projects": scheme.get("projects", []),
    }
    return json.dumps(result, indent=2)


async def find_field_usage(client: JiraClient, field_id: str) -> str:
    """Find where a field appears across all screens and field configurations."""
    # Search screens — fanned out with bounded concurrency (one fetch per screen).
    screens = await client.list_screens()

    async def _scan_screen(scr: dict) -> list[dict]:
        hits: list[dict] = []
        try:
            full = await client.get_screen_full(scr["id"])
        except Exception:
            return hits
        for tab in full.get("tabs", []):
            for f in tab.get("fields", []):
                if f.get("id") == field_id:
                    hits.append({
                        "screenId": scr["id"],
                        "screenName": scr.get("name"),
                        "tabId": tab.get("id"),
                        "tabName": tab.get("name"),
                    })
        return hits

    per_screen = await bounded_gather([_scan_screen(scr) for scr in screens])
    screen_hits = [hit for hits in per_screen for hit in hits]

    # Search field configurations (jiraMcpFieldConfigurations ScriptRunner endpoint;
    # each config embeds its field items, so no per-config calls are needed).
    fc_list = await client.list_field_configurations()
    fc_hits = []
    for fc in fc_list:
        for item in fc.get("fields", []):
            if item.get("fieldId") == field_id:
                fc_hits.append({
                    "fieldConfigId": fc.get("id"),
                    "fieldConfigName": fc.get("name"),
                    "isRequired": item.get("isRequired", False),
                    "isHidden": item.get("isHidden", False),
                })

    result = {
        "fieldId": field_id,
        "screens": screen_hits,
        "fieldConfigurations": fc_hits,
        "totalScreens": len(screen_hits),
        "totalFieldConfigs": len(fc_hits),
    }
    return json.dumps(result, indent=2)


async def get_createmeta_fields(
    client: JiraClient, project_key: str, issue_type_id: str
) -> str:
    """Get fields available on the CREATE screen for a project + issue type.

    Shows field name, required flag, allowed values (for select/radio/checkbox fields),
    and default values. Essential for understanding what an automation rule must set
    when creating an issue.
    """
    raw = await client.get_createmeta_fields(project_key, issue_type_id)
    result = []
    for f in raw:
        entry: dict = {
            "fieldId": f.get("fieldId"),
            "name": f.get("name"),
            "required": f.get("required", False),
            "schema": f.get("schema"),
            "hasDefaultValue": f.get("hasDefaultValue", False),
        }
        if f.get("allowedValues"):
            entry["allowedValues"] = [
                {
                    "id": v.get("id"),
                    "value": v.get("value") or v.get("name"),
                    "disabled": v.get("disabled", False),
                }
                for v in f["allowedValues"]
            ]
        if f.get("defaultValue"):
            entry["defaultValue"] = f["defaultValue"]
        result.append(entry)
    return json.dumps(result, indent=2)


async def list_custom_fields_usage(
    client: JiraClient,
    search: str | None = None,
    unused_only: bool = False,
    project_key: str | None = None,
    min_issues: int | None = None,
) -> str:
    """List custom fields with per-field usage stats (Jira DC 10 endpoint).

    Returns: id, name, type, searcherKey, projectsCount, projectKeys (resolved),
    isAllProjects, screensCount, issuesWithValue, lastValueUpdate (ISO + epoch).
    """
    from datetime import datetime, timezone

    raw = await client.list_custom_fields_usage()
    values = raw.get("values", [])

    projects = await client.list_projects()
    proj_map = {int(p["id"]): p["key"] for p in projects}

    target_pid = None
    if project_key:
        target_pid = next((pid for pid, k in proj_map.items() if k == project_key), None)
        if target_pid is None:
            return json.dumps({"error": f"Unknown project_key: {project_key}"})

    s = search.lower() if search else None
    result = []
    for f in values:
        if s and s not in (f.get("name") or "").lower():
            continue
        if unused_only and (f.get("issuesWithValue") or 0) != 0:
            continue
        if min_issues is not None and (f.get("issuesWithValue") or 0) < min_issues:
            continue
        if target_pid is not None and not f.get("isAllProjects") and target_pid not in (f.get("projectIds") or []):
            continue

        lvu = f.get("lastValueUpdate")
        result.append({
            "id": f.get("id"),
            "name": f.get("name"),
            "type": f.get("type"),
            "searcherKey": f.get("searcherKey"),
            "projectsCount": f.get("projectsCount"),
            "projectKeys": [proj_map.get(pid, f"#{pid}") for pid in (f.get("projectIds") or [])],
            "isAllProjects": f.get("isAllProjects", False),
            "screensCount": f.get("screensCount"),
            "issuesWithValue": f.get("issuesWithValue"),
            "lastValueUpdate": datetime.fromtimestamp(lvu / 1000, tz=timezone.utc).isoformat() if lvu else None,
            "lastValueUpdateEpoch": lvu,
        })

    result.sort(key=lambda r: -(r["issuesWithValue"] or 0))

    return json.dumps({
        "total": raw.get("total"),
        "returned": len(result),
        "fields": result,
    }, indent=2)


async def get_field_contexts(client: JiraClient, field_id: str) -> str:
    """Get custom field contexts — which projects and issue types the field is scoped to.

    Served by the jiraMcpCustomFieldContexts ScriptRunner endpoint (replaces the
    unsupported internal API /rest/internal/2/field/{id}/context).
    """
    fields = await client.list_custom_field_contexts(field_id)
    if not fields:
        return json.dumps({"error": f"No custom field context data for field {field_id}"})
    entry = fields[0]
    contexts = [
        {
            "id": ctx.get("id"),
            "name": ctx.get("name", ""),
            "description": ctx.get("description", ""),
            "isAllProjects": ctx.get("isGlobalProjects", False),
            "isAllIssueTypes": ctx.get("isAllIssueTypes", False),
            "projects": ctx.get("projects", []),
            "issueTypes": ctx.get("issueTypes", []),
        }
        for ctx in entry.get("contexts", [])
    ]
    return json.dumps({
        "fieldId": entry.get("fieldId"),
        "fieldName": entry.get("fieldName"),
        "fieldType": entry.get("fieldType"),
        "contexts": contexts,
    }, indent=2)
