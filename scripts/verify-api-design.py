#!/usr/bin/env python3
"""Verify the MCP Fig API design manifest and upstream coverage mapping."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "docs" / "api-surface.json"
DESIGN_PATH = ROOT / "docs" / "api-design.md"
AUDIT_PATH = ROOT / "docs" / "tool-audit.md"


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    tools = manifest["tools"]
    profiles = manifest["profiles"]
    core_tools = profiles["core"]["tools"]

    assert manifest["defaultProfile"] == "core"
    assert len(core_tools) == 12, f"core must expose 12 tools, got {len(core_tools)}"
    assert len(set(core_tools)) == 12, "core profile contains duplicate tools"
    assert len(tools) == 17, f"all-profile facade budget changed: {len(tools)}"
    assert set(core_tools) <= set(tools), "core references an unknown tool"
    assert "figma_execute" not in core_tools, "raw execute must not be in core"
    assert profiles["advanced"]["tools"] == ["figma_execute"]

    for tool_name, tool in tools.items():
        assert tool_name.startswith("figma_"), f"invalid tool name: {tool_name}"
        assert tool["profile"] in profiles, f"unknown profile on {tool_name}"
        assert tool["actions"], f"tool has no actions: {tool_name}"
        for action_name, action in tool["actions"].items():
            assert action["profile"] in profiles, (
                f"unknown action profile: {tool_name}.{action_name}"
            )
            assert action["mode"] in {"read", "write", "control"}
            assert action["risk"] in {"normal", "guarded", "destructive"}
            if action["risk"] == "destructive":
                assert "confirm" in action["required"] or "confirm?" in action["required"], (
                    f"destructive action lacks confirmation: {tool_name}.{action_name}"
                )

    execute = tools["figma_execute"]["actions"]["run"]
    assert execute["risk"] == "destructive"
    assert execute["dryRun"] is False, "raw code cannot promise a general dry-run"

    for profile_name, profile in profiles.items():
        assert len(profile["tools"]) == len(set(profile["tools"])), (
            f"duplicate tool in profile {profile_name}"
        )
        assert set(profile["tools"]) <= set(tools), (
            f"unknown tool in profile {profile_name}"
        )
        for tool_name, action_names in profile["extends"].items():
            assert tool_name in tools, f"unknown extended tool: {tool_name}"
            assert set(action_names) <= set(tools[tool_name]["actions"]), (
                f"unknown actions in profile {profile_name} for {tool_name}"
            )

    audit = AUDIT_PATH.read_text(encoding="utf-8")
    mappings = re.findall(
        r"^\| `((?:figma|figjam)_[^`]+)` \| .*? \| `(figma_[^`]+)`(?: [^|]*)? \|$",
        audit,
        re.MULTILINE,
    )
    assert len(mappings) == 113, f"expected 113 audit mappings, got {len(mappings)}"
    unknown_targets = sorted({target for _, target in mappings} - set(tools))
    assert not unknown_targets, f"audit maps to undefined facades: {unknown_targets}"

    design = DESIGN_PATH.read_text(encoding="utf-8")
    for required in (
        "## Profiles",
        "## Common input contract",
        "## Destructive-action policy",
        "## Result envelope",
        "## Capability discovery",
        "## Workflow validation",
    ):
        assert required in design, f"missing design section: {required}"

    action_count = sum(len(tool["actions"]) for tool in tools.values())
    print(
        f"verified {len(core_tools)} core tools, {len(tools)} all-profile tools, "
        f"{action_count} actions, and {len(mappings)} upstream mappings"
    )


if __name__ == "__main__":
    main()
