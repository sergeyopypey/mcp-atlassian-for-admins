"""Automation for Jira (A4J) tools — read-only, backed by in-memory cache."""

from __future__ import annotations

import json

from ..automation_cache import AutomationCache
from ..client import JiraClient


async def list_automation_rules(cache: AutomationCache, project_key: str | None = None) -> str:
    """List automation rules — all or filtered by project key."""
    if project_key:
        rules = await cache.get_rules_for_project(project_key)
    else:
        rules = await cache.get_all_rules()

    result = [
        {
            "id": r.get("id"),
            "name": r.get("name"),
            "state": r.get("state", "ENABLED" if r.get("enabled") else "DISABLED"),
            "triggerType": _extract_trigger_type(r),
            "created": r.get("created"),
            "updated": r.get("updated"),
            "executionCount": r.get("executionCount"),
        }
        for r in rules
    ]
    return json.dumps(result, indent=2)


async def get_automation_rule_detail(cache: AutomationCache, rule_id: int) -> str:
    """Get full automation rule detail from cache."""
    rule = await cache.get_rule_by_id(rule_id)
    if rule is None:
        return json.dumps({"error": f"Rule {rule_id} not found in cache"})
    return json.dumps(rule, indent=2)


async def get_automation_audit_log(
    client: JiraClient, cache: AutomationCache,
    limit: int = 50,
    offset: int = 0,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> str:
    """Get the global automation audit log — recent executions across all rules."""
    data = await client.get_automation_audit_log(
        limit=limit, offset=offset,
        categories=categories, date_from=date_from, date_to=date_to,
    )
    items = data.get("items", []) if isinstance(data, dict) else data
    rules = await cache.get_all_rules()
    rule_names = {r.get("id"): r.get("name") for r in rules}

    entries = []
    for entry in items:
        obj = entry.get("objectItem", {})
        rule_id = obj.get("id")
        entries.append({
            "id": entry.get("id"),
            "ruleId": rule_id,
            "ruleName": rule_names.get(rule_id, obj.get("name")),
            "category": entry.get("category"),
            "eventSource": entry.get("eventSource"),
            "created": entry.get("created"),
            "startExecution": entry.get("startExecution"),
            "endExecution": entry.get("endExecution"),
            "duration": entry.get("duration"),
            "authorKey": entry.get("authorKey"),
            "messages": entry.get("globalMessages") or None,
        })
    return json.dumps(entries, indent=2)


async def get_automation_rule_audit_log(
    client: JiraClient, cache: AutomationCache,
    rule_id: int,
    limit: int = 50,
    offset: int = 0,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> str:
    """Get execution history for a specific automation rule."""
    data = await client.get_automation_audit_log(
        limit=limit, offset=offset,
        categories=categories, date_from=date_from, date_to=date_to,
        rule_id=rule_id,
    )
    items = data.get("items", []) if isinstance(data, dict) else data

    rule = await cache.get_rule_by_id(rule_id)
    rule_name = rule.get("name") if rule else None

    entries = []
    for entry in items:
        entries.append({
            "id": entry.get("id"),
            "ruleId": rule_id,
            "ruleName": rule_name,
            "category": entry.get("category"),
            "eventSource": entry.get("eventSource"),
            "created": entry.get("created"),
            "startExecution": entry.get("startExecution"),
            "endExecution": entry.get("endExecution"),
            "duration": entry.get("duration"),
            "authorKey": entry.get("authorKey"),
            "messages": entry.get("globalMessages") or None,
        })
    return json.dumps(entries, indent=2)


async def get_automation_audit_item(client: JiraClient, item_id: int) -> str:
    """Get detailed info for a single audit log entry — includes component-level results and errors."""
    data = await client.get_automation_audit_item(item_id)
    return json.dumps(data, indent=2)


def _extract_issue_key(entry: dict) -> str | None:
    """Extract issue key from various audit log entry formats."""
    if entry.get("issueKey"):
        return entry["issueKey"]
    if entry.get("issue", {}).get("key"):
        return entry["issue"]["key"]
    trigger = entry.get("trigger", {})
    if isinstance(trigger, dict) and trigger.get("issueKey"):
        return trigger["issueKey"]
    return None


def _extract_trigger_type(rule: dict) -> str | None:
    """Extract trigger type from A4J rule structure (varies by version)."""
    trigger = rule.get("trigger")
    if isinstance(trigger, dict):
        return trigger.get("type") or trigger.get("component")
    if isinstance(trigger, list) and trigger:
        return trigger[0].get("type") or trigger[0].get("component")
    return None
