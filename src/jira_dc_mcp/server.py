"""MCP server — registers all tools and dispatches to Jira DC 10 client.

This server operates in read-only mode. It does not modify Jira configuration.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server import Server
from mcp.types import TextContent, Tool

from .automation_cache import AutomationCache
from .client import JiraClient
from .tools import dump, projects, workflows, screens, fields, schemes, automation, analysis

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    # ── Dump / bulk introspection ──────────────────────────────────────────
    {
        "name": "dump_global_config",
        "description": (
            "Dump global Jira instance configuration: all fields (system + custom), "
            "issue types, statuses, resolutions, priorities, issue link types, server info. "
            "Use this first to understand the Jira instance's building blocks."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dump_all_schemes",
        "description": (
            "Dump every scheme in the instance: workflow schemes, issue type schemes, "
            "issue type screen schemes, screen schemes, field configurations, "
            "field configuration schemes, permission schemes, notification schemes, "
            "issue security schemes, priority schemes. Shows IDs, names, and associations."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dump_workflows",
        "description": (
            "Dump all workflows with their statuses, transitions, conditions, validators, "
            "and post-functions. Essential for understanding process flows."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dump_automation_rules",
        "description": (
            "Dump all Automation for Jira (A4J) rules from the in-memory cache. "
            "Includes triggers, conditions, actions, state, and execution counts. "
            "Cache is refreshed every 10 minutes."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dump_full_instance",
        "description": (
            "Nuclear option: dump EVERYTHING — global config, all schemes, all workflows, "
            "all automation rules, all screens with fields, all project configs. "
            "WARNING: This can be very large and slow on big instances. "
            "Prefer targeted dumps when possible."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ── Project tools ──────────────────────────────────────────────────────
    {
        "name": "list_projects",
        "description": "List all Jira projects with key, name, type, lead.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_project_config",
        "description": (
            "Get the full configuration chain for a project: which workflow scheme, "
            "issue type scheme, issue type screen scheme, and field configuration scheme "
            "it uses, plus its available issue types. Essential for understanding a project's setup."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {"type": "string", "description": "Jira project key (e.g. 'CORE')"},
            },
            "required": ["project_key"],
        },
    },
    {
        "name": "get_project_role_members",
        "description": "Get all roles and their members/actors for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {"type": "string", "description": "Jira project key"},
            },
            "required": ["project_key"],
        },
    },
    {
        "name": "get_project_components",
        "description": "Get components for a project with leads and descriptions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {"type": "string", "description": "Jira project key"},
            },
            "required": ["project_key"],
        },
    },
    {
        "name": "get_project_versions",
        "description": "Get versions for a project with release status and dates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {"type": "string", "description": "Jira project key"},
            },
            "required": ["project_key"],
        },
    },

    # ── Workflow tools ─────────────────────────────────────────────────────
    {
        "name": "list_workflows",
        "description": "List all workflows with name, status count, transition count.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_workflow_detail",
        "description": (
            "Get full workflow detail by name: all statuses, transitions with conditions, "
            "validators, post-functions, and properties. Use for deep process analysis."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_name": {"type": "string", "description": "Exact workflow name"},
            },
            "required": ["workflow_name"],
        },
    },
    {
        "name": "get_workflow_statuses_and_transitions",
        "description": (
            "Get full workflow statuses, transitions with screens and fields via the Workflow Designer API. "
            "For each transition shows: source/target status, transition screen (with tabs and field details), "
            "and rule counts (conditions, validators, post-functions). "
            "Also detects JSM approval patterns (Waiting for approval → Approved/Declined). "
            "Use this for detailed process analysis including what data is captured at each step."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_name": {"type": "string", "description": "Exact workflow name"},
            },
            "required": ["workflow_name"],
        },
    },
    {
        "name": "list_workflow_schemes",
        "description": "List all workflow schemes with default workflow and issue type mappings.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_workflow_scheme",
        "description": "Get a specific workflow scheme by ID with full issue-type-to-workflow mappings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Workflow scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },

    # ── Screen tools ───────────────────────────────────────────────────────
    {
        "name": "list_screens",
        "description": "List all screens with IDs and names.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_screen_tabs_and_fields",
        "description": "Get a screen's tabs with all fields in order. Shows exactly what users see.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "screen_id": {"type": "integer", "description": "Screen ID"},
            },
            "required": ["screen_id"],
        },
    },
    {
        "name": "list_screen_schemes",
        "description": (
            "List all screen schemes with their screens and inferred operation mappings "
            "(create/edit/view). Reconstructed from screens expand on DC 10."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_screen_scheme",
        "description": (
            "Get a screen scheme with its screens, operation mappings (create/edit/view), "
            "and tab names. Reconstructed from screens expand on DC 10."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Screen scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },

    # ── Field tools ────────────────────────────────────────────────────────
    {
        "name": "list_fields",
        "description": (
            "List all fields (system + custom) with types, search clause names. "
            "Set custom_only=true to see only custom fields."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "custom_only": {"type": "boolean", "description": "Only show custom fields", "default": False},
            },
        },
    },
    {
        "name": "get_field_configuration",
        "description": (
            "Get field configuration items — shows which fields are required, hidden, "
            "their renderer and description. The 'rules' for fields."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "fc_id": {"type": "integer", "description": "Field configuration ID"},
            },
            "required": ["fc_id"],
        },
    },
    {
        "name": "get_field_configuration_scheme",
        "description": "Get field configuration scheme — maps issue types to field configurations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Field configuration scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "find_field_usage",
        "description": (
            "Find where a field appears across ALL screens. "
            "Use to understand impact before modifying a field."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "field_id": {"type": "string", "description": "Field ID (e.g. 'customfield_10001' or 'summary')"},
            },
            "required": ["field_id"],
        },
    },
    {
        "name": "get_field_contexts",
        "description": (
            "Get custom field contexts — which projects and issue types the field is scoped to. "
            "Uses an internal API (unsupported, may break on upgrades). "
            "Shows allProjects/allIssueTypes flags and specific project/issue type lists."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "field_id": {"type": "string", "description": "Field ID (e.g. 'customfield_10001')"},
            },
            "required": ["field_id"],
        },
    },

    # ── Scheme tools ───────────────────────────────────────────────────────
    {
        "name": "get_permission_scheme",
        "description": "Get full permission scheme with all grants (who can do what).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Permission scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "list_permission_schemes",
        "description": "List all permission schemes with grant counts.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_notification_scheme",
        "description": "Get notification scheme with all event-to-notification mappings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Notification scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "list_notification_schemes",
        "description": "List all notification schemes.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_issue_type_scheme",
        "description": "Get issue type scheme — which issue types are available and which is default.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Issue type scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "get_issue_security_scheme",
        "description": "Get issue security scheme with security levels.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Issue security scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "get_priority_scheme",
        "description": "Get priority scheme (Jira DC 10 feature).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scheme_id": {"type": "integer", "description": "Priority scheme ID"},
            },
            "required": ["scheme_id"],
        },
    },
    {
        "name": "list_all_scheme_types",
        "description": "Overview of every scheme type and how many of each exist.",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ── Automation (A4J) tools ─────────────────────────────────────────────
    {
        "name": "list_automation_rules",
        "description": (
            "List A4J automation rules from the in-memory cache. "
            "Optionally filter by project_key. "
            "Shows name, state, trigger type, execution count. "
            "Cache is refreshed every 10 minutes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {
                    "type": "string",
                    "description": "Optional project key to filter rules. Omit for all rules.",
                },
            },
        },
    },
    {
        "name": "get_automation_rule_detail",
        "description": (
            "Get full automation rule detail from cache: trigger, conditions, actions, smart values."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "integer", "description": "Automation rule ID"},
            },
            "required": ["rule_id"],
        },
    },
    {
        "name": "refresh_automation_cache",
        "description": (
            "Force an immediate refresh of the automation rules cache. "
            "Use this if the cache appears empty or stale."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ── Analysis tools ─────────────────────────────────────────────────────
    {
        "name": "analyze_project_config_chain",
        "description": (
            "Resolve the FULL scheme chain for a project and report inconsistencies. "
            "Shows: project → issue types → workflow scheme → workflows, "
            "issue type screen scheme → screen schemes → screens, "
            "field configuration scheme → field configs. "
            "Reports issues (missing mappings) and warnings."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_key": {"type": "string", "description": "Jira project key"},
            },
            "required": ["project_key"],
        },
    },
    {
        "name": "search_config",
        "description": (
            "Free-text search across all config entities: fields, screens, workflows, "
            "workflow schemes, issue type schemes, permission schemes. "
            "Case-insensitive search on names and IDs."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search text"},
            },
            "required": ["query"],
        },
    },
]


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

async def _dispatch(
    client: JiraClient,
    automation_cache: AutomationCache,
    tool_name: str,
    args: dict[str, Any],
) -> str:
    """Route a tool call to the appropriate handler."""
    match tool_name:
        # Dump
        case "dump_global_config":
            return await dump.dump_global_config(client)
        case "dump_all_schemes":
            return await dump.dump_all_schemes(client)
        case "dump_workflows":
            return await dump.dump_workflows(client)
        case "dump_automation_rules":
            return await dump.dump_automation_rules(client, automation_cache)
        case "dump_full_instance":
            return await dump.dump_full_instance(client, automation_cache)

        # Projects
        case "list_projects":
            return await projects.list_projects(client)
        case "get_project_config":
            return await projects.get_project_config(client, args["project_key"])
        case "get_project_role_members":
            return await projects.get_project_role_members(client, args["project_key"])
        case "get_project_components":
            return await projects.get_project_components(client, args["project_key"])
        case "get_project_versions":
            return await projects.get_project_versions(client, args["project_key"])

        # Workflows
        case "list_workflows":
            return await workflows.list_workflows(client)
        case "get_workflow_detail":
            return await workflows.get_workflow_detail(client, args["workflow_name"])
        case "get_workflow_statuses_and_transitions":
            return await workflows.get_workflow_statuses_and_transitions(client, args["workflow_name"])
        case "list_workflow_schemes":
            return await workflows.list_workflow_schemes(client)
        case "get_workflow_scheme":
            return await workflows.get_workflow_scheme(client, args["scheme_id"])

        # Screens
        case "list_screens":
            return await screens.list_screens(client)
        case "get_screen_tabs_and_fields":
            return await screens.get_screen_tabs_and_fields(client, args["screen_id"])
        case "list_screen_schemes":
            return await screens.list_screen_schemes(client)
        case "get_screen_scheme":
            return await screens.get_screen_scheme(client, args["scheme_id"])

        # Fields
        case "list_fields":
            return await fields.list_fields(client, args.get("custom_only", False))
        case "get_field_configuration":
            return await fields.get_field_configuration(client, args["fc_id"])
        case "get_field_configuration_scheme":
            return await fields.get_field_configuration_scheme(client, args["scheme_id"])
        case "find_field_usage":
            return await fields.find_field_usage(client, args["field_id"])
        case "get_field_contexts":
            return await fields.get_field_contexts(client, args["field_id"])

        # Schemes
        case "get_permission_scheme":
            return await schemes.get_permission_scheme(client, args["scheme_id"])
        case "list_permission_schemes":
            return await schemes.list_permission_schemes(client)
        case "get_notification_scheme":
            return await schemes.get_notification_scheme(client, args["scheme_id"])
        case "list_notification_schemes":
            return await schemes.list_notification_schemes(client)
        case "get_issue_type_scheme":
            return await schemes.get_issue_type_scheme(client, args["scheme_id"])
        case "get_issue_security_scheme":
            return await schemes.get_issue_security_scheme(client, args["scheme_id"])
        case "get_priority_scheme":
            return await schemes.get_priority_scheme(client, args["scheme_id"])
        case "list_all_scheme_types":
            return await schemes.list_all_scheme_types(client)

        # Automation
        case "list_automation_rules":
            return await automation.list_automation_rules(automation_cache, args.get("project_key"))
        case "get_automation_rule_detail":
            return await automation.get_automation_rule_detail(automation_cache, args["rule_id"])
        case "refresh_automation_cache":
            count = await automation_cache.refresh()
            return json.dumps({"status": "refreshed", "rules_loaded": count})

        # Analysis
        case "analyze_project_config_chain":
            return await analysis.analyze_project_config_chain(client, args["project_key"])
        case "search_config":
            return await analysis.search_config(client, args["query"])

        case _:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ---------------------------------------------------------------------------
# Server factory
# ---------------------------------------------------------------------------

def create_server() -> tuple[Server, JiraClient, AutomationCache]:
    """Create and configure the MCP server with all tools.

    Returns the server, client, and automation cache so the caller can
    manage their lifecycle (start cache, close client).
    """
    server = Server("jira-dc-mcp")
    client = JiraClient()
    automation_cache = AutomationCache(client)

    @server.list_tools()
    async def handle_list_tools() -> list[Tool]:
        return [
            Tool(name=t["name"], description=t["description"], inputSchema=t["inputSchema"])
            for t in TOOLS
        ]

    @server.call_tool()
    async def handle_call_tool(name: str, arguments: dict[str, Any] | None) -> list[TextContent]:
        try:
            result = await _dispatch(client, automation_cache, name, arguments or {})
            return [TextContent(type="text", text=result)]
        except Exception as e:
            logger.exception("Tool %s failed", name)
            error_msg = json.dumps({"error": str(e), "tool": name}, indent=2)
            return [TextContent(type="text", text=error_msg)]

    return server, client, automation_cache
