"""User lookup tools."""
from __future__ import annotations

import json

import httpx

from ..client import JiraClient


async def get_user(client: JiraClient, key: str) -> str:
    """Get user details by key, username, or user ID."""
    try:
        user = await client.get_user(key)
        return json.dumps(
            {
                "key": user.get("key"),
                "name": user.get("name"),
                "displayName": user.get("displayName"),
                "emailAddress": user.get("emailAddress"),
                "active": user.get("active"),
            },
            indent=2,
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return json.dumps({"error": f"User not found: {key}"})
        return json.dumps({"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"})


async def find_users(client: JiraClient, query: str, max_results: int = 10) -> str:
    """Search for users by username, display name, or email."""
    try:
        users = await client.find_users(query, max_results)
        return json.dumps(
            [
                {
                    "key": u.get("key"),
                    "name": u.get("name"),
                    "displayName": u.get("displayName"),
                    "emailAddress": u.get("emailAddress"),
                    "active": u.get("active"),
                }
                for u in users
            ],
            indent=2,
        )
    except httpx.HTTPStatusError as e:
        return json.dumps({"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"})
