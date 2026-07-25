#!/usr/bin/env python3
"""Verify the pinned Figma Console MCP inventory in docs/tool-audit.md."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

EXPECTED_COUNT = 113
AUDIT_PATH = Path(__file__).resolve().parents[1] / "docs" / "tool-audit.md"
ROW_PATTERN = re.compile(
    r"^\| `((?:figma|figjam)_[^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|",
    re.MULTILINE,
)


def main() -> None:
    text = AUDIT_PATH.read_text(encoding="utf-8")
    rows = ROW_PATTERN.findall(text)
    names = [row[0] for row in rows]

    assert len(rows) == EXPECTED_COUNT, (
        f"expected {EXPECTED_COUNT} inventory rows, found {len(rows)}"
    )
    assert len(set(names)) == EXPECTED_COUNT, "inventory contains duplicate tool names"
    assert names == sorted(names), "inventory must stay sorted by tool name"
    assert all(row[1].strip() != "Other" for row in rows), "unclassified domain found"
    assert {row[3].strip() for row in rows} <= {"core", "optional", "advanced"}, (
        "unknown exposure classification found"
    )

    effects = Counter(row[2].strip() for row in rows)
    assert effects == {
        "read": 51,
        "write": 50,
        "control/write": 4,
        "destructive/high": 8,
    }, f"unexpected effect counts: {dict(effects)}"

    exposures = Counter(row[3].strip() for row in rows)
    assert exposures == {"core": 56, "optional": 56, "advanced": 1}, (
        f"unexpected exposure counts: {dict(exposures)}"
    )

    for section in (
        "## Scope and evidence",
        "## Top 10 workflow trace",
        "## Recommended consolidation",
        "## Complete 113-tool inventory",
    ):
        assert section in text, f"missing required section: {section}"

    print(
        f"verified {len(rows)} unique tools; "
        f"{effects['destructive/high']} marked destructive/high"
    )


if __name__ == "__main__":
    main()
