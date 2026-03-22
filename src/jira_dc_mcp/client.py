"""Jira Data Center 10 REST API client.

Covers REST API v2 and Automation for Jira (A4J / cb-automation) endpoints.
Uses httpx for async HTTP with connection pooling.
"""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults & helpers
# ---------------------------------------------------------------------------

_PAGINATION_MAX = 1000  # safety cap so we never loop forever


def _env(name: str, default: str | None = None, required: bool = False) -> str | None:
    val = os.environ.get(name, default)
    if required and not val:
        raise RuntimeError(f"Environment variable {name} is required but not set")
    return val


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class JiraClient:
    """Async wrapper around Jira DC 10 REST APIs."""

    def __init__(self) -> None:
        self.base_url = _env("JIRA_BASE_URL", required=True).rstrip("/")
        self.verify_ssl = _env("JIRA_VERIFY_SSL", "true").lower() in ("true", "1", "yes")

        auth_type = _env("JIRA_AUTH_TYPE", "pat")
        if auth_type == "pat":
            token = _env("JIRA_PAT", required=True)
            self._headers = {"Authorization": f"Bearer {token}"}
        else:
            user = _env("JIRA_USERNAME", required=True)
            pwd = _env("JIRA_PASSWORD", required=True)
            import base64
            creds = base64.b64encode(f"{user}:{pwd}".encode()).decode()
            self._headers = {"Authorization": f"Basic {creds}"}

        self._headers["Accept"] = "application/json"
        self._headers["Content-Type"] = "application/json"
        self._client: httpx.AsyncClient | None = None

    # -- lifecycle -----------------------------------------------------------

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=self._headers,
                verify=self.verify_ssl,
                timeout=60.0,
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # -- low-level -----------------------------------------------------------

    async def get(self, path: str, params: dict | None = None) -> Any:
        client = await self._get_client()
        resp = await client.get(path, params=params)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def post(self, path: str, json: Any = None) -> Any:
        client = await self._get_client()
        resp = await client.post(path, json=json)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def put(self, path: str, json: Any = None) -> Any:
        client = await self._get_client()
        resp = await client.put(path, json=json)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def delete(self, path: str) -> None:
        client = await self._get_client()
        resp = await client.delete(path)
        resp.raise_for_status()

    async def get_paged(
        self, path: str, key: str = "values", params: dict | None = None,
        start_param: str = "startAt", max_param: str = "maxResults",
        page_size: int = 50,
    ) -> list[Any]:
        """Auto-paginate endpoints that return {startAt, maxResults, total, <key>}."""
        params = dict(params or {})
        results: list[Any] = []
        start = 0
        for _ in range(_PAGINATION_MAX):
            params[start_param] = start
            params[max_param] = page_size
            data = await self.get(path, params)
            batch = data.get(key, [])
            results.extend(batch)
            total = data.get("total", len(results))
            if len(results) >= total or not batch:
                break
            start += len(batch)
        return results

    # ======================================================================
    # REST API v2 — read operations
    # ======================================================================

    # -- server info ---------------------------------------------------------
    async def server_info(self) -> dict:
        return await self.get("/rest/api/2/serverInfo")

    async def configuration(self) -> dict:
        return await self.get("/rest/api/2/configuration")

    # -- projects ------------------------------------------------------------
    async def list_projects(self, expand: str = "description,lead,url,projectKeys") -> list[dict]:
        return await self.get("/rest/api/2/project", {"expand": expand})

    async def get_project(self, key: str, expand: str = "description,lead,url,issueTypes,projectKeys") -> dict:
        return await self.get(f"/rest/api/2/project/{quote(key)}", {"expand": expand})

    async def get_project_components(self, key: str) -> list[dict]:
        return await self.get(f"/rest/api/2/project/{quote(key)}/components")

    async def get_project_versions(self, key: str) -> list[dict]:
        return await self.get(f"/rest/api/2/project/{quote(key)}/versions")

    async def get_project_roles(self, key: str) -> dict:
        return await self.get(f"/rest/api/2/project/{quote(key)}/role")

    async def get_project_role_actors(self, key: str, role_id: int) -> dict:
        return await self.get(f"/rest/api/2/project/{quote(key)}/role/{role_id}")

    # -- issue types ---------------------------------------------------------
    async def list_issue_types(self) -> list[dict]:
        return await self.get("/rest/api/2/issuetype")

    # -- statuses ------------------------------------------------------------
    async def list_statuses(self) -> list[dict]:
        return await self.get("/rest/api/2/status")

    # -- resolutions ---------------------------------------------------------
    async def list_resolutions(self) -> list[dict]:
        return await self.get("/rest/api/2/resolution")

    # -- priorities ----------------------------------------------------------
    async def list_priorities(self) -> list[dict]:
        return await self.get("/rest/api/2/priority")

    # -- fields --------------------------------------------------------------
    async def list_fields(self) -> list[dict]:
        return await self.get("/rest/api/2/field")

    # -- issue link types ----------------------------------------------------
    async def list_issue_link_types(self) -> list[dict]:
        data = await self.get("/rest/api/2/issueLinkType")
        return data.get("issueLinkTypes", [])

    # ======================================================================
    # Workflows
    # ======================================================================

    async def list_workflows(self) -> list[dict]:
        """GET /rest/api/2/workflow — returns a plain JSON array on DC (not paginated)."""
        return await self.get("/rest/api/2/workflow")

    async def get_workflow_by_name(self, name: str) -> dict | None:
        """Get a single workflow by exact name (filter from list)."""
        workflows = await self.list_workflows()
        for wf in workflows:
            if wf.get("name") == name:
                return wf
        return None

    async def get_workflow_transitions(self, workflow_id: str | int) -> list[dict]:
        """DC 10 extended workflow API — transitions with conditions/validators/post-functions."""
        try:
            return await self.get(f"/rest/api/2/workflow/{workflow_id}/transitions")
        except httpx.HTTPStatusError:
            # Fallback: try via workflow name encoding
            return []

    async def get_workflow_designer(self, workflow_name: str) -> dict | None:
        """Get full workflow layout from the Workflow Designer REST plugin.

        Returns statuses (with Jira status IDs) and transitions (with source/target
        IDs, screen info, and rule counts for conditions/validators/post-functions).
        Available on Jira DC 8.x+ with the built-in workflow designer plugin.
        """
        try:
            return await self.get(
                "/rest/workflowDesigner/latest/workflows",
                params={"name": workflow_name},
            )
        except httpx.HTTPStatusError:
            return None

    async def export_workflow_xml(self, workflow_name: str) -> str | None:
        """Export workflow as XML via ScriptRunner custom endpoint."""
        try:
            client = await self._get_client()
            resp = await client.get(
                "/rest/scriptrunner/latest/custom/exportWorkflow",
                params={"workflowName": workflow_name},
            )
            resp.raise_for_status()
            return resp.text if resp.content else None
        except httpx.HTTPStatusError as e:
            logger.warning("ScriptRunner exportWorkflow failed: %s %s", e.response.status_code, e.response.text[:200])
            return None
        except Exception as e:
            logger.error("ScriptRunner exportWorkflow error: %s: %s", type(e).__name__, e)
            return None

    async def get_project_statuses(self, project_key: str) -> list[dict]:
        """Get valid statuses per issue type for a project."""
        return await self.get(f"/rest/api/2/project/{quote(project_key)}/statuses")

    async def list_jsm_service_desks(self) -> list[dict]:
        """List all JSM service desks."""
        try:
            data = await self.get("/rest/servicedeskapi/servicedesk")
            return data.get("values", [])
        except httpx.HTTPStatusError:
            return []

    # -- createmeta / editmeta -----------------------------------------------

    async def get_createmeta_fields(self, project_key: str, issue_type_id: str) -> list[dict]:
        """Get fields available on the CREATE screen for a project + issue type."""
        return await self.get_paged(
            f"/rest/api/2/issue/createmeta/{quote(project_key)}/issuetypes/{issue_type_id}",
            key="values",
        )

    async def get_editmeta(self, issue_key: str) -> dict:
        """Get fields available on the EDIT screen for an issue."""
        data = await self.get(f"/rest/api/2/issue/{quote(issue_key)}/editmeta")
        return data.get("fields", {})

    # -- custom field contexts (internal, unsupported) -----------------------

    async def get_field_context(self, field_id: str) -> list[dict]:
        """Get custom field contexts (project + issue type scoping).

        Uses the internal /rest/internal/2/field/{id}/context endpoint.
        NOT officially supported — may break on upgrades.
        """
        try:
            return await self.get(f"/rest/internal/2/field/{quote(field_id)}/context")
        except httpx.HTTPStatusError:
            return []

    # ======================================================================
    # Schemes
    # ======================================================================

    # -- workflow schemes ----------------------------------------------------
    async def list_workflow_schemes(self) -> list[dict]:
        """List workflow schemes. DC 10 does not support GET on the collection
        endpoint (returns 405), so we fall back to enumerating by ID."""
        # Try paginated GET first (works on some DC 10.x patch levels)
        try:
            return await self.get_paged("/rest/api/2/workflowscheme", key="values")
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 405:
                raise
        # Fallback: discover scheme IDs from project associations, then fetch each.
        # DC uses IDs in the 10000+ range, so sequential probing is impractical.
        scheme_ids: set[int] = set()

        # Discover scheme IDs via project list — each project exposes its workflow scheme
        try:
            projects = await self.list_projects(expand="")
            for p in projects:
                try:
                    data = await self.get(
                        f"/rest/api/2/project/{p['key']}/workflowscheme"
                    )
                    if isinstance(data, dict) and data.get("id"):
                        scheme_ids.add(int(data["id"]))
                except httpx.HTTPStatusError:
                    pass
        except Exception:
            pass

        # Fetch full details for each discovered scheme
        schemes: list[dict] = []
        for sid in sorted(scheme_ids):
            try:
                scheme = await self.get(f"/rest/api/2/workflowscheme/{sid}")
                schemes.append(scheme)
            except httpx.HTTPStatusError:
                pass
        return schemes

    async def get_workflow_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/workflowscheme/{scheme_id}")

    # -- issue type schemes --------------------------------------------------
    async def list_issue_type_schemes(self) -> list[dict]:
        """DC 10: returns all schemes in 'schemes' key (not paginated)."""
        data = await self.get("/rest/api/2/issuetypescheme")
        return data.get("schemes", []) if isinstance(data, dict) else data

    async def get_issue_type_scheme(self, scheme_id: int) -> dict:
        """DC 10: supports ?expand=issueTypes,defaultIssueType."""
        return await self.get(
            f"/rest/api/2/issuetypescheme/{scheme_id}",
            params={"expand": "issueTypes,defaultIssueType"},
        )

    # -- issue type screen schemes -------------------------------------------
    # NOTE: /rest/api/2/issuetypescreenscheme returns 404 on DC 10.3.12.
    # No known alternative endpoint.
    async def list_issue_type_screen_schemes(self) -> list[dict]:
        try:
            return await self.get_paged("/rest/api/2/issuetypescreenscheme", key="values")
        except httpx.HTTPStatusError:
            return []

    async def get_issue_type_screen_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/issuetypescreenscheme/{scheme_id}")

    async def get_issue_type_screen_scheme_items(self, scheme_ids: list[int] | None = None) -> list[dict]:
        params = {}
        if scheme_ids:
            params["issueTypeScreenSchemeId"] = scheme_ids
        try:
            return await self.get_paged("/rest/api/2/issuetypescreenscheme/mapping", key="values", params=params)
        except httpx.HTTPStatusError:
            return []

    # -- screen schemes ------------------------------------------------------
    # NOTE: /rest/api/2/screenscheme returns 404 on DC 10.3.12.
    # No known alternative endpoint.
    async def list_screen_schemes(self) -> list[dict]:
        try:
            return await self.get_paged("/rest/api/2/screenscheme", key="values")
        except httpx.HTTPStatusError:
            return []

    async def get_screen_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/screenscheme/{scheme_id}")

    # -- screens -------------------------------------------------------------
    async def list_screens(self, expand: str = "") -> list[dict]:
        """DC 10 uses key 'screens' instead of 'values' for this endpoint.

        Supported expand values: fieldScreenSchemes, fieldScreenWorkflows, deletable, fieldScreenTabs
        """
        params = {}
        if expand:
            params["expand"] = expand
        return await self.get_paged("/rest/api/2/screens", key="screens", params=params)

    async def get_screen_tabs(self, screen_id: int) -> list[dict]:
        return await self.get(f"/rest/api/2/screens/{screen_id}/tabs")

    async def get_screen_tab_fields(self, screen_id: int, tab_id: int) -> list[dict]:
        return await self.get(f"/rest/api/2/screens/{screen_id}/tabs/{tab_id}/fields")

    async def get_screen_full(self, screen_id: int) -> dict:
        """Get screen with all tabs and their fields."""
        tabs = await self.get_screen_tabs(screen_id)
        for tab in tabs:
            tab["fields"] = await self.get_screen_tab_fields(screen_id, tab["id"])
        return {"screenId": screen_id, "tabs": tabs}

    # -- field configurations ------------------------------------------------
    # NOTE: /rest/api/2/fieldconfiguration returns 404 on DC 10.3.12.
    # No known alternative endpoint.
    async def list_field_configurations(self) -> list[dict]:
        try:
            return await self.get_paged("/rest/api/2/fieldconfiguration", key="values")
        except httpx.HTTPStatusError:
            return []

    async def get_field_configuration_items(self, fc_id: int) -> list[dict]:
        try:
            return await self.get_paged(f"/rest/api/2/fieldconfiguration/{fc_id}/fields", key="values")
        except httpx.HTTPStatusError:
            return []

    # -- field configuration schemes -----------------------------------------
    # NOTE: /rest/api/2/fieldconfigurationscheme returns 404 on DC 10.3.12.
    # No known alternative endpoint.
    async def list_field_configuration_schemes(self) -> list[dict]:
        try:
            return await self.get_paged("/rest/api/2/fieldconfigurationscheme", key="values")
        except httpx.HTTPStatusError:
            return []

    async def get_field_configuration_scheme_mapping(self, scheme_id: int) -> list[dict]:
        try:
            return await self.get_paged(
                f"/rest/api/2/fieldconfigurationscheme/mapping",
                key="values",
                params={"fieldConfigurationSchemeId": scheme_id},
            )
        except httpx.HTTPStatusError:
            return []

    # -- permission schemes --------------------------------------------------
    async def list_permission_schemes(self) -> list[dict]:
        data = await self.get("/rest/api/2/permissionscheme", {"expand": "all"})
        return data.get("permissionSchemes", [])

    async def get_permission_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/permissionscheme/{scheme_id}", {"expand": "all"})

    # -- notification schemes ------------------------------------------------
    async def list_notification_schemes(self) -> list[dict]:
        return await self.get_paged("/rest/api/2/notificationscheme", key="values")

    async def get_notification_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/notificationscheme/{scheme_id}", {"expand": "all"})

    # -- issue security schemes ----------------------------------------------
    async def list_issue_security_schemes(self) -> list[dict]:
        data = await self.get("/rest/api/2/issuesecurityschemes")
        return data.get("issueSecuritySchemes", [])

    async def get_issue_security_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/issuesecurityschemes/{scheme_id}")

    async def get_issue_security_levels(self, scheme_id: int) -> list[dict]:
        data = await self.get(f"/rest/api/2/issuesecurityschemes/{scheme_id}/members")
        return data.get("body", data) if isinstance(data, dict) else data

    # -- priority schemes (DC 10) -------------------------------------------
    async def list_priority_schemes(self) -> list[dict]:
        try:
            return await self.get_paged("/rest/api/2/priorityscheme", key="values")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return []  # endpoint might not exist on older DCs
            raise

    async def get_priority_scheme(self, scheme_id: int) -> dict:
        return await self.get(f"/rest/api/2/priorityscheme/{scheme_id}")

    # ======================================================================
    # Agile boards
    # ======================================================================

    async def list_boards(self, project_key: str | None = None) -> list[dict]:
        """List all agile boards. Optionally filter by project key."""
        params = {}
        if project_key:
            params["projectKeyOrId"] = project_key
        try:
            return await self.get_paged(
                "/rest/agile/1.0/board", key="values", params=params,
            )
        except httpx.HTTPStatusError:
            return []

    async def get_board_configuration(self, board_id: int) -> dict:
        """Get board configuration: columns, estimation, ranking, filter."""
        return await self.get(f"/rest/agile/1.0/board/{board_id}/configuration")

    # ======================================================================
    # JSM Service Desk — SLAs and queues
    # ======================================================================

    async def get_service_desk_slas(self, service_desk_id: int) -> list[dict]:
        """Get SLA metrics for a service desk.

        Note: The servicedeskapi may require the JSM agent to have appropriate permissions.
        """
        try:
            data = await self.get(
                f"/rest/servicedeskapi/servicedesk/{service_desk_id}/sla/metrics"
            )
            return data.get("values", []) if isinstance(data, dict) else data
        except httpx.HTTPStatusError:
            return []

    async def get_service_desk_queues(self, service_desk_id: int) -> list[dict]:
        """Get queues for a service desk."""
        try:
            data = await self.get(
                f"/rest/servicedeskapi/servicedesk/{service_desk_id}/queue"
            )
            return data.get("values", []) if isinstance(data, dict) else data
        except httpx.HTTPStatusError:
            return []

    # ======================================================================
    # Filters, dashboards, webhooks
    # ======================================================================

    async def list_filters(self) -> list[dict]:
        """List favourite/shared filters visible to the authenticated user."""
        try:
            return await self.get("/rest/api/2/filter/favourite")
        except httpx.HTTPStatusError:
            return []

    async def list_dashboards(self) -> list[dict]:
        """List all dashboards."""
        try:
            return await self.get_paged(
                "/rest/api/2/dashboard", key="dashboards",
            )
        except httpx.HTTPStatusError:
            return []

    async def list_webhooks(self) -> list[dict]:
        """List all registered webhooks."""
        try:
            return await self.get("/rest/api/2/webhook")
        except httpx.HTTPStatusError:
            return []

    # ======================================================================
    # Project categories
    # ======================================================================

    async def list_project_categories(self) -> list[dict]:
        """List all project categories."""
        try:
            return await self.get("/rest/api/2/projectCategory")
        except httpx.HTTPStatusError:
            return []

    # ======================================================================
    # Scheme ↔ Project associations (DC 10)
    # ======================================================================

    async def get_workflow_scheme_project_associations(self, scheme_id: int) -> list[dict]:
        """Which projects use this workflow scheme."""
        try:
            data = await self.get(
                "/rest/api/2/workflowscheme/project",
                params={"workflowSchemeId": scheme_id},
            )
            return data.get("values", [])
        except httpx.HTTPStatusError:
            return []

    async def get_issue_type_scheme_project_associations(self) -> list[dict]:
        return await self.get_paged("/rest/api/2/issuetypescheme/project", key="values")

    async def get_issue_type_screen_scheme_project_associations(self) -> list[dict]:
        return await self.get_paged("/rest/api/2/issuetypescreenscheme/project", key="values")

    async def get_field_config_scheme_project_associations(self) -> list[dict]:
        return await self.get_paged("/rest/api/2/fieldconfigurationscheme/project", key="values")

    # ======================================================================
    # Automation for Jira (A4J) — /rest/cb-automation/
    # ======================================================================

    async def export_automation_rules(self) -> list[dict]:
        """Export all automation rules via the single GLOBAL export endpoint."""
        try:
            client = await self._get_client()
            resp = await client.get("/rest/cb-automation/latest/project/GLOBAL/rule/export")
            logger.info("A4J export response: status=%s, content_length=%s", resp.status_code, len(resp.content))
            resp.raise_for_status()
            if not resp.content:
                logger.warning("A4J export returned empty body")
                return []
            data = resp.json()
            logger.info("A4J export data type=%s, keys=%s", type(data).__name__, list(data.keys()) if isinstance(data, dict) else f"list[{len(data)}]")
            if isinstance(data, list):
                return data
            return data.get("rules", data.get("results", data.get("values", [])))
        except httpx.HTTPStatusError as e:
            logger.warning("A4J rule export endpoint failed: status=%s, body=%s", e.response.status_code, e.response.text[:500])
            return []
        except Exception as e:
            logger.error("A4J rule export unexpected error: %s: %s", type(e).__name__, e)
            return []
