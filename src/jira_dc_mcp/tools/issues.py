"""Issue lookup tools."""
from __future__ import annotations

import json

import httpx

from ..client import JiraClient


async def get_issue(client: JiraClient, issue_key: str, fields: str | None = None) -> str:
    """Get a Jira issue by key with selected fields."""
    try:
        issue = await client.get_issue(issue_key, fields=fields)

        result: dict = {
            "key": issue.get("key"),
            "id": issue.get("id"),
            "self": issue.get("self"),
        }

        f = issue.get("fields", {})
        result["fields"] = {
            "summary": f.get("summary"),
            "status": _name(f.get("status")),
            "issuetype": _name(f.get("issuetype")),
            "priority": _name(f.get("priority")),
            "resolution": _name(f.get("resolution")),
            "assignee": _user(f.get("assignee")),
            "reporter": _user(f.get("reporter")),
            "created": f.get("created"),
            "updated": f.get("updated"),
            "resolutiondate": f.get("resolutiondate"),
            "labels": f.get("labels", []),
            "components": [c.get("name") for c in f.get("components", [])],
            "description": f.get("description"),
        }

        # Include any custom fields that were explicitly requested
        if fields:
            requested = {fid.strip() for fid in fields.split(",")}
            for fid in requested:
                if fid.startswith("customfield_") and fid not in result["fields"]:
                    result["fields"][fid] = f.get(fid)

        # Include links
        links = f.get("issuelinks", [])
        if links:
            result["fields"]["issuelinks"] = [
                {
                    "type": link.get("type", {}).get("name"),
                    "direction": "outward" if "outwardIssue" in link else "inward",
                    "issue": (link.get("outwardIssue") or link.get("inwardIssue", {})).get("key"),
                    "summary": (link.get("outwardIssue") or link.get("inwardIssue", {})).get("fields", {}).get("summary"),
                }
                for link in links
            ]

        # Include comments count and last few
        comment_data = f.get("comment", {})
        if comment_data:
            comments = comment_data.get("comments", [])
            result["fields"]["comment_count"] = comment_data.get("total", len(comments))
            result["fields"]["recent_comments"] = [
                {
                    "author": _user(c.get("author")),
                    "created": c.get("created"),
                    "body": c.get("body"),
                }
                for c in comments[-5:]  # last 5 comments
            ]

        return json.dumps(result, indent=2)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return json.dumps({"error": f"Issue not found: {issue_key}"})
        return json.dumps({"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"})


def _name(obj: dict | None) -> str | None:
    return obj.get("name") if obj else None


def _user(obj: dict | None) -> dict | None:
    if not obj:
        return None
    return {
        "key": obj.get("key"),
        "displayName": obj.get("displayName"),
    }
