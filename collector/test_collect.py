import json
import unittest

import collect

T0 = 1792634822000  # 2026-10-22T02:07:02Z


def event(n=0, **over):
    base = {
        "meta": {"id": f"id-{n}", "dt": collect.iso(T0 + n * 100), "domain": "en.wikipedia.org"},
        "type": "edit", "namespace": 0, "title": "Kyoto", "comment": "copyedit", "user": "Ada", "bot": False,
        "server_name": "en.wikipedia.org",
    }
    base.update(over)
    return json.dumps(base)


def change(n=0, **over):
    return collect.parse_change(event(n, **over))


class ParseTest(unittest.TestCase):
    def test_fields(self):
        c = change()
        self.assertEqual((c["id"], c["dt"], c["host"], c["editor"], c["flagged"]), ("id-0", T0, "en.wikipedia.org", "registered", False))

    def test_rejects_junk_canary_foreign_hosts_and_missing_ids(self):
        self.assertIsNone(collect.parse_change("nope"))
        self.assertIsNone(collect.parse_change(event(meta={"id": "x", "dt": collect.iso(T0), "domain": "canary"})))
        self.assertIsNone(collect.parse_change(event(server_name="evil.example")))
        self.assertIsNone(collect.parse_change(event(meta={"dt": collect.iso(T0)})))

    def test_flags_reverts_and_moderation(self):
        self.assertTrue(change(comment="Undid revision 1 by X")["flagged"])
        self.assertTrue(change(type="log", log_type="block")["flagged"])
        self.assertFalse(change(type="log", log_type="newusers")["flagged"])

    def test_editor_kinds(self):
        self.assertEqual(collect.classify_editor("203.0.113.9", False), "anonymous")
        self.assertEqual(collect.classify_editor("~2026-1", False), "anonymous")
        self.assertEqual(collect.classify_editor("Bot", True), "bots")

    def test_geo_eligibility(self):
        self.assertTrue(collect.geo_eligible(change()))
        self.assertFalse(collect.geo_eligible(change(namespace=1)))
        self.assertTrue(collect.geo_eligible(change(server_name="commons.wikimedia.org", namespace=6)))


class HistoryTest(unittest.TestCase):
    def fill(self, h, count, start=0, **over):
        for n in range(start, start + count):
            h.offer(change(n, **over))

    def test_commits_only_settled_seconds_and_counts_each_event_once(self):
        h = collect.History(T0)
        self.fill(h, 20)
        h.offer(change(5))
        h.offer(change(1200))
        h.commit()
        self.assertEqual(h.boundary, T0 + 120_000 - collect.SETTLE_S * 1000)
        snap = h.snapshot(T0 + 121_000, {})
        secs = snap["seconds"]["total"]
        self.assertEqual(len(secs), collect.SECONDS_KEPT)
        self.assertEqual(sum(secs), 20)
        first = (T0 - snap["seconds"]["start"]) // 1000
        self.assertEqual(secs[first:first + 2], [10, 10])
        self.assertEqual(h.duplicates, 1)
        self.assertEqual(snap["seconds"]["start"] + collect.SECONDS_KEPT * 1000, snap["boundary"])

    def test_ignores_events_before_the_boundary(self):
        h = collect.History(T0 + 10_000)
        self.assertFalse(h.offer(change(0)))
        self.assertTrue(h.offer(change(200)))

    def test_categorize_is_counted_separately(self):
        h = collect.History(T0)
        h.offer(change(0, type="categorize"))
        h.offer(change(1))
        h.offer(change(1000))
        h.commit()
        snap = h.snapshot(T0, {})
        self.assertEqual(sum(snap["seconds"]["total"]), 1)
        self.assertEqual(sum(snap["seconds"]["automatic"]), 1)

    def test_pins_wait_for_their_second_and_aggregate_by_place(self):
        h = collect.History(T0)
        h.pin(T0 + 500, 35.01, 135.76, "bots", False, "en.wikipedia.org", "Kyoto")
        h.pin(T0 + 600, 35.4, 135.2, "registered", True, "en.wikipedia.org", "Kyoto Station")
        self.assertEqual(h.cells, {})
        self.fill(h, 1)
        h.offer(change(1000))
        h.commit()
        snap = h.snapshot(T0, {})
        self.assertEqual(snap["cells"], [[35.5, 135.5, 2, 1]])
        self.assertEqual(len(snap["recentPins"]), 2)

    def test_boundary_holds_for_pending_lookups(self):
        h = collect.History(T0)
        self.fill(h, 1)
        h.offer(change(2000))
        h.commit(hold_ms=T0 + 30_000)
        self.assertEqual(h.boundary, T0 + 30_000)

    def test_gap_is_recorded_not_zero_filled(self):
        h = collect.History(T0)
        h.offer(change(1000))
        h.commit()
        h.gap(T0 + 3_600_000)
        self.assertEqual(len(h.coverage), 2)
        self.assertGreater(h.coverage[1][0], h.coverage[0][1])

    def test_state_round_trips(self):
        h = collect.History(T0)
        self.fill(h, 30)
        h.offer(change(1000))
        h.commit()
        again = collect.History(0)
        again.restore(json.loads(json.dumps(h.state())))
        self.assertEqual(again.snapshot(T0, {})["seconds"], h.snapshot(T0, {})["seconds"])
        self.assertFalse(again.offer(change(3)))


class BurstsTest(unittest.TestCase):
    def run_rate(self, b, key, start, seconds, per_second):
        for s in range(seconds):
            for i in range(per_second):
                b.add(key, start + s + i / per_second)
            b.tick(start + s + 0.999)

    def test_flags_a_jump_after_warm_up_and_ends_it(self):
        b = collect.Bursts()
        self.run_rate(b, "en", 1000, 90, 2)
        self.assertEqual(len(b.history), 0)
        self.run_rate(b, "en", 1090, 15, 12)
        self.assertEqual(len(b.history), 1)
        self.assertAlmostEqual(b.history[0]["baseline"], 2, delta=0.5)
        self.run_rate(b, "en", 1105, 20, 2)
        self.assertIsNotNone(b.history[0]["endedAt"])


if __name__ == "__main__":
    unittest.main()
