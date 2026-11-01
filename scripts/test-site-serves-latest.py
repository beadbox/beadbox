#!/usr/bin/env python3
"""Table test of scripts/site-serves-latest.py (beadbox-2p8).

Each row is one named case: the page the site serves, the latest-final
response, and whether the check passes. Reds run every time against the real
source, edited: a compare that always says "same" must fail the lag row, and a
window of infinity must fail it too.

Usage: python3 -I scripts/test-site-serves-latest.py  (from the repo root)
"""

import os
import sys
import types
from datetime import datetime, timezone

PATH = os.path.join(os.getcwd(), "scripts", "site-serves-latest.py")


def load(src):
    mod = types.ModuleType("site_serves_latest")
    exec(compile(src, PATH, "exec"), mod.__dict__)
    return mod


def page(*versions):
    links = "".join(
        f'<a href="https://github.com/beadbox/beadbox/releases/download/v{v}/Beadbox-{v}-macOS-arm64.dmg">'
        f'<a href="https://github.com/beadbox/beadbox/releases/download/v{v}/beadbox_{v}_Linux_amd64.deb">'
        for v in versions)
    return f"<html><body>Beadbox 0.15.0 changelog v0.9.0 {links}</body></html>"


def rel(tag, published, prerelease=False, draft=False):
    return {"tag_name": tag, "published_at": published, "prerelease": prerelease, "draft": draft}


NOW = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)
OLD = "2026-11-01T18:53:59Z"     # 17.1 h before NOW
FRESH = "2026-11-02T10:00:00Z"   # 2 h before NOW

# (name, html, release, pretend, expected ok)
ROWS = [
    ("the site serves the latest final", page("0.32.0"), rel("v0.32.0", OLD), None, True),
    ("the site lags an old final", page("0.29.1"), rel("v0.32.0", OLD), None, False),
    ("the site lags a final inside the deploy window", page("0.32.0"), rel("v0.33.0", FRESH), None, True),
    ("the page has no download link", "<html>Beadbox</html>", rel("v0.32.0", OLD), None, False),
    ("the page offers two versions", page("0.31.0", "0.32.0"), rel("v0.32.0", OLD), None, False),
    ("the DMG link's path and file name disagree", page("0.32.0").replace("Beadbox-0.32.0", "Beadbox-0.31.0"), rel("v0.32.0", OLD), None, False),
    ("the release response is a prerelease", page("0.32.0"), rel("v0.33.0-rc.1", OLD, prerelease=True), None, False),
    ("the release response is unreadable", page("0.32.0"), {"message": "Not Found"}, None, False),
    ("the latest tag is not vX.Y.Z", page("0.32.0"), rel("nightly", OLD), None, False),
    ("pretend_latest differs from the served version (the dispatched red)", page("0.32.0"), None, "0.31.0", False),
    ("pretend_latest equals the served version", page("0.32.0"), None, "0.32.0", True),
]


def table(mod):
    out = []
    for name, html, release, pretend, want in ROWS:
        ok, msg = mod.verdict(html, release, NOW, 6, pretend)
        out.append((name, want, ok, msg))
    return out


def main():
    src = open(PATH, encoding="utf-8").read()
    bad = 0
    rows = table(load(src))
    for name, want, got, msg in rows:
        good = want == got
        bad += not good
        print(f"{'ok' if good else 'FAIL'} :: {name} :: {'passes' if got else 'red'} ({msg})")
    reds = sum(1 for r in ROWS if not r[4])
    print(f"site freshness table: {len(rows) - bad} passed, {bad} failed ({len(rows) - reds} pass rows, {reds} red rows)")

    for label, old, new, row in [
        ("a compare that always says 'same'", "def same_version(a, b):\n    return a == b",
         "def same_version(a, b):\n    return True", "the site lags an old final"),
        ("a window that never closes", "if age_h < lag_hours:", "if True:", "the site lags an old final"),
        ("a reader that takes the newest of two versions",
         "    if len(found) > 1:\n        return None, f\"the page offers more than one version: {', '.join(sorted(found))}\"\n    return found.pop(), None",
         "    return max(found), None", "the page offers two versions"),
    ]:
        if old not in src:
            print(f"red FAIL :: {label}: the text to mutate is not in the script (the red would prove nothing)")
            bad += 1
            continue
        hit = [r for r in table(load(src.replace(old, new))) if r[0] == row and r[1] != r[2]]
        print(f"red {'ok' if hit else 'FAIL'} :: {label}" + (f": caught by '{row}'" if hit else f": '{row}' did not fail"))
        bad += not hit

    print(f"site freshness: {'ok' if bad == 0 else f'{bad} problem(s)'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
