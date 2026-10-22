#!/usr/bin/env python3
"""Always-on history for Synapse's live mode.

Follows Wikimedia's recent-changes stream around the clock and publishes an
exact rolling history: per-second counts for the last hour, per-minute counts
for the last day, per-wiki totals, detected bursts, and where geotagged pages
were edited. Nothing is sampled or estimated.

Exactness comes from three rules:
  * Events are filed by their own timestamp, and committed only once they are
    older than SETTLE_S, by which time no earlier event can still arrive. The
    snapshot is complete for every second before its `boundary`.
  * Every connection, including the first after a restart, asks Wikimedia to
    replay from just before the boundary, and events are deduplicated by id.
    A dropped connection or a night with the PC asleep leaves no hole.
  * Seconds the collector could not account for are published as coverage
    gaps, never as zeros.

The page loads the snapshot, replays from the same boundary itself, and is
exact up to the current second.

Standard library only and deliberately light: one thread, one streaming HTTP
connection, at most two coordinate lookups a second, idle CPU priority, and
only one copy can run at a time.
"""

from __future__ import annotations

import heapq
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, deque
from datetime import datetime, timezone
from pathlib import Path

STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"
USER_AGENT = "SynapseCollector/2.0 (https://github.com/clark719664/synapse)"
SETTLE_S = 15
SECONDS_KEPT = 3600
MINUTES_KEPT = 1440
PIN_HOURS = 24
RECENT_PINS_S = 600
LOOKUP_INTERVAL_S = 0.5
LOOKUP_QUEUE_LIMIT = 50_000
COORD_CACHE = 50_000
PUBLISH_INTERVAL_S = float(os.environ.get("SYNAPSE_PUBLISH_S", 60))
MAX_LAG_MS = 60_000
SERIES = ("total", "flagged", "bots", "anonymous", "automatic")

IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
IPV6 = re.compile(r"^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$", re.I)
REVERT = re.compile(
    r"\b(revert(ed|ing)?|undid|undo|rollback|rv|rvv)\b|rückgängig|annulation|révocation|revertid[ao]s?|откат|отмена правки|取り消し|回退|撤销",
    re.I,
)
MODERATION_LOGS = {"block", "delete", "abusefilter", "protect", "suppress"}
WIKIMEDIA_HOST = re.compile(
    r"(^|\.)(wikipedia|wikimedia|wikidata|wiktionary|wikisource|wikiquote|wikibooks|wikinews|wikivoyage|wikiversity|wikifunctions|mediawiki)\.org$"
)
EDITORS = ("registered", "anonymous", "bots")


def classify_editor(user: str, bot: bool) -> str:
    if bot:
        return "bots"
    if user.startswith("~") or IPV4.match(user) or IPV6.match(user):
        return "anonymous"
    return "registered"


def time_ms(iso) -> int:
    return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_change(data: str) -> dict | None:
    """The fields the collector needs from one EventStreams message, or None."""
    try:
        d = json.loads(data)
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    meta = d.get("meta") or {}
    if meta.get("domain") == "canary":
        return None
    host, kind, eid = d.get("server_name"), d.get("type"), meta.get("id")
    if not isinstance(host, str) or not isinstance(kind, str) or not isinstance(eid, str) or not WIKIMEDIA_HOST.search(host):
        return None
    try:
        dt = time_ms(meta.get("dt"))
    except (TypeError, ValueError):
        return None
    user = d.get("user") if isinstance(d.get("user"), str) else ""
    comment = d.get("comment") if isinstance(d.get("comment"), str) else ""
    log_type = d.get("log_type") if isinstance(d.get("log_type"), str) else None
    return {
        "id": eid,
        "dt": dt,
        "host": host,
        "type": kind,
        "title": d.get("title") if isinstance(d.get("title"), str) else "",
        "namespace": d.get("namespace") if isinstance(d.get("namespace"), int) else 0,
        "editor": classify_editor(user, d.get("bot") is True),
        "flagged": (kind != "log" and bool(REVERT.search(comment))) or (log_type in MODERATION_LOGS),
    }


def geo_eligible(c: dict) -> bool:
    if c["type"] not in ("edit", "new"):
        return False
    host, ns = c["host"], c["namespace"]
    if host.endswith(".wikipedia.org") or host.endswith(".wikivoyage.org") or host == "www.wikidata.org":
        return ns == 0
    if host == "commons.wikimedia.org":
        return ns == 6
    return False


class Bursts:
    """Same rule as the page's BurstDetector: a wiki is bursting while its
    10-second rate is 3x its slow EWMA baseline (and at least 1 change/s)."""

    WINDOW, TAU, WARMUP, START, END, MIN_RATE, FLOOR, MAX_S = 10, 180.0, 60, 3.0, 1.5, 1.0, 0.2, 300

    def __init__(self):
        self.keys: dict[str, dict] = {}
        self.started_at: float | None = None
        self.history: deque = deque(maxlen=40)

    def warm(self, t: float) -> bool:
        return self.started_at is not None and t - self.started_at >= self.WARMUP

    def add(self, key: str, t: float) -> None:
        if self.started_at is None:
            self.started_at = t
        sec = int(t)
        s = self.keys.get(key)
        if s is None:
            warm = self.warm(t)
            s = {"counts": [0] * self.WINDOW, "sec": sec, "baseline": self.FLOOR if warm else 0.0,
                 "observed": self.WARMUP if warm else 0, "last": t, "burst": None}
            self.keys[key] = s
        self._advance(s, sec, t)
        s["last"] = max(s["last"], t)
        if sec > s["sec"] - self.WINDOW:
            s["counts"][sec % self.WINDOW] += 1

    def _fold(self, s: dict, v: float, t: float) -> None:
        if s["burst"]:
            return
        s["observed"] += 1
        if self.warm(t):
            s["baseline"] += (v - s["baseline"]) * (1 - math.exp(-1 / self.TAU))
        else:
            s["baseline"] += (v - s["baseline"]) / s["observed"]

    def _advance(self, s: dict, sec: int, t: float) -> None:
        steps = sec - s["sec"]
        if steps <= 0:
            return
        walk = min(steps, self.WINDOW)
        for i in range(walk):
            done = s["sec"] + i
            self._fold(s, s["counts"][done % self.WINDOW], t)
            s["counts"][(done + 1) % self.WINDOW] = 0
        zeros = steps - walk
        if zeros > 0 and not s["burst"]:
            if self.warm(t):
                s["baseline"] *= math.exp(-zeros / self.TAU)
            else:
                s["baseline"] = s["baseline"] * s["observed"] / (s["observed"] + zeros)
            s["observed"] += zeros
        if walk == self.WINDOW:
            s["counts"] = [0] * self.WINDOW
        s["sec"] = sec

    def rate(self, key: str, t: float) -> float:
        s = self.keys.get(key)
        if not s:
            return 0.0
        self._advance(s, int(t), t)
        return sum(s["counts"]) / self.WINDOW

    def tick(self, t: float) -> None:
        for key in list(self.keys):
            s = self.keys[key]
            r = self.rate(key, t)
            b = s["burst"]
            if b:
                b["peakRate"] = round(max(b["peakRate"], r), 2)
                over = t - b["since"] / 1000 >= self.MAX_S
                if r < self.END * b["baseline"] or r < self.MIN_RATE * 0.5 or over:
                    b["endedAt"] = int(t * 1000)
                    if over:
                        s["baseline"] = r
                    s["burst"] = None
            elif self.warm(t) and r >= self.MIN_RATE and r >= self.START * max(self.FLOOR, s["baseline"]):
                s["burst"] = {"key": key, "since": int(t * 1000), "baseline": round(max(self.FLOOR, s["baseline"]), 3),
                              "peakRate": round(r, 2), "endedAt": None}
                self.history.appendleft(s["burst"])
            if not s["burst"] and t - s["last"] > self.TAU * 4:
                del self.keys[key]

    def baselines(self) -> dict[str, float]:
        return {k: round(s["baseline"], 4) for k, s in self.keys.items() if s["baseline"] > 0.01}


class History:
    """Exact rolling aggregates, filed by event time and committed behind a settle window."""

    def __init__(self, now_ms: int):
        self.boundary = (now_ms // 1000) * 1000      # every event with dt < boundary is committed
        self.coverage: list[list[int]] = [[self.boundary, self.boundary]]
        self.seconds: dict[int, list[int]] = {}
        self.minutes: dict[int, list[int]] = {}
        self.hosts: dict[str, dict[int, list[int]]] = {}
        self.cells: dict[int, dict[int, list[int]]] = {}   # hour -> cell -> [count, flagged]
        self.recent_pins: deque = deque()
        self.bursts = Bursts()
        self.pending: list = []
        self.pending_pins: list = []
        self.pending_ids: set[str] = set()
        self.committed_ids: OrderedDict[str, int] = OrderedDict()
        self.newest_dt = self.boundary
        self.duplicates = 0

    # -------------------------------------------------------------- intake
    def offer(self, c: dict) -> bool:
        """Queues a change unless it is already counted. Returns True if it is new."""
        if c["dt"] < self.boundary or c["id"] in self.pending_ids or c["id"] in self.committed_ids:
            self.duplicates += 1
            return False
        heapq.heappush(self.pending, (c["dt"], c["id"], c))
        self.pending_ids.add(c["id"])
        self.newest_dt = max(self.newest_dt, c["dt"])
        return True

    def commit(self, hold_ms: int | None = None) -> None:
        """Files queued changes older than the settle window, one second at a time, and advances the boundary.

        `hold_ms` keeps the boundary before a change that is still waiting for its coordinates,
        so a published second is final for pins too."""
        target = ((self.newest_dt - SETTLE_S * 1000) // 1000) * 1000
        if hold_ms is not None:
            target = min(target, (hold_ms // 1000) * 1000)
        if target <= self.boundary:
            return
        while self.boundary < target:
            nxt = self.boundary + 1000
            while self.pending and self.pending[0][0] < nxt:
                _, eid, c = heapq.heappop(self.pending)
                self.pending_ids.discard(eid)
                self.committed_ids[eid] = c["dt"]
                self._file(c)
            while self.pending_pins and self.pending_pins[0][0] < nxt:
                self._file_pin(heapq.heappop(self.pending_pins))
            self.boundary = nxt
            self.bursts.tick(nxt / 1000)
        while self.committed_ids and next(iter(self.committed_ids.values())) < target - SETTLE_S * 2000:
            self.committed_ids.popitem(last=False)
        self.coverage[-1][1] = target
        self._prune()

    def gap(self, resume_ms: int) -> None:
        """Marks that nothing between the boundary and `resume_ms` could be recovered."""
        resume = ((resume_ms // 1000) + 1) * 1000
        if resume <= self.boundary:
            return
        self.boundary = resume
        self.coverage.append([resume, resume])

    def _file(self, c: dict) -> None:
        automatic = c["type"] == "categorize"
        row = (0 if automatic else 1, int(c["flagged"]) if not automatic else 0,
               int(c["editor"] == "bots" and not automatic), int(c["editor"] == "anonymous" and not automatic), int(automatic))
        for table, key in ((self.seconds, c["dt"] // 1000), (self.minutes, c["dt"] // 60_000)):
            acc = table.setdefault(key, [0, 0, 0, 0, 0])
            for i, v in enumerate(row):
                acc[i] += v
        if automatic:
            return
        hb = self.hosts.setdefault(c["host"], {}).setdefault(c["dt"] // 600_000, [0, 0])
        hb[0] += 1
        hb[1] += int(c["flagged"])
        self.bursts.add(c["host"], c["dt"] / 1000)

    def pin(self, dt: int, lat: float, lon: float, editor: str, flagged: bool, host: str, title: str) -> None:
        p = (dt, round(lat, 3), round(lon, 3), EDITORS.index(editor), int(flagged), host, title[:120])
        if dt < self.boundary:
            self._file_pin(p)
        else:
            heapq.heappush(self.pending_pins, p)

    def _file_pin(self, p: tuple) -> None:
        dt, lat, lon, _, flagged = p[:5]
        cell = (int(math.floor(lat)) + 90) * 360 + (int(math.floor(lon)) + 180)
        acc = self.cells.setdefault(dt // 3_600_000, {}).setdefault(cell, [0, 0])
        acc[0] += 1
        acc[1] += flagged
        self.recent_pins.append(p)

    def _prune(self) -> None:
        b = self.boundary
        for table, unit, keep in ((self.seconds, 1000, SECONDS_KEPT), (self.minutes, 60_000, MINUTES_KEPT)):
            oldest = b // unit - keep
            for k in [k for k in table if k < oldest]:
                del table[k]
        oldest_bucket = b // 600_000 - 144
        for host in list(self.hosts):
            buckets = self.hosts[host]
            for k in [k for k in buckets if k < oldest_bucket]:
                del buckets[k]
            if not buckets:
                del self.hosts[host]
        for h in [h for h in self.cells if h < b // 3_600_000 - PIN_HOURS]:
            del self.cells[h]
        while self.recent_pins and self.recent_pins[0][0] < b - RECENT_PINS_S * 1000:
            self.recent_pins.popleft()
        day_ago = b - MINUTES_KEPT * 60_000
        self.coverage = [iv for iv in self.coverage if iv[1] > day_ago]
        if self.coverage and self.coverage[0][0] < day_ago:
            self.coverage[0][0] = day_ago

    # ------------------------------------------------------------- output
    def snapshot(self, now_ms: int, lookups: dict) -> dict:
        b = self.boundary
        sec_end, min_end = b // 1000, b // 60_000
        def columns(table, start, end):
            cols = [[] for _ in SERIES]
            for k in range(start, end):
                row = table.get(k, (0, 0, 0, 0, 0))
                for i in range(len(SERIES)):
                    cols[i].append(row[i])
            return dict(zip(SERIES, cols))
        hour_ago = (b - 3_600_000) // 600_000
        hosts = []
        for host, buckets in self.hosts.items():
            hosts.append({
                "host": host,
                "total": sum(v[0] for v in buckets.values()),
                "flagged": sum(v[1] for v in buckets.values()),
                "lastHour": sum(v[0] for k, v in buckets.items() if k >= hour_ago),
            })
        hosts.sort(key=lambda h: -h["total"])
        merged: dict[int, list[int]] = {}
        for hour in self.cells.values():
            for cell, (n, f) in hour.items():
                acc = merged.setdefault(cell, [0, 0])
                acc[0] += n
                acc[1] += f
        cells = [[cell // 360 - 90 + 0.5, cell % 360 - 180 + 0.5, n, f] for cell, (n, f) in merged.items()]
        return {
            "v": 2,
            "generatedAt": now_ms,
            "boundary": b,
            "coverage": self.coverage,
            "seconds": {"start": (sec_end - SECONDS_KEPT) * 1000, **columns(self.seconds, sec_end - SECONDS_KEPT, sec_end)},
            "minutes": {"start": (min_end - MINUTES_KEPT) * 60_000, **columns(self.minutes, min_end - MINUTES_KEPT, min_end)},
            "hosts": hosts[:80],
            "baselines": self.bursts.baselines(),
            "bursts": list(self.bursts.history)[:30],
            "cells": cells,
            "recentPins": [list(p) for p in self.recent_pins],
            "lookups": lookups,
        }

    def state(self) -> dict:
        return {
            "boundary": self.boundary,
            "coverage": self.coverage,
            "seconds": {str(k): v for k, v in self.seconds.items()},
            "minutes": {str(k): v for k, v in self.minutes.items()},
            "hosts": {h: {str(k): v for k, v in bs.items()} for h, bs in self.hosts.items()},
            "cells": {str(h): {str(c): v for c, v in cs.items()} for h, cs in self.cells.items()},
            "recentPins": list(self.recent_pins),
            "bursts": list(self.bursts.history),
            "committedIds": list(self.committed_ids.items()),
        }

    def restore(self, s: dict) -> None:
        self.boundary = int(s["boundary"])
        self.newest_dt = self.boundary
        self.coverage = [list(map(int, iv)) for iv in s.get("coverage", [])] or [[self.boundary, self.boundary]]
        self.seconds = {int(k): list(v) for k, v in s.get("seconds", {}).items()}
        self.minutes = {int(k): list(v) for k, v in s.get("minutes", {}).items()}
        self.hosts = {h: {int(k): list(v) for k, v in bs.items()} for h, bs in s.get("hosts", {}).items()}
        self.cells = {int(h): {int(c): list(v) for c, v in cs.items()} for h, cs in s.get("cells", {}).items()}
        self.recent_pins.extend(tuple(p) for p in s.get("recentPins", []))
        self.committed_ids.update((k, int(v)) for k, v in s.get("committedIds", []))
        for b in reversed(s.get("bursts", [])):
            if b.get("endedAt") is None:
                b["endedAt"] = self.boundary
            self.bursts.history.appendleft(b)


class Geo:
    """Coordinates for every eligible change, looked up through each wiki's API, batched and cached."""

    def __init__(self, on_pin):
        self.pending: dict[str, dict[str, list]] = {}
        self.queued = 0
        self.cache: OrderedDict[tuple[str, str], tuple | None] = OrderedDict()
        self.next_at = 0.0
        self.host_until: dict[str, float] = {}
        self.batch = 50
        self.on_pin = on_pin
        self.stats = {"asked": 0, "located": 0, "skipped": 0, "failedRequests": 0}

    def want(self, c: dict) -> None:
        key = (c["host"], c["title"])
        if key in self.cache:
            self.cache.move_to_end(key)
            coords = self.cache[key]
            if coords:
                self.on_pin(c["dt"], *coords, c["editor"], c["flagged"], c["host"], c["title"])
            return
        if self.queued >= LOOKUP_QUEUE_LIMIT:
            self.stats["skipped"] += 1
            return
        self.pending.setdefault(c["host"], {}).setdefault(c["title"], []).append((c["dt"], c["editor"], c["flagged"], time.monotonic()))
        self.queued += 1

    def oldest(self) -> int | None:
        """Event time of the oldest change still waiting for coordinates."""
        return min((w[0] for q in self.pending.values() for ws in q.values() for w in ws), default=None)

    def expire(self, max_wait_s: float = 600) -> None:
        """Gives up on titles that could not be looked up for ten minutes; they are counted, not hidden."""
        cutoff = time.monotonic() - max_wait_s
        for host in list(self.pending):
            q = self.pending[host]
            for title in [t for t, ws in q.items() if ws[0][3] < cutoff]:
                n = len(q.pop(title))
                self.queued -= n
                self.stats["skipped"] += n
            if not q:
                del self.pending[host]

    def pump(self) -> None:
        now = time.monotonic()
        ready = [h for h in self.pending if self.host_until.get(h, 0) <= now]
        if now < self.next_at or not ready:
            return
        self.next_at = now + LOOKUP_INTERVAL_S
        # Oldest first, so no wiki's titles wait behind a busier one's (they hold the boundary back).
        host = min(ready, key=lambda h: next(iter(self.pending[h].values()))[0][3])
        q = self.pending[host]
        titles: list[str] = []
        size = 0
        for t in q:
            n = len(urllib.parse.quote(t, safe="")) + 3
            if titles and (len(titles) >= self.batch or size + n > 4000):
                break
            titles.append(t)
            size += n
        url = f"https://{host}/w/api.php?" + urllib.parse.urlencode({
            "action": "query", "prop": "coordinates", "coprimary": "primary", "format": "json",
            "formatversion": "2", "maxlag": "5", "titles": "|".join(titles),
        })
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=20) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            self.stats["failedRequests"] += 1
            if e.code == 414 and len(titles) > 1:
                self.batch = max(1, len(titles) // 2)  # too long even after encoding: halve and retry now
                self.next_at = now
                return
            if e.code == 429:
                # That wiki asked us to slow down: leave it alone as long as it says, keep its titles, carry on with the rest.
                wait = float(e.headers.get("Retry-After") or 60) if e.headers else 60.0
                self.host_until[host] = now + max(5.0, wait)
                log(f"{host} asked for a {wait:.0f}s pause (HTTP 429)")
                return
            log(f"coordinates lookup failed for {host}: {e}")
            self.next_at = now + 15
            return
        except Exception as e:  # noqa: BLE001 - leave the titles queued and try again later
            self.stats["failedRequests"] += 1
            log(f"coordinates lookup failed for {host}: {e}")
            self.next_at = now + 15
            return
        if "error" in body:
            self.stats["failedRequests"] += 1
            self.next_at = now + 15
            return
        query = body.get("query", {})
        back = {n.get("to"): n.get("from") for n in query.get("normalized", [])}
        found: dict[str, tuple | None] = {t: None for t in titles}
        for page in query.get("pages", []):
            title = back.get(page.get("title"), page.get("title"))
            c = next((c for c in page.get("coordinates", []) if c.get("globe", "earth") == "earth"), None)
            lat, lon = (c or {}).get("lat"), (c or {}).get("lon")
            if title in found and isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and abs(lat) <= 90 and abs(lon) <= 180:
                found[title] = (lat, lon)
        for title, coords in found.items():
            waiting = q.pop(title, [])
            self.queued -= len(waiting)
            self.stats["asked"] += len(waiting)
            self.cache[(host, title)] = coords
            if len(self.cache) > COORD_CACHE:
                self.cache.popitem(last=False)
            if coords:
                for dt, editor, flagged, _ in waiting:
                    self.stats["located"] += 1
                    self.on_pin(dt, coords[0], coords[1], editor, flagged, host, title)
        if not q:
            del self.pending[host]
        self.batch = 50


LOG_FILE: Path | None = None
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    if LOG_FILE is None:
        print(line, flush=True)
        return
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > 512_000:
        LOG_FILE.replace(LOG_FILE.with_suffix(".old.log"))
    with LOG_FILE.open("a", encoding="utf-8") as f:
        print(line, file=f)


def git(repo: Path, *args: str) -> str:
    env = dict(os.environ)
    if os.environ.get("SYNAPSE_GIT_SSH"):
        env["GIT_SSH_COMMAND"] = os.environ["SYNAPSE_GIT_SSH"]
    # creationflags keeps git from flashing a console window when run under pythonw.
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env, creationflags=NO_WINDOW).stdout.strip()


def publish(data_dir: Path, snap: dict, remote: str, pushes: int) -> None:
    """Writes snapshot.json and force-pushes it as the only commit on `data`."""
    repo = data_dir / "publish"
    if not (repo / ".git").exists():
        repo.mkdir(parents=True, exist_ok=True)
        git(repo, "init", "-q")
        git(repo, "config", "user.name", "synapse-collector")
        git(repo, "config", "user.email", "synapse-collector@users.noreply.github.com")
    (repo / "snapshot.json").write_text(json.dumps(snap, separators=(",", ":")), encoding="utf-8")
    (repo / "README.md").write_text(
        "Rolling history for Synapse's live Wikipedia mode, written every minute by collector/collect.py.\n"
        "This branch is replaced on every update; it has exactly one commit.\n", encoding="utf-8")
    git(repo, "add", "-A")
    tree = git(repo, "write-tree")
    commit = git(repo, "commit-tree", tree, "-m", f"snapshot {iso(snap['boundary'])}")
    git(repo, "push", "-q", "-f", remote, f"{commit}:refs/heads/data")
    if pushes % 30 == 0:
        git(repo, "prune")


def be_gentle() -> None:
    """Lowest CPU priority, so the collector never competes with anything you are doing."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        # HANDLE(-1) is the current-process pseudo-handle; IDLE_PRIORITY_CLASS = 0x40.
        if not kernel32.SetPriorityClass(wintypes.HANDLE(-1), 0x40):
            log(f"could not lower priority (error {ctypes.get_last_error()})")
    else:
        os.nice(19)


def single_instance(lock_path: Path):
    """Holds an exclusive lock for the life of the process; returns None if another copy has it."""
    f = lock_path.open("a+")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def stream(since_ms: int):
    """Yields (id, data) for each event, replaying from `since_ms`."""
    url = f"{STREAM_URL}?{urllib.parse.urlencode({'since': iso(since_ms)})}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/event-stream"}), timeout=90) as r:
        data: list[str] = []
        for raw in r:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif line == "" and data:
                yield "\n".join(data)
                data = []


def main() -> int:
    global LOG_FILE
    data_dir = Path(os.environ.get("SYNAPSE_DATA_DIR", Path(__file__).resolve().parent / ".data"))
    remote = os.environ.get("SYNAPSE_REMOTE", "https://github.com/clark719664/synapse.git")
    data_dir.mkdir(parents=True, exist_ok=True)
    lock = single_instance(data_dir / "collector.lock")
    if lock is None:
        print("another collector is already running", file=sys.stderr)
        return 0
    if sys.stdout is None or os.environ.get("SYNAPSE_LOG_FILE") == "1":
        LOG_FILE = data_dir / "collector.log"
    be_gentle()

    state_file = data_dir / "state.json"
    now = int(time.time() * 1000)
    history = History(now)
    if state_file.exists():
        try:
            history.restore(json.loads(state_file.read_text(encoding="utf-8")))
            log(f"resuming from {iso(history.boundary)}")
        except (ValueError, OSError, KeyError) as e:
            log(f"ignoring unreadable state: {e}")
    if history.boundary < now - MINUTES_KEPT * 60_000:
        history.gap(now - MINUTES_KEPT * 60_000)
    geo = Geo(history.pin)
    log(f"collector starting, publishing to {remote}")

    last_publish = time.monotonic()
    last_tick = 0.0
    pushes = 0
    backoff = 1.0
    while True:
        since = history.boundary - SETTLE_S * 1000
        first = True
        try:
            for data in stream(since):
                c = parse_change(data)
                if c is None:
                    continue
                if first:
                    first = False
                    # Wikimedia keeps a limited replay window; anything it can no longer give us is a gap, not zero.
                    if c["dt"] > history.boundary + 120_000:
                        log(f"replay started at {iso(c['dt'])}, after the boundary {iso(history.boundary)}; recording a gap")
                        history.gap(c["dt"] - 1)
                    backoff = 1.0
                if history.offer(c) and geo_eligible(c):
                    geo.want(c)
                now_m = time.monotonic()
                if now_m - last_tick >= 1:
                    last_tick = now_m
                    geo.pump()
                    geo.expire()
                    history.commit(geo.oldest())
                if now_m - last_publish >= PUBLISH_INTERVAL_S:
                    last_publish = now_m
                    snap = history.snapshot(int(time.time() * 1000), {**geo.stats, "queued": geo.queued})
                    state_file.write_text(json.dumps(history.state(), separators=(",", ":")), encoding="utf-8")
                    try:
                        pushes += 1
                        publish(data_dir, snap, remote, pushes)
                        log(f"published up to {iso(snap['boundary'])}: {sum(snap['minutes']['total'])} changes in 24h, "
                            f"{len(snap['cells'])} places, {len(snap['bursts'])} bursts, lookups {geo.stats}")
                    except subprocess.CalledProcessError as e:
                        log(f"publish failed: {e.stderr.strip()[:300]}")
            log("stream ended; resuming from the boundary")
        except Exception as e:  # noqa: BLE001 - the stream drops now and then; replay closes the hole
            log(f"stream error: {e}; resuming from the boundary in {backoff:.0f}s")
        time.sleep(backoff)
        backoff = min(60.0, backoff * 2)


if __name__ == "__main__":
    sys.exit(main())
