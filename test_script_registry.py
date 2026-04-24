"""Test ScriptRunner Script Registry with PAT auth only."""
import asyncio
import json
import sys

sys.path.insert(0, "src")
from jira_dc_mcp.client import JiraClient


async def main():
    client = JiraClient()
    c = await client._get_client()

    resp = await c.post(
        "/rest/scriptrunner/latest/canned/com.onresolve.scriptrunner.canned.jira.admin.ScriptRegistry",
        headers={
            "X-Atlassian-Token": "no-check",
            "Referer": str(c.base_url) + "/plugins/servlet/scriptrunner/admin/script-registry",
        },
        json={"canned-script": "com.onresolve.scriptrunner.canned.jira.admin.ScriptRegistry"},
    )
    print(f"Status: {resp.status_code}")
    print(f"Content-Type: {resp.headers.get('content-type')}")
    if resp.status_code == 200:
        data = resp.json()
        with open("script_registry_dump_pat.json", "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print("Success! Written to script_registry_dump_pat.json")
        output = data.get("output", data)
        scripts = output.get("scripts", {})
        for tab, items in scripts.items():
            print(f"  {tab}: {len(items)} items")
    else:
        # Show just first 200 chars to see if it's HTML or JSON
        body = resp.text[:200]
        print(f"Body preview: {body}")

    await client.close()


asyncio.run(main())
