#!/usr/bin/env python3
"""Standalone self-test / coverage runner for the Jira DC MCP server.

Exercises every tool in the server against the live Jira instance, auto-discovers
the IDs/keys that parameterised tools need (project keys, scheme IDs, workflow
names, board IDs, ...) from the ``list_*``/``dump_*`` tools, runs optional-
parameter variants to measure parameter coverage, and prints a live report — one
line per tool variant as it completes — followed by a coverage summary.

Tools are driven through the server's own ``_dispatch`` function, so the report
reflects the exact code path a real MCP client hits.

Each tool's returned JSON is also written to a file (one per tool) under the
``selftest-output/`` folder next to this script, so the outputs can be inspected
/ analysed afterwards.

Usage:
    python run_selftest.py [--only a,b] [--skip a,b] [--out-dir PATH] [--json PATH]

Jira credentials are read from the environment, falling back to the ``jira-dc``
server's ``env`` block in ``.mcp.json``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

ROOT = Path(__file__).resolve().parent


def _load_env() -> None:
    """Populate JIRA_* env vars from .mcp.json when not already set."""
    mcp = ROOT / ".mcp.json"
    if not mcp.exists():
        return
    try:
        cfg = json.loads(mcp.read_text(encoding="utf-8"))
        env = cfg["mcpServers"]["jira-dc"]["env"]
    except (KeyError, ValueError):
        return
    for key, value in env.items():
        if isinstance(value, str):
            os.environ.setdefault(key, value)


_load_env()
sys.path.insert(0, str(ROOT / "src"))

from jira_dc_mcp.automation_cache import AutomationCache  # noqa: E402
from jira_dc_mcp.client import JiraClient  # noqa: E402
from jira_dc_mcp.server import TOOLS, _dispatch  # noqa: E402

PER_CALL_TIMEOUT = 45.0          # seconds per individual tool call
DEFAULT_OUT_DIR = ROOT / "selftest-output"

# Worst-to-best ranking used to roll variant statuses up to a tool status.
_STATUS_RANK = {"error": 5, "timeout": 4, "tool_error": 3, "empty": 2, "pass": 1, "skipped": 0}
_ICON = {"pass": "PASS", "empty": "EMPT", "tool_error": "WARN", "error": "FAIL",
         "timeout": "TIME", "skipped": "SKIP"}
_PHASE_NAMES = {
    1: "Phase 1 - zero-arg discovery",
    2: "Phase 2 - dependent tools",
    3: "Phase 3 - second-order dependent tools",
    4: "Phase 4 - cache-mutating tools",
}

DispatchFn = Callable[[JiraClient, AutomationCache, str, dict], Awaitable[str]]

# Which tool produces each harvest key — used to auto-resolve --only prerequisites.
# Keys absent here are produced in Phase 0 (always available, no prerequisite tool).
_HARVEST_PRODUCERS = {
    "project_keys": "list_projects",
    "field_ids": "list_fields",
    "custom_field_ids": "list_fields",
    "workflow_names": "list_active_workflows",
    "screen_ids": "list_screens",
    "workflow_scheme_ids": "list_workflow_schemes",
    "screen_scheme_ids": "list_screen_schemes",
    "permission_scheme_ids": "list_permission_schemes",
    "notification_scheme_ids": "list_notification_schemes",
    "board_ids": "list_boards",
    "service_desk_ids": "list_service_desks",
    "rule_ids": "list_automation_rules",
    "createmeta_pairs": "get_project_config",
    "user_keys": "find_users",
    "audit_item_ids": "get_automation_audit_log",
    "group_names": "get_user_groups",
}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Variant:
    """One invocation of a tool with a specific argument set."""
    label: str
    args: dict[str, Any]
    branch: str | None = None        # parameter-coverage tag
    note: str | None = None


@dataclass
class ToolCase:
    """How to test a single tool: which variants to run, given discovered data."""
    name: str
    phase: int
    discover: Callable[[dict], list[Variant] | None]
    skip_reason: str = "no live data discovered for a required parameter"
    timeout: float = PER_CALL_TIMEOUT
    branches: tuple[str, ...] = ()    # all parameter branches this tool can exercise
    needs: tuple[str, ...] = ()       # harvest keys this tool requires to run at all


@dataclass
class VariantResult:
    label: str
    branch: str | None
    args: dict[str, Any]
    status: str                       # pass | tool_error | error | timeout
    duration_ms: float
    result_bytes: int = 0
    error: str | None = None
    note: str | None = None
    parsed: Any = field(default=None, repr=False)   # not serialised
    raw: str | None = field(default=None, repr=False)   # raw tool output, for file dump


# ---------------------------------------------------------------------------
# Execution / harvest helpers
# ---------------------------------------------------------------------------

def _try_parse_json(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _is_error(parsed: Any) -> bool:
    return isinstance(parsed, dict) and "error" in parsed


async def _run_one(
    dispatch: DispatchFn,
    client: JiraClient,
    cache: AutomationCache,
    name: str,
    variant: Variant,
    timeout: float,
) -> VariantResult:
    """Run a single tool variant, capturing timing, errors and result classification."""
    started = time.monotonic()
    try:
        raw = await asyncio.wait_for(dispatch(client, cache, name, variant.args), timeout=timeout)
    except asyncio.TimeoutError:
        return VariantResult(
            variant.label, variant.branch, variant.args, "timeout",
            (time.monotonic() - started) * 1000, error=f"exceeded {timeout:.0f}s timeout",
            note=variant.note,
        )
    except Exception as e:  # _dispatch raises directly — unhandled bug in a tool
        return VariantResult(
            variant.label, variant.branch, variant.args, "error",
            (time.monotonic() - started) * 1000, error=f"{type(e).__name__}: {e}",
            note=variant.note,
        )

    duration = (time.monotonic() - started) * 1000
    parsed = _try_parse_json(raw)
    if _is_error(parsed):
        status = "tool_error"
    elif parsed == [] or parsed == {}:
        status = "empty"          # call succeeded but returned no data
    else:
        status = "pass"
    return VariantResult(
        variant.label, variant.branch, variant.args, status, duration,
        result_bytes=len(raw or ""),
        error=parsed["error"] if status == "tool_error" else None,
        note=variant.note,
        parsed=parsed,
        raw=raw,
    )


def _add(harvest: dict, key: str, values: list) -> None:
    """Append unique, non-empty values to a harvest bucket, preserving order."""
    bucket = harvest.setdefault(key, [])
    for v in values:
        if v is not None and v != "" and v not in bucket:
            bucket.append(v)


def _harvest(harvest: dict, tool: str, parsed: Any) -> None:
    """Extract reusable IDs/keys from a tool's (non-error) result into ``harvest``."""
    match tool:
        case "list_projects" if isinstance(parsed, list):
            _add(harvest, "project_keys", [p.get("key") for p in parsed if isinstance(p, dict)])
        case "list_fields" if isinstance(parsed, list):
            customs = [f.get("id") for f in parsed if isinstance(f, dict) and f.get("custom")]
            allids = [f.get("id") for f in parsed if isinstance(f, dict)]
            _add(harvest, "custom_field_ids", customs)
            _add(harvest, "field_ids", (customs[:1] or allids[:1]))
        case "list_active_workflows" | "list_all_workflows" | "dump_workflows" if isinstance(parsed, list):
            _add(harvest, "workflow_names", [w.get("name") for w in parsed if isinstance(w, dict)])
        case "list_screens" if isinstance(parsed, list):
            _add(harvest, "screen_ids", [s.get("id") for s in parsed if isinstance(s, dict)])
        case "list_workflow_schemes" if isinstance(parsed, list):
            _add(harvest, "workflow_scheme_ids", [s.get("id") for s in parsed if isinstance(s, dict)])
        case "list_screen_schemes" if isinstance(parsed, list):
            _add(harvest, "screen_scheme_ids", [s.get("id") for s in parsed if isinstance(s, dict)])
        case "list_permission_schemes" if isinstance(parsed, list):
            _add(harvest, "permission_scheme_ids", [s.get("id") for s in parsed if isinstance(s, dict)])
        case "list_notification_schemes" if isinstance(parsed, list):
            _add(harvest, "notification_scheme_ids", [s.get("id") for s in parsed if isinstance(s, dict)])
        case "list_boards" if isinstance(parsed, list):
            _add(harvest, "board_ids", [b.get("id") for b in parsed if isinstance(b, dict)])
        case "list_service_desks" if isinstance(parsed, list):
            _add(harvest, "service_desk_ids", [d.get("id") for d in parsed if isinstance(d, dict)])
        case "list_automation_rules" if isinstance(parsed, list):
            _add(harvest, "rule_ids", [r.get("id") for r in parsed if isinstance(r, dict)])
        case "get_project_config" if isinstance(parsed, dict):
            pk = parsed.get("key")
            pairs = [(pk, it.get("id")) for it in parsed.get("issueTypes", [])
                     if isinstance(it, dict) and pk and it.get("id")]
            _add(harvest, "createmeta_pairs", pairs)
        case "get_project_role_members" if isinstance(parsed, dict):
            for role in parsed.values():
                for actor in (role or {}).get("actors", []) if isinstance(role, dict) else []:
                    atype = (actor.get("type") or "").lower()
                    if "user" in atype and actor.get("name"):
                        _add(harvest, "user_keys", [actor["name"]])
                    elif "group" in atype and actor.get("name"):
                        _add(harvest, "group_names", [actor["name"]])
        case "find_users" if isinstance(parsed, list):
            _add(harvest, "user_keys", [u.get("key") or u.get("name")
                                        for u in parsed if isinstance(u, dict)])
        case "get_automation_audit_log" if isinstance(parsed, list):
            _add(harvest, "audit_item_ids", [e.get("id") for e in parsed if isinstance(e, dict)])
        case "get_user_groups" if isinstance(parsed, list):
            _add(harvest, "group_names", [g.get("name") for g in parsed if isinstance(g, dict)])


# ---------------------------------------------------------------------------
# Discovery closure factories
# ---------------------------------------------------------------------------

def _no_args(h: dict) -> list[Variant] | None:
    return [Variant("default", {})]


def _single(harvest_key: str, arg_name: str):
    """A tool that needs one discovered value passed as a single argument."""
    def disc(h: dict) -> list[Variant] | None:
        vals = h.get(harvest_key) or []
        if not vals:
            return None
        return [Variant("default", {arg_name: vals[0]})]
    disc.needs = (harvest_key,)   # consumed by _build_test_plan to populate ToolCase.needs
    return disc


# ---------------------------------------------------------------------------
# The test plan — one ToolCase per tool, ordered by discovery dependency
# ---------------------------------------------------------------------------

def _build_test_plan() -> list[ToolCase]:
    """Return an ordered list of ToolCases covering every server tool.

    ``discover`` closures read the live ``harvest`` dict at execution time, so a
    tool placed later in the list sees IDs produced by earlier tools.
    """

    # --- multi-variant discover closures (parameter coverage) ----------------

    def disc_list_fields(h):
        # 'summary' is a universal system field — safe deterministic id filter.
        return [
            Variant("default", {}, branch="list_fields:default"),
            Variant("custom_only", {"custom_only": True}, branch="list_fields:custom_only"),
            Variant("field_ids", {"field_ids": ["summary"]}, branch="list_fields:field_ids"),
        ]

    def disc_custom_fields_usage(h):
        variants = [
            Variant("no filter", {}, branch="cfu:none"),
            Variant("search", {"search": "field"}, branch="cfu:search"),
            Variant("unused_only", {"unused_only": True}, branch="cfu:unused_only"),
        ]
        pk = (h.get("project_keys") or [None])[0]
        if pk:
            variants.append(Variant("project_key+min_issues",
                                    {"project_key": pk, "min_issues": 1}, branch="cfu:project"))
        return variants

    def disc_list_boards(h):
        variants = [Variant("no project_key", {}, branch="boards:no_project")]
        pk = (h.get("project_keys") or [None])[0]
        if pk:
            variants.append(Variant("project_key", {"project_key": pk}, branch="boards:project"))
        return variants

    def disc_list_automation_rules(h):
        variants = [Variant("no project_key", {}, branch="rules:no_project")]
        pk = (h.get("project_keys") or [None])[0]
        if pk:
            variants.append(Variant("project_key", {"project_key": pk}, branch="rules:project"))
        return variants

    def _issue_key(h):
        """A real discovered issue key, else the <project>-1 heuristic, else None."""
        discovered = (h.get("issue_keys") or [None])[0]
        if discovered:
            return discovered, f"discovered issue key {discovered}"
        pk = (h.get("project_keys") or [None])[0]
        if pk:
            return f"{pk}-1", f"heuristic issue key {pk}-1 (issue-key discovery found none)"
        return None, None

    def disc_get_issue(h):
        key, note = _issue_key(h)
        if not key:
            return None
        return [
            Variant("default fields", {"issue_key": key}, branch="issue:default_fields", note=note),
            Variant("explicit fields", {"issue_key": key, "fields": "summary,status"},
                    branch="issue:explicit_fields", note=note),
        ]

    def disc_get_issue_changelog(h):
        key, note = _issue_key(h)
        if not key:
            return None
        return [
            Variant("all changes", {"issue_key": key}, branch="changelog:all", note=note),
            Variant("field filter", {"issue_key": key, "field": "status"},
                    branch="changelog:field", note=note),
        ]

    def disc_audit_log(h):
        return [
            Variant("default", {"limit": 10}, branch="auditlog:default"),
            Variant("paged", {"limit": 10, "offset": 5}, branch="auditlog:paged"),
            Variant("category filter", {"limit": 10, "categories": ["SUCCESS"]},
                    branch="auditlog:filtered"),
        ]

    def disc_rule_audit_log(h):
        ids = h.get("rule_ids") or []
        if not ids:
            return None
        return [
            Variant("basic", {"rule_id": ids[0], "limit": 10}, branch="ruleaudit:basic"),
            Variant("category filter", {"rule_id": ids[0], "limit": 10, "categories": ["SUCCESS"]},
                    branch="ruleaudit:filtered"),
        ]

    def disc_search_config(h):
        pk = (h.get("project_keys") or [None])[0]
        variants = [Variant("keyword", {"query": "status"}, branch="search:keyword")]
        if pk:
            variants.insert(0, Variant("project key", {"query": pk}, branch="search:project_key"))
        return variants

    def disc_find_users(h):
        return [
            Variant("query", {"query": "a"}, branch="users:query"),
            Variant("query+max_results", {"query": "a", "max_results": 5}, branch="users:query_max"),
        ]

    def disc_group_members(h):
        groups = h.get("group_names") or []
        if not groups:
            return None
        return [
            Variant("basic", {"group_name": groups[0]}, branch="members:basic"),
            Variant("include_inactive", {"group_name": groups[0], "include_inactive": True},
                    branch="members:inactive"),
        ]

    def disc_createmeta(h):
        pairs = h.get("createmeta_pairs") or []
        if not pairs:
            return None
        pk, itid = pairs[0]
        return [Variant("default", {"project_key": pk, "issue_type_id": itid})]

    # Required harvest keys for closures that skip entirely without discovered data
    # (the _single() factory tags its own; these are the hand-written closures).
    disc_createmeta.needs = ("createmeta_pairs",)
    disc_rule_audit_log.needs = ("rule_ids",)
    disc_group_members.needs = ("group_names",)
    disc_get_issue.needs = ("project_keys",)
    disc_get_issue_changelog.needs = ("project_keys",)

    plan: list[ToolCase] = [
        # ---- Phase 1: zero-arg discovery -----------------------------------
        ToolCase("dump_global_config", 1, _no_args),
        ToolCase("dump_workflows", 1, _no_args),
        ToolCase("dump_automation_rules", 1, _no_args),
        ToolCase("list_projects", 1, _no_args),
        ToolCase("list_active_workflows", 1, _no_args),
        ToolCase("list_all_workflows", 1, _no_args),
        ToolCase("list_screens", 1, _no_args),
        ToolCase("list_workflow_schemes", 1, _no_args),
        ToolCase("list_screen_schemes", 1, _no_args),
        ToolCase("list_permission_schemes", 1, _no_args),
        ToolCase("list_notification_schemes", 1, _no_args),
        ToolCase("list_automation_rules", 1, disc_list_automation_rules,
                 branches=("rules:no_project", "rules:project")),
        ToolCase("list_boards", 1, disc_list_boards,
                 branches=("boards:no_project", "boards:project")),
        ToolCase("list_service_desks", 1, _no_args),
        ToolCase("list_filters", 1, _no_args),
        ToolCase("list_dashboards", 1, _no_args),
        ToolCase("list_webhooks", 1, _no_args),
        ToolCase("list_project_categories", 1, _no_args),
        ToolCase("list_fields", 1, disc_list_fields,
                 branches=("list_fields:default", "list_fields:custom_only", "list_fields:field_ids")),
        ToolCase("list_custom_fields_usage", 1, disc_custom_fields_usage,
                 branches=("cfu:none", "cfu:search", "cfu:unused_only", "cfu:project")),

        # ---- Phase 2: first-order dependent --------------------------------
        ToolCase("get_project_config", 2, _single("project_keys", "project_key")),
        ToolCase("get_project_role_members", 2, _single("project_keys", "project_key")),
        ToolCase("get_project_components", 2, _single("project_keys", "project_key")),
        ToolCase("get_project_versions", 2, _single("project_keys", "project_key")),
        ToolCase("get_createmeta_fields", 2, disc_createmeta,
                 skip_reason="no project/issue-type pair discovered from get_project_config"),
        ToolCase("get_workflow_detail", 2, _single("workflow_names", "workflow_name")),
        ToolCase("get_workflow_statuses_and_transitions", 2,
                 _single("workflow_names", "workflow_name")),
        ToolCase("get_workflow_scheme", 2, _single("workflow_scheme_ids", "scheme_id")),
        ToolCase("get_screen_tabs_and_fields", 2, _single("screen_ids", "screen_id")),
        ToolCase("get_screen_scheme", 2, _single("screen_scheme_ids", "scheme_id"),
                 skip_reason="no screen schemes discovered (reconstructed view may be empty)"),
        ToolCase("get_permission_scheme", 2, _single("permission_scheme_ids", "scheme_id")),
        ToolCase("get_notification_scheme", 2, _single("notification_scheme_ids", "scheme_id")),
        ToolCase("get_issue_type_scheme", 2, _single("issue_type_scheme_ids", "scheme_id")),
        ToolCase("get_issue_security_scheme", 2, _single("issue_security_scheme_ids", "scheme_id"),
                 skip_reason="no issue security schemes exist on this instance"),
        ToolCase("get_priority_scheme", 2, _single("priority_scheme_ids", "scheme_id"),
                 skip_reason="no priority schemes exist on this instance"),
        # fieldconfiguration list endpoints 404 on DC 10 — run with a synthetic
        # id to confirm the tool degrades gracefully rather than skipping it.
        ToolCase("get_field_configuration", 2,
                 lambda h: [Variant("synthetic id", {"fc_id": 10000}, branch=None,
                                    note="no discovery source — /fieldconfiguration 404s on DC 10")]),
        ToolCase("get_field_configuration_scheme", 2,
                 lambda h: [Variant("synthetic id", {"scheme_id": 10000}, branch=None,
                                    note="no discovery source — endpoint 404s on DC 10")]),
        # find_field_usage scans every screen — give it generous headroom on
        # large instances before a timeout is treated as a genuine failure.
        ToolCase("find_field_usage", 2, _single("field_ids", "field_id"), timeout=240.0),
        ToolCase("get_field_contexts", 2, _single("field_ids", "field_id")),
        ToolCase("get_automation_rule_detail", 2, _single("rule_ids", "rule_id"),
                 skip_reason="no automation rules in cache"),
        ToolCase("get_automation_audit_log", 2, disc_audit_log,
                 branches=("auditlog:default", "auditlog:paged", "auditlog:filtered")),
        ToolCase("get_automation_rule_audit_log", 2, disc_rule_audit_log,
                 skip_reason="no automation rules in cache",
                 branches=("ruleaudit:basic", "ruleaudit:filtered")),
        ToolCase("get_board_configuration", 2, _single("board_ids", "board_id"),
                 skip_reason="instance has no agile boards"),
        ToolCase("get_service_desk_slas", 2, _single("service_desk_ids", "service_desk_id"),
                 skip_reason="instance has no JSM service desks"),
        ToolCase("get_service_desk_queues", 2, _single("service_desk_ids", "service_desk_id"),
                 skip_reason="instance has no JSM service desks"),
        ToolCase("analyze_project_config_chain", 2, _single("project_keys", "project_key")),
        ToolCase("search_config", 2, disc_search_config,
                 branches=("search:project_key", "search:keyword")),
        ToolCase("get_issue", 2, disc_get_issue,
                 branches=("issue:default_fields", "issue:explicit_fields")),
        ToolCase("get_issue_changelog", 2, disc_get_issue_changelog,
                 branches=("changelog:all", "changelog:field")),
        ToolCase("find_users", 2, disc_find_users,
                 branches=("users:query", "users:query_max")),

        # ---- Phase 3: second-order dependent -------------------------------
        ToolCase("get_automation_audit_item", 3, _single("audit_item_ids", "item_id"),
                 skip_reason="audit log produced no entries to drill into"),
        ToolCase("get_user", 3, _single("user_keys", "key"),
                 skip_reason="no user key discovered from find_users / role members"),
        ToolCase("get_user_groups", 3, _single("user_keys", "key"),
                 skip_reason="no user key discovered from find_users / role members"),
        ToolCase("get_group_members", 3, disc_group_members,
                 skip_reason="no group discovered from get_user_groups / role members",
                 branches=("members:basic", "members:inactive")),

        # ---- Phase 4: cache-mutating, run last -----------------------------
        ToolCase("refresh_automation_cache", 4, _no_args),
    ]
    # Populate each ToolCase.needs from its discover closure (set by _single()
    # or the hand-written closures above).
    for case in plan:
        case.needs = tuple(getattr(case.discover, "needs", ()) or ())
    return plan


def _resolve_prerequisites(plan: list[ToolCase], wanted: set[str]) -> set[str]:
    """Expand a --only set to include the discovery tools the selection depends on."""
    by_name = {c.name: c for c in plan}
    effective = set(wanted)
    queue = list(wanted)
    while queue:
        case = by_name.get(queue.pop())
        if case is None:
            continue
        for key in case.needs:
            producer = _HARVEST_PRODUCERS.get(key)
            if producer and producer not in effective:
                effective.add(producer)
                queue.append(producer)
    return effective


# ---------------------------------------------------------------------------
# Live printing
# ---------------------------------------------------------------------------

def _print_phase(phase: int) -> None:
    print(f"\n{_PHASE_NAMES.get(phase, f'Phase {phase}')}", flush=True)


def _print_variant(tool: str, vr: VariantResult) -> None:
    icon = _ICON.get(vr.status, vr.status)
    size = f"{vr.result_bytes / 1024:7.1f} KB" if vr.result_bytes else " " * 10
    print(f"  {icon}  {tool:<38s}{vr.label:<24s}{vr.duration_ms:8.0f} ms  {size}", flush=True)
    if vr.error:
        print(f"        |_ {vr.error}", flush=True)


def _print_skip(tool: str, reason: str) -> None:
    print(f"  SKIP  {tool:<38s}{reason}", flush=True)


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

def _save_tool_output(out_dir: Path, tool: str, variant_results: list[VariantResult]) -> None:
    """Write the first variant's raw JSON output to ``out_dir/<tool>.json``.

    Errors (``error``/``timeout``) have no raw output and produce no file.
    """
    for vr in variant_results:
        if vr.raw is not None:
            (out_dir / f"{tool}.json").write_text(vr.raw, encoding="utf-8")
            return


def _skipped_tool(case: ToolCase, reason: str) -> dict:
    return {
        "tool": case.name, "phase": case.phase, "status": "skipped",
        "variantsRun": 0, "skipReason": reason, "variants": [],
    }


def _tool_result(case: ToolCase, variant_results: list[VariantResult]) -> dict:
    worst = max((vr.status for vr in variant_results), key=lambda s: _STATUS_RANK[s])
    return {
        "tool": case.name,
        "phase": case.phase,
        "status": worst,
        "variantsRun": len(variant_results),
        "variants": [
            {
                "label": vr.label,
                "branch": vr.branch,
                "status": vr.status,
                "durationMs": round(vr.duration_ms, 1),
                "resultBytes": vr.result_bytes,
                "args": vr.args,
                "error": vr.error,
                "note": vr.note,
            }
            for vr in variant_results
        ],
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def run_self_test(
    client: JiraClient,
    automation_cache: AutomationCache,
    *,
    out_dir: Path,
    only: list[str] | None = None,
    skip: list[str] | None = None,
) -> dict:
    """Exercise every tool against the live instance, printing live; return the report.

    Each tool's raw JSON output is written to ``out_dir/<tool>.json``, and the
    full report to ``out_dir/_report.json``.
    """
    started = datetime.now(timezone.utc)
    t0 = time.monotonic()

    only_set = set(only) if only else None
    skip_set = set(skip) if skip else set()

    harvest: dict[str, list] = {}

    # Fresh output directory for this run.
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Tool outputs -> {out_dir}", flush=True)

    # Phase 0 — prime the automation cache so A4J tools are meaningful.
    cache_status = "ok"
    try:
        await automation_cache.ensure_refreshed()
    except Exception as e:
        cache_status = f"{type(e).__name__}: {e}"
    print(f"Automation cache: {cache_status}", flush=True)

    # Phase 0 — seed scheme IDs that have no dedicated discovery tool.
    for method, key in (
        ("list_issue_type_schemes", "issue_type_scheme_ids"),
        ("list_issue_security_schemes", "issue_security_scheme_ids"),
        ("list_priority_schemes", "priority_scheme_ids"),
    ):
        try:
            data = await getattr(client, method)()
            _add(harvest, key, [s.get("id") for s in data if isinstance(s, dict)])
        except Exception:
            pass

    # Phase 0 — discover a real issue key (no MCP tool returns issue keys).
    try:
        data = await client.get(
            "/rest/api/2/search",
            params={"jql": "order by updated DESC", "maxResults": 1, "fields": "key"},
        )
        _add(harvest, "issue_keys", [i.get("key") for i in data.get("issues", [])])
    except Exception:
        pass

    plan = _build_test_plan()
    registered = {t["name"] for t in TOOLS}
    planned_names = {c.name for c in plan}

    # When --only is used, auto-include the discovery tools the selection depends
    # on, so any tool can be tested in isolation without manually listing its deps.
    effective_only = only_set
    if only_set is not None:
        effective_only = _resolve_prerequisites(plan, only_set)
        added = sorted(effective_only - only_set)
        if added:
            print(f"--only: also running {len(added)} prerequisite discovery "
                  f"tool(s): {', '.join(added)}", flush=True)

    results: list[dict] = []
    current_phase: int | None = None
    for case in plan:
        if case.name not in registered:
            continue  # plan references a tool no longer in the registry
        if effective_only is not None and case.name not in effective_only:
            continue
        if case.phase != current_phase:
            current_phase = case.phase
            _print_phase(case.phase)

        if case.name in skip_set:
            results.append(_skipped_tool(case, "excluded via --skip"))
            _print_skip(case.name, "excluded via --skip")
            continue

        variants = case.discover(harvest)
        if not variants:
            results.append(_skipped_tool(case, case.skip_reason))
            _print_skip(case.name, case.skip_reason)
            continue

        variant_results: list[VariantResult] = []
        for variant in variants:
            vr = await _run_one(_dispatch, client, automation_cache, case.name, variant, case.timeout)
            variant_results.append(vr)
            if vr.parsed is not None and not _is_error(vr.parsed):
                _harvest(harvest, case.name, vr.parsed)
            _print_variant(case.name, vr)
        results.append(_tool_result(case, variant_results))
        _save_tool_output(out_dir, case.name, variant_results)

    # Tools in the registry that the plan does not cover (e.g. newly added).
    for name in sorted(registered - planned_names):
        if effective_only is not None and name not in effective_only:
            continue
        results.append({
            "tool": name, "phase": 99, "status": "skipped", "variantsRun": 0,
            "skipReason": "not covered by the self-test plan", "variants": [],
        })
        _print_skip(name, "not covered by the self-test plan")

    # ---- aggregate ---------------------------------------------------------
    in_scope = registered if effective_only is None else (registered & effective_only)
    tools_total = len(in_scope)

    counts = {"pass": 0, "empty": 0, "tool_error": 0, "error": 0, "timeout": 0, "skipped": 0}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    v_counts = {"pass": 0, "empty": 0, "tool_error": 0, "error": 0, "timeout": 0}
    exercised_branches: set[str] = set()
    failures: list[dict] = []
    skipped: list[dict] = []
    for r in results:
        if r["status"] == "skipped":
            skipped.append({"tool": r["tool"], "reason": r.get("skipReason")})
        for v in r["variants"]:
            v_counts[v["status"]] = v_counts.get(v["status"], 0) + 1
            if v["branch"]:
                exercised_branches.add(v["branch"])
            if v["status"] in ("error", "timeout"):
                failures.append({"tool": r["tool"], "variant": v["label"],
                                 "status": v["status"], "error": v["error"]})

    planned_branches: set[str] = set()
    for case in plan:
        if effective_only is not None and case.name not in effective_only:
            continue
        planned_branches.update(case.branches)
    branches_hit = exercised_branches & planned_branches

    tools_run = tools_total - counts["skipped"]

    def _pct(num: int, den: int) -> float:
        return round(num / den * 100, 1) if den else 0.0

    discovery = {
        key: {"count": len(vals), "sample": vals[:3]}
        for key, vals in sorted(harvest.items())
    }

    report = {
        "schemaVersion": 1,
        "startedAt": started.isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "durationMs": round((time.monotonic() - t0) * 1000, 1),
        "options": {"only": only, "skip": skip},
        "automationCache": cache_status,
        "summary": {
            "toolsTotal": tools_total,
            "toolsRun": tools_run,
            "toolsPassed": counts["pass"],
            "toolsEmpty": counts["empty"],
            "toolsToolError": counts["tool_error"],
            "toolsFailed": counts["error"] + counts["timeout"],
            "toolsSkipped": counts["skipped"],
            "variantsTotal": sum(v_counts.values()),
            "variantsPassed": v_counts["pass"],
            "variantsEmpty": v_counts["empty"],
            "variantsToolError": v_counts["tool_error"],
            "variantsFailed": v_counts["error"] + v_counts["timeout"],
            "coverage": {
                "toolCoveragePct": _pct(tools_run, tools_total),
                "passCoveragePct": _pct(counts["pass"], tools_total),
                "parameterBranchesExercised": len(branches_hit),
                "parameterBranchesPlanned": len(planned_branches),
                "parameterBranchCoveragePct": _pct(len(branches_hit), len(planned_branches)),
            },
        },
        "discovery": discovery,
        "results": results,
        "skipped": skipped,
        "failures": failures,
    }
    (out_dir / "_report.json").write_text(
        json.dumps(report, indent=2, default=str), encoding="utf-8")
    return report


# ---------------------------------------------------------------------------
# Summary printing
# ---------------------------------------------------------------------------

def _print_summary(report: dict) -> None:
    s = report["summary"]
    cov = s["coverage"]
    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    print(f"  tools     : {s['toolsPassed']} passed  {s['toolsEmpty']} empty  "
          f"{s['toolsToolError']} tool-error  {s['toolsFailed']} failed  "
          f"{s['toolsSkipped']} skipped   (of {s['toolsTotal']})")
    print(f"  variants  : {s['variantsPassed']} passed  {s['variantsEmpty']} empty  "
          f"{s['variantsToolError']} tool-error  {s['variantsFailed']} failed   "
          f"(of {s['variantsTotal']})")
    print(f"  coverage  : tools {cov['toolCoveragePct']}%   pass {cov['passCoveragePct']}%   "
          f"param-branches {cov['parameterBranchesExercised']}/"
          f"{cov['parameterBranchesPlanned']} ({cov['parameterBranchCoveragePct']}%)")
    print(f"  duration  : {report['durationMs'] / 1000:.1f}s")

    if report["failures"]:
        print("\n  FAILURES:")
        for f in report["failures"]:
            print(f"    {f['tool']} [{f['variant']}] {f['status']}: {f['error']}")
    else:
        print("\n  No hard failures.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def _main() -> int:
    ap = argparse.ArgumentParser(
        description="Run the Jira DC MCP server self-test and stream a live coverage report.")
    ap.add_argument("--only", help="comma-separated allow-list of tool names to test; "
                                   "discovery prerequisites are added automatically")
    ap.add_argument("--skip", help="comma-separated deny-list of tool names to exclude")
    ap.add_argument("--out-dir", metavar="PATH", default=str(DEFAULT_OUT_DIR),
                    help=f"directory for per-tool output files (default: {DEFAULT_OUT_DIR})")
    ap.add_argument("--json", metavar="PATH", help="also write the full JSON report to PATH")
    args = ap.parse_args()

    if not os.environ.get("JIRA_BASE_URL"):
        print("error: JIRA_BASE_URL is not set (and not found in .mcp.json)", file=sys.stderr)
        return 2

    only = [t.strip() for t in args.only.split(",")] if args.only else None
    skip = [t.strip() for t in args.skip.split(",")] if args.skip else None
    out_dir = Path(args.out_dir)

    print(f"Self-test against {os.environ['JIRA_BASE_URL']}  ({len(TOOLS)} tools registered)")

    client = JiraClient()
    cache = AutomationCache(client)
    try:
        report = await run_self_test(client, cache, out_dir=out_dir, only=only, skip=skip)
    finally:
        await client.close()

    _print_summary(report)

    tool_files = sorted(p.name for p in out_dir.glob("*.json") if p.name != "_report.json")
    print(f"\n  {len(tool_files)} per-tool output files + _report.json written to {out_dir}")

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"  full JSON report also written to {args.json}")

    return 1 if report["summary"]["toolsFailed"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
