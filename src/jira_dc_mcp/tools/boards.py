"""Agile board introspection tools."""

from __future__ import annotations

import json

from ..client import JiraClient


async def list_boards(client: JiraClient, project_key: str | None = None) -> str:
    """List all agile boards, optionally filtered by project."""
    boards = await client.list_boards(project_key=project_key)
    result = [
        {
            "id": b.get("id"),
            "name": b.get("name"),
            "type": b.get("type"),
            "projectKey": (b.get("location") or {}).get("projectKey"),
            "projectName": (b.get("location") or {}).get("projectName"),
        }
        for b in boards
    ]
    return json.dumps(result, indent=2)


async def get_board_configuration(client: JiraClient, board_id: int) -> str:
    """Get board configuration: columns, estimation, ranking, filter."""
    config = await client.get_board_configuration(board_id)

    columns = []
    for col in (config.get("columnConfig") or {}).get("columns", []):
        columns.append({
            "name": col.get("name"),
            "statuses": [s.get("id") for s in col.get("statuses", [])],
            "min": col.get("min"),
            "max": col.get("max"),
        })

    estimation = config.get("estimation") or {}
    ranking = config.get("ranking") or {}
    filter_ref = config.get("filter") or {}

    result = {
        "id": config.get("id"),
        "name": config.get("name"),
        "type": config.get("type"),
        "filter": {
            "id": filter_ref.get("id"),
            "name": filter_ref.get("name"),
            "query": filter_ref.get("query"),
        },
        "columnConfig": {
            "constraintType": (config.get("columnConfig") or {}).get("constraintType"),
            "columns": columns,
        },
        "estimation": {
            "type": estimation.get("type"),
            "field": estimation.get("field", {}).get("displayName") if estimation.get("field") else None,
        },
        "ranking": {
            "rankCustomFieldId": ranking.get("rankCustomFieldId"),
        },
    }

    # Include sub-query (swimlane/quick filter) if present
    sub_query = config.get("subQuery")
    if sub_query:
        result["subQuery"] = sub_query

    return json.dumps(result, indent=2)
