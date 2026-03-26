"""In-memory cache for Automation for Jira (A4J) rules.

Jira DC 10 exposes only a single endpoint for automation rules:
  /rest/cb-automation/latest/project/GLOBAL/rule/export

This module fetches all rules at startup and refreshes every 10 minutes.
It also builds a project ID→key mapping so rules can be filtered by project key.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time

from .client import JiraClient

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_SECONDS = 600  # 10 minutes


class AutomationCache:
    """Periodically-refreshed cache of all A4J automation rules."""

    def __init__(self, client: JiraClient) -> None:
        self._client = client
        self._rules: list[dict] = []
        self._last_refresh: float = 0
        self._task: asyncio.Task | None = None
        # Project mappings: id (str) → key, key (upper) → id (str)
        self._id_to_key: dict[str, str] = {}
        self._key_to_id: dict[str, str] = {}

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        """Perform initial fetch and start background refresh loop."""
        await self._refresh()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        """Cancel the background refresh loop."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def refresh(self) -> int:
        """Force an immediate cache refresh. Returns the number of rules loaded."""
        await self._refresh()
        return len(self._rules)

    # -- data access ---------------------------------------------------------

    async def ensure_refreshed(self) -> None:
        """If the cache has never been successfully populated, force a refresh."""
        if self._last_refresh == 0:
            logger.info("Automation cache not yet populated — refreshing now")
            await self._refresh()

    async def get_all_rules(self) -> list[dict]:
        """Return all cached automation rules."""
        await self.ensure_refreshed()
        return list(self._rules)

    async def get_rule_by_id(self, rule_id: int) -> dict | None:
        """Look up a single rule by ID from cache."""
        await self.ensure_refreshed()
        for rule in self._rules:
            if rule.get("id") == rule_id:
                return rule
        return None

    async def get_rules_for_project(self, project_key: str) -> list[dict]:
        """Filter cached rules by project key.

        Checks three locations:
        1. The 'projects' array (matching by projectId via id→key mapping,
           or by projectKey if present)
        2. JQL strings in triggers, conditions, and actions
        3. The 'ruleScope' field (some A4J versions)
        """
        await self.ensure_refreshed()
        key_upper = project_key.upper()
        project_id = self._key_to_id.get(key_upper)
        result = []
        seen_ids: set[int] = set()

        for rule in self._rules:
            rule_id = rule.get("id")
            if rule_id in seen_ids:
                continue

            if self._rule_matches_project(rule, key_upper, project_id):
                result.append(rule)
                seen_ids.add(rule_id)

        return result

    @property
    def last_refresh(self) -> float:
        return self._last_refresh

    @property
    def rule_count(self) -> int:
        return len(self._rules)

    # -- internals -----------------------------------------------------------

    def _rule_matches_project(self, rule: dict, key_upper: str, project_id: str | None) -> bool:
        """Check if a rule is associated with a project."""
        # 1. Check 'projects' array (has projectId, sometimes projectKey)
        projects = rule.get("projects")
        if isinstance(projects, list):
            for p in projects:
                if not isinstance(p, dict):
                    continue
                # Direct key match
                pkey = p.get("projectKey")
                if pkey and pkey.upper() == key_upper:
                    return True
                # ID match via mapping
                if project_id and str(p.get("projectId")) == project_id:
                    return True

        # 2. Check ruleScope
        scope = rule.get("ruleScope", {})
        if isinstance(scope, dict):
            for res in scope.get("resources", []):
                if isinstance(res, str) and key_upper in res.upper():
                    return True

        # 3. Search serialized rule for any project reference (JQL, action configs, etc.)
        if self._rule_json_mentions_project(rule, key_upper, project_id):
            return True

        return False

    def _rule_json_mentions_project(self, rule: dict, key_upper: str, project_id: str | None) -> bool:
        """Search for any project references in the serialized rule.

        Covers JQL strings, action configs (create issue, move issue, etc.),
        and any other field that embeds a project key or ID.
        """
        rule_str = json.dumps(rule)
        esc_key = re.escape(key_upper)

        # 1. JQL context: project = KEY, project in (KEY, ...), project="KEY"
        jql_pattern = re.compile(
            r'project\s*(?:=|in\s*\()[^)]*\b' + esc_key + r'\b',
            re.IGNORECASE,
        )
        if jql_pattern.search(rule_str):
            return True

        # 2. Any JSON field whose name contains "project" (case-insensitive)
        #    with a string value matching the project key.
        #    Catches: "projectKey":"KEY", "project_key":"KEY",
        #    "destinationProject":"KEY", "targetProject":"KEY", etc.
        project_field_pattern = re.compile(
            r'"[^"]*[Pp]roject[^"]*"\s*:\s*"' + esc_key + r'"',
        )
        if project_field_pattern.search(rule_str):
            return True

        # 3. Nested key/id inside a project object:
        #    "project":{"key":"KEY"} or "project":{"id":"12345"}
        nested_key_pattern = re.compile(
            r'"[^"]*[Pp]roject[^"]*"\s*:\s*\{[^}]*"key"\s*:\s*"' + esc_key + r'"',
        )
        if nested_key_pattern.search(rule_str):
            return True

        if project_id:
            nested_id_pattern = re.compile(
                r'"[^"]*[Pp]roject[^"]*"\s*:\s*\{[^}]*"id"\s*:\s*"?' + re.escape(project_id) + r'"?',
            )
            if nested_id_pattern.search(rule_str):
                return True

            # 4. Any JSON field with "project" in the name holding the numeric ID
            #    e.g. "projectId":"12345" or "projectId":12345
            project_id_pattern = re.compile(
                r'"[^"]*[Pp]roject[^"]*[Ii]d[^"]*"\s*:\s*"?' + re.escape(project_id) + r'\b',
            )
            if project_id_pattern.search(rule_str):
                return True

        return False

    async def _build_project_index(self) -> None:
        """Fetch projects and build ID↔key mappings."""
        try:
            projects = await self._client.list_projects(expand="")
            id_to_key: dict[str, str] = {}
            key_to_id: dict[str, str] = {}
            for p in projects:
                pid = str(p.get("id", ""))
                pkey = p.get("key", "")
                if pid and pkey:
                    id_to_key[pid] = pkey
                    key_to_id[pkey.upper()] = pid
            self._id_to_key = id_to_key
            self._key_to_id = key_to_id
            logger.info("Project index built: %d projects", len(id_to_key))
        except Exception as e:
            logger.error("Failed to build project index: %s", e)

    async def _refresh(self) -> None:
        """Fetch all automation rules from Jira."""
        try:
            # Build project index if empty (first run or after failure)
            if not self._id_to_key:
                await self._build_project_index()
            rules = await self._client.export_automation_rules()
            self._rules = rules
            self._last_refresh = time.time()
            logger.info("Automation cache refreshed: %d rules loaded", len(rules))
        except Exception as e:
            logger.error("Failed to refresh automation cache: %s", e)

    async def _refresh_loop(self) -> None:
        """Background loop that refreshes the cache every REFRESH_INTERVAL_SECONDS."""
        while True:
            await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
            # Rebuild project index periodically too (projects may be added)
            await self._build_project_index()
            await self._refresh()
