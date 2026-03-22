"""Automation for Jira (A4J) tools — read-only, backed by in-memory cache."""

from __future__ import annotations

import json

from ..automation_cache import AutomationCache


async def list_automation_rules(cache: AutomationCache, project_key: str | None = None) -> str:
    """List automation rules — all or filtered by project key."""
    if project_key:
        rules = cache.get_rules_for_project(project_key)
    else:
        rules = cache.get_all_rules()

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
    rule = cache.get_rule_by_id(rule_id)
    if rule is None:
        return json.dumps({"error": f"Rule {rule_id} not found in cache"})
    return json.dumps(rule, indent=2)


def _extract_trigger_type(rule: dict) -> str | None:
    """Extract trigger type from A4J rule structure (varies by version)."""
    trigger = rule.get("trigger")
    if isinstance(trigger, dict):
        return trigger.get("type") or trigger.get("component")
    if isinstance(trigger, list) and trigger:
        return trigger[0].get("type") or trigger[0].get("component")
    return None
