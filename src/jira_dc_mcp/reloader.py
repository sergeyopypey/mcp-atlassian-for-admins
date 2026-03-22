"""Hot-reloader for MCP tool modules.

Polls source files for changes and reloads Python modules in-place so the
running MCP server picks up code changes without a restart.

How it works:
- An asyncio background task checks mtimes of all .py files in the package
  every `interval` seconds.
- When a change is detected, the affected module (and server.py, which holds
  the TOOLS list and dispatcher) are reloaded via importlib.reload().
- Because MCP handler closures resolve module-level globals (TOOLS, _dispatch)
  at call time via LOAD_GLOBAL, the next tool invocation automatically uses
  the updated code.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import os
import sys
from pathlib import Path
from typing import Dict

logger = logging.getLogger(__name__)

# Package root on disk
_PKG_DIR = Path(__file__).resolve().parent

# Ordered list of sub-modules to reload (tools first, then server last)
_RELOAD_ORDER = [
    "jira_dc_mcp.tools.dump",
    "jira_dc_mcp.tools.projects",
    "jira_dc_mcp.tools.workflows",
    "jira_dc_mcp.tools.screens",
    "jira_dc_mcp.tools.fields",
    "jira_dc_mcp.tools.schemes",
    "jira_dc_mcp.tools.automation",
    "jira_dc_mcp.tools.analysis",
    "jira_dc_mcp.client",
    "jira_dc_mcp.automation_cache",
    "jira_dc_mcp.server",  # must be last — re-imports tools & rebuilds TOOLS list
]


def _snapshot_mtimes() -> Dict[str, float]:
    """Return {filepath: mtime} for every .py file in the package."""
    result = {}
    for root, _dirs, files in os.walk(_PKG_DIR):
        for fname in files:
            if fname.endswith(".py"):
                fpath = os.path.join(root, fname)
                try:
                    result[fpath] = os.path.getmtime(fpath)
                except OSError:
                    pass
    return result


def _reload_modules() -> list[str]:
    """Reload all package modules in dependency order.

    Returns list of module names that were successfully reloaded.
    """
    reloaded = []
    for mod_name in _RELOAD_ORDER:
        mod = sys.modules.get(mod_name)
        if mod is None:
            continue
        try:
            importlib.reload(mod)
            reloaded.append(mod_name)
        except Exception:
            logger.exception("Failed to reload %s", mod_name)
    return reloaded


class Reloader:
    """Watches package source files and reloads modules on change."""

    def __init__(self, interval: float = 1.0):
        self._interval = interval
        self._task: asyncio.Task | None = None
        self._mtimes: Dict[str, float] = {}

    async def start(self) -> None:
        self._mtimes = _snapshot_mtimes()
        self._task = asyncio.create_task(self._watch_loop())
        logger.info(
            "Hot-reloader started — watching %d files in %s (poll every %.1fs)",
            len(self._mtimes),
            _PKG_DIR,
            self._interval,
        )

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Hot-reloader stopped")

    async def _watch_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            new_mtimes = _snapshot_mtimes()
            changed = self._detect_changes(new_mtimes)
            if changed:
                logger.info("File changes detected: %s", ", ".join(changed))
                reloaded = _reload_modules()
                if reloaded:
                    logger.info(
                        "Reloaded %d modules: %s",
                        len(reloaded),
                        ", ".join(m.split(".")[-1] for m in reloaded),
                    )
                self._mtimes = new_mtimes

    def _detect_changes(self, new_mtimes: Dict[str, float]) -> list[str]:
        """Return list of changed file paths."""
        changed = []
        all_paths = set(self._mtimes) | set(new_mtimes)
        for path in all_paths:
            old_mt = self._mtimes.get(path)
            new_mt = new_mtimes.get(path)
            if old_mt != new_mt:
                changed.append(os.path.basename(path))
        return changed
