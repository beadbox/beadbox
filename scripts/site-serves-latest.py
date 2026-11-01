#!/usr/bin/env python3
"""Does beadbox.app serve the latest final release? (beadbox-2p8)

Reads the latest final of beadbox/beadbox (GET /releases/latest returns finals
only, never a prerelease or a draft) and the version the site offers for
download (its macOS DMG link, which is what users install). Exit 0 when they
match, or when the final is younger than the deploy window (the site deploys
from an hourly schedule, and GitHub starts schedules late); exit 1 when the
site lags past the window or cannot be read.

Environment:
  SITE_URL        page to read (default https://beadbox.app/)
  REPO            release repo (default beadbox/beadbox)
  LAG_HOURS       deploy window in hours (default 6)
  PRETEND_LATEST  compare against this version instead of the real latest final,
                  with no window (a dispatched proof of the red; changes nothing)
  GH_TOKEN        optional, sent to the GitHub API to stay off the anonymous limit
Cases and reds: scripts/test-site-serves-latest.py.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

DMG = re.compile(r"releases/download/v(\d+\.\d+\.\d+)/Beadbox-(\d+\.\d+\.\d+)-macOS-arm64\.dmg")


def served_version(html):
    """The single version the page offers for download, or an error."""
    found = {a for a, b in DMG.findall(html) if a == b}
    if not found:
        return None, "the page has no macOS download link of the form releases/download/vX.Y.Z/Beadbox-X.Y.Z-macOS-arm64.dmg"
    if len(found) > 1:
        return None, f"the page offers more than one version: {', '.join(sorted(found))}"
    return found.pop(), None


def latest_final(release):
    """(version, published_at datetime) from a /releases/latest response, or an error."""
    try:
        tag = release["tag_name"]
        published = datetime.strptime(release["published_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return None, None, "the latest-release response has no tag_name/published_at"
    if release.get("prerelease") or release.get("draft"):
        return None, None, f"the latest-release response is not a final ({tag})"
    m = re.fullmatch(r"v(\d+\.\d+\.\d+)", tag)
    if not m:
        return None, None, f"the latest final's tag is not vX.Y.Z: {tag}"
    return m.group(1), published, None


def same_version(a, b):
    return a == b


def verdict(html, release, now, lag_hours, pretend=None):
    """(ok, message)."""
    served, err = served_version(html)
    if err:
        return False, f"cannot read the served version: {err}"
    if pretend:
        latest, published = pretend, None
    else:
        latest, published, err = latest_final(release)
        if err:
            return False, f"cannot read the latest final: {err}"
    if same_version(served, latest):
        return True, f"OK: beadbox.app serves {served}, the latest final"
    if published is not None:
        age_h = (now - published).total_seconds() / 3600
        if age_h < lag_hours:
            return True, (f"OK (deploy window): beadbox.app serves {served}; final {latest} was published "
                          f"{age_h:.1f} h ago, inside the {lag_hours:g} h window")
        return False, (f"beadbox.app serves {served}, but the latest final is {latest}, "
                       f"published {age_h:.1f} h ago (window {lag_hours:g} h)")
    return False, f"beadbox.app serves {served}, but the expected version is {latest} (pretend_latest)"


def fetch(url, token=None):
    req = urllib.request.Request(url, headers={"User-Agent": "beadbox-site-freshness"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def main():
    site = os.environ.get("SITE_URL", "https://beadbox.app/")
    repo = os.environ.get("REPO", "beadbox/beadbox")
    lag = float(os.environ.get("LAG_HOURS", "6"))
    pretend = os.environ.get("PRETEND_LATEST", "").strip().lstrip("v") or None
    try:
        html = fetch(site)
    except Exception as e:  # noqa: BLE001 - any read failure is a red
        print(f"::error::cannot read {site}: {e}")
        return 1
    release = None
    if not pretend:
        try:
            release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/latest", os.environ.get("GH_TOKEN")))
        except Exception as e:  # noqa: BLE001
            print(f"::error::cannot read the latest release of {repo}: {e}")
            return 1
    ok, msg = verdict(html, release, datetime.now(timezone.utc), lag, pretend)
    print(msg if ok else f"::error title=beadbox.app is behind::{msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
