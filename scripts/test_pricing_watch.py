"""Tests for scripts/pricing-watch.py, offline, against saved page excerpts.

    python3 -m unittest discover -s scripts -p 'test_*.py'   (make test-scripts)
"""

import importlib.util
import io
import json
import pathlib
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "testdata" / "pricing-watch"

_spec = importlib.util.spec_from_file_location("pricing_watch", HERE / "pricing-watch.py")
pw = importlib.util.module_from_spec(_spec)
sys.modules["pricing_watch"] = pw
_spec.loader.exec_module(pw)


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def row(mid, inp, cw5, cw1, cr, out, until=None, tiers=None):
    r = {"id": mid, "display": mid, "input": inp, "cache_write_5m": cw5,
         "cache_write_1h": cw1, "cache_read": cr, "output": out}
    if until:
        r["until"] = until
    if tiers:
        r["tiers"] = tiers
    return r


def tier(above, inp, cw5, cw1, cr, out):
    return {"above_prompt_tokens": above, "input": inp, "cache_write_5m": cw5,
            "cache_write_1h": cw1, "cache_read": cr, "output": out}


def by_id(models):
    return {m.id: m for m in models}


def source(name):
    return next(s for s in pw.SOURCES if s.name == name)


class AnthropicTest(unittest.TestCase):
    def test_markdown_table(self):
        m = by_id(pw.parse_anthropic(fixture("anthropic.md.txt")))
        self.assertEqual(m["claude-fable-5-2"].prices, {
            "input": 8.0, "cache_write_5m": 10.0, "cache_write_1h": 16.0,
            "cache_read": 0.2, "output": 40.0})
        self.assertEqual(m["claude-fable-5-2"].display, "Claude Fable 5.2")
        # A linked note with nested parentheses does not leak into the id.
        self.assertIn("claude-opus-4-1", m)
        self.assertIn("claude-mythos-5-2", m)

    def test_haiku_tiers_keep_the_first_row(self):
        haiku = by_id(pw.parse_anthropic(fixture("anthropic.md.txt")))["claude-haiku-5-5"]
        self.assertEqual(haiku.prices["input"], 0.1)
        self.assertEqual(len(haiku.tiers), 1)
        self.assertIn("over 100,000", haiku.tiers[0])

    def test_html_fallback(self):
        m = by_id(pw.parse_anthropic(fixture("anthropic.html")))
        self.assertEqual(sorted(m), ["claude-fable-5-2", "claude-opus-5-5"])
        self.assertEqual(m["claude-fable-5-2"].prices["cache_read"], 0.2)
        self.assertEqual(m["claude-opus-5-5"].prices["output"], 20.0)

    def test_display_to_id(self):
        self.assertEqual(pw.anthropic_id("Claude Opus 5.5"), "claude-opus-5-5")
        self.assertEqual(pw.anthropic_id("Claude Sonnet 4 (retired (x) y)"), "claude-sonnet-4")

    def test_unrelated_page_is_unreadable(self):
        with self.assertRaises(pw.Unreadable):
            pw.parse_anthropic("# Pricing\n\n| Concept | Details |\n| --- | --- |\n| a | b |\n")


class OpenAITest(unittest.TestCase):
    def setUp(self):
        self.m = by_id(pw.parse_openai(fixture("openai.md.txt")))

    def test_standard_rows_only(self):
        astra = self.m["gpt-6-astra"]
        self.assertEqual(astra.prices["input"], 10.0)  # not the batch $5
        self.assertEqual(astra.prices["cache_write_5m"], 12.5)
        self.assertEqual(astra.prices["cache_write_1h"], 12.5)  # 30m rate, as the table carries it
        self.assertNotIn("gpt-6-luna", self.m)  # only in the batch table here
        self.assertEqual(self.m["gpt-5.3-codex"].prices["input"], 1.75)  # not the fast $3.50

    def test_context_suffix_and_dashes(self):
        g = self.m["gpt-5.4"]
        self.assertIsNone(g.prices["cache_write_5m"])
        self.assertEqual(g.prices["cache_read"], 0.25)
        self.assertEqual(self.m["gpt-5.4-mini"].prices["output"], 4.5)

    def test_long_context_tier_prices(self):
        sol = self.m["gpt-6.1-sol"]
        self.assertEqual(sol.tier_prices, {"input": 4.0, "output": 15.0, "cache_read": 0.2,
                                           "cache_write_5m": 5.0, "cache_write_1h": 5.0})
        self.assertEqual(self.m["gpt-5.4"].tier_prices["output"], 22.5)
        self.assertIsNone(self.m["gpt-5.4"].tier_prices["cache_write_5m"])

    def test_long_context_compared_with_the_row(self):
        table = {"version": "t", "models": [
            row("gpt-6.1-sol", 2, 2.5, 2.5, 0.1, 10, tiers=[tier(272000, 4, 5, 5, 0.2, 15)])]}
        models = [m for m in pw.parse_openai(fixture("openai.md.txt")) if m.id == "gpt-6.1-sol"]
        f = pw.compare(table, [(source("openai"), models, "fixture", None)])
        self.assertEqual(pw.exit_code(f), 0)
        table["models"][0]["tiers"][0]["cache_read"] = 0.4
        f = pw.compare(table, [(source("openai"), models, "fixture", None)])
        self.assertEqual(f["changed"][0]["diff"], {"cache_read above 272,000 tokens": {"table": 0.4, "page": 0.2}})

    def test_short_and_long_context_rows(self):
        cyber = self.m["gpt-6-cyber"]
        self.assertEqual(cyber.prices["input"], 20.0)
        self.assertTrue(any("long context" in t for t in cyber.tiers))


class GeminiTest(unittest.TestCase):
    def setUp(self):
        self.m = by_id(pw.parse_gemini(fixture("gemini.md.txt")))

    def test_today_price_and_announced_change(self):
        carbon = self.m["gemini-4-carbon"]
        self.assertEqual(carbon.prices["input"], 2.0)
        self.assertEqual(carbon.prices["output"], 10.0)
        self.assertEqual(carbon.prices["cache_read"], 0.1)
        self.assertIsNone(carbon.prices["cache_write_5m"])
        self.assertTrue(any("December 1, 2026" in a for a in carbon.announced))

    def test_prompt_size_tier(self):
        pro = self.m["gemini-3.1-pro-preview"]
        self.assertEqual(pro.prices["input"], 2.0)
        self.assertTrue(any("> 200k" in t for t in pro.tiers))
        self.assertFalse(any("storage" in t for t in pro.tiers))
        self.assertEqual(pro.tier_prices, {"input": 4.0, "output": 18.0, "cache_read": 0.4})

    def test_entered_change_is_flagged(self):
        table = {"version": "t", "models": [
            row("gemini-4-carbon", 2, 0, 0, 0.1, 10, until="2026-11-30"),
            row("gemini-4-carbon", 4, 0, 0, 0.2, 20)]}
        f = pw.compare(table, [(source("google"), [self.m["gemini-4-carbon"]], "fixture", None)], "2026-11-17")
        self.assertEqual(pw.exit_code(f), 0)
        self.assertTrue(f["announced"][0]["entered"])


TABLE = {
    "version": "test.1",
    "models": [
        row("claude-fable-5-1", 10, 12.5, 20, 0.25, 50),
        row("claude-fable-5", 10, 12.5, 20, 1, 50),
        row("claude-opus-5-5", 4, 5, 8, 0.2, 20),
        row("claude-haiku-5-5", 0.1, 0.125, 0.2, 0.01, 0.5),
        row("claude-haiku-4-5", 1, 1.25, 2, 0.5, 5, until="2026-01-01"),
        row("claude-haiku-4-5", 1, 1.25, 2, 0.1, 5),
        row("claude-opus-4-1", 15, 18.75, 30, 1.5, 75),
        row("claude-3-5-haiku", 0.8, 1, 1.6, 0.08, 4),
        row("deepseek-flash", 0.15, 0.15, 0.15, 0.003, 0.6),
    ],
}


def anthropic_result(models):
    return [(source("anthropic"), models, "fixture", None)]


class CompareTest(unittest.TestCase):
    def findings(self):
        models = pw.parse_anthropic(fixture("anthropic.md.txt"))
        return pw.compare(TABLE, anthropic_result(models))

    def test_new_model_is_missing_not_priced_as_another(self):
        # claude-fable-5-2 is not claude-fable-5 plus a suffix that names the
        # same model, so internal/cost leaves it unpriced, and so does this.
        f = self.findings()
        missing = [i["model"] for i in f["missing"]]
        self.assertIn("claude-fable-5-2", missing)
        self.assertIn("claude-mythos-5-2", missing)
        self.assertEqual(f["collision"], [])
        self.assertEqual(pw.exit_code(f), 1)

    def test_tier_modelled_and_compared(self):
        models = pw.parse_anthropic(fixture("anthropic.md.txt"))
        table = json.loads(json.dumps(TABLE))
        haiku = next(r for r in table["models"] if r["id"] == "claude-haiku-5-5")
        haiku["tiers"] = [tier(100000, 0.5, 0.625, 1, 0.05, 2.5)]
        f = pw.compare(table, anthropic_result(models))
        self.assertNotIn("claude-haiku-5-5", [i["model"] for i in f["tiers"]])
        self.assertNotIn("claude-haiku-5-5", [i["model"] for i in f["changed"]])
        haiku["tiers"][0]["output"] = 2.0
        f = pw.compare(table, anthropic_result(models))
        diff = next(i for i in f["changed"] if i["model"] == "claude-haiku-5-5")["diff"]
        self.assertEqual(diff, {"output above 100,000 tokens": {"table": 2.0, "page": 2.5}})

    def test_superseded_row_is_ignored(self):
        f = self.findings()
        # Haiku 4.5's old 0.5 cache read has `until`; the current row matches.
        self.assertNotIn("claude-haiku-4-5", [i["model"] for i in f["changed"]])

    def test_price_change(self):
        table = json.loads(json.dumps(TABLE))
        table["models"][2]["output"] = 25
        f = pw.compare(table, anthropic_result(pw.parse_anthropic(fixture("anthropic.md.txt"))))
        opus = [i for i in f["changed"] if i["model"] == "claude-opus-5-5"][0]
        self.assertEqual(opus["diff"], {"output": {"table": 25, "page": 20.0}})

    def test_gone_is_information_only(self):
        f = self.findings()
        gone = [i["model"] for i in f["gone"]]
        self.assertEqual(sorted(gone), ["claude-3-5-haiku", "claude-fable-5-1"])
        self.assertEqual(pw.exit_code({**f, "missing": [], "collision": []}), 0)
        self.assertNotIn("deepseek-flash", [i["model"] for i in f["gone"]])

    def test_clean(self):
        models = [m for m in pw.parse_anthropic(fixture("anthropic.md.txt"))
                  if m.id in ("claude-fable-5", "claude-opus-5-5", "claude-haiku-4-5")]
        table = {"version": "t", "models": [r for r in TABLE["models"]
                                            if r["id"] in ("claude-fable-5", "claude-opus-5-5", "claude-haiku-4-5")]}
        f = pw.compare(table, anthropic_result(models))
        self.assertEqual(pw.exit_code(f), 0)
        self.assertIn("No drift", pw.report(f, table, anthropic_result(models), "2026-11-17"))

    def test_unreadable_source(self):
        f = pw.compare(TABLE, [(source("openai"), None, None, "HTTP Error 503")])
        self.assertEqual(pw.exit_code(f), 2)
        text = pw.report(f, TABLE, [(source("openai"), None, None, "HTTP Error 503")], "2026-11-17")
        self.assertIn("could not read OpenAI", text)

    def test_ignore_list(self):
        models = pw.parse_openai(fixture("openai.md.txt"))
        f = pw.compare({"version": "t", "models": []}, [(source("openai"), models, "fixture", None)])
        ignored = {i["model"] for i in f["ignored"]}
        self.assertTrue({"gpt-4o", "gpt-5.4-pro", "gpt-6-cyber", "gpt-6-astra-law"} <= ignored)
        self.assertIn("gpt-5.4", [i["model"] for i in f["missing"]])
        # The fine-tuning table's dated ids are not the model's own prices.
        self.assertTrue(any(re.search(p, "gpt-4.1-2025-04-14") for p in source("openai").ignore))
        # o3 and gpt-4.1 are priced now; o-series rows belong to OpenAI.
        self.assertFalse(any(re.search(p, "o3") for p in source("openai").ignore))
        self.assertTrue(source("openai").owns("o3"))


class LookupTest(unittest.TestCase):
    rows = pw.current_rows({"models": [row("claude-opus-5", 5, 0, 0, 0, 25),
                                       row("claude-opus-5-5", 4, 0, 0, 0, 20)]})

    def test_longest_match(self):
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5-5-20261001")["id"], "claude-opus-5-5")
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5[1m]")["id"], "claude-opus-5")
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5:0")["id"], "claude-opus-5")
        # Not a bare prefix: another version is another model (internal/cost matchesID).
        self.assertIsNone(pw.lookup(self.rows, "claude-opus-5-1"))
        self.assertIsNone(pw.lookup(self.rows, "claude-opus-5.1"))

    def test_guard_matches_internal_cost(self):
        # The same cases as internal/cost TestRowIDIsNotABarePrefix.
        for m, rid in (("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
                       ("claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"),
                       ("claude-sonnet-4-5-v2", "claude-sonnet-4-5"),
                       ("kimi-k3[1m]", "kimi-k3"), ("gpt-5:extended", "gpt-5")):
            self.assertTrue(pw.matches(m, rid), m)
        for m, rid in (("claude-fable-5-2", "claude-fable-5"), ("minimax-m3.1-flash", "minimax-m3"),
                       ("kimi-k3.1-pro", "kimi-k3"), ("kimi-k2.7-code-highspeed", "kimi-k2.7-code"),
                       ("gpt-5.5", "gpt-5"), ("o3-pro", "o3"), ("claude-haiku-4-5-2025", "claude-haiku-4-5")):
            self.assertFalse(pw.matches(m, rid), m)

    def test_row_in_force_today(self):
        # A change entered in advance is not today's price until its day.
        table = {"models": [row("gemini-4-carbon", 2, 0, 0, 0.1, 10, until="2026-11-30"),
                            row("gemini-4-carbon", 4, 0, 0, 0.2, 20),
                            row("old", 1, 0, 0, 0, 1, until="2026-01-01"),
                            row("old", 2, 0, 0, 0, 2)]}
        rows = {r["id"]: r for r in pw.current_rows(table, "2026-11-17")}
        self.assertEqual(rows["gemini-4-carbon"]["input"], 2)
        self.assertEqual(rows["old"]["input"], 2)
        self.assertEqual(pw.current_rows(table, "2026-11-30")[0]["input"], 2)
        self.assertEqual({r["id"]: r for r in pw.current_rows(table, "2026-12-01")}["gemini-4-carbon"]["input"], 4)
        self.assertEqual(pw.changes_entered(table, "2026-11-17"), {"gemini-4-carbon"})
        self.assertEqual(pw.changes_entered(table, "2026-12-01"), set())

    def test_provider_prefixes(self):
        self.assertEqual(pw.lookup(self.rows, "us.anthropic.claude-opus-5-5-v1:0")["id"], "claude-opus-5-5")
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5@20260101")["id"], "claude-opus-5")
        self.assertEqual(pw.lookup(self.rows, "anthropic/claude-opus-5-5")["id"], "claude-opus-5-5")
        self.assertIsNone(pw.lookup(self.rows, "gpt-6-sol"))


class MainTest(unittest.TestCase):
    def test_json_from_saved_pages(self):
        with tempfile.TemporaryDirectory() as d:
            tpath = pathlib.Path(d) / "pricing.json"
            tpath.write_text(json.dumps(TABLE), encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = pw.main(["--json", "--only", "anthropic", "--table", str(tpath),
                                "--source", f"anthropic={FIXTURES / 'anthropic.md.txt'}"])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(out["exit"], 1)
        self.assertEqual(out["sources"][0]["models"], 8)
        self.assertIn("claude-fable-5-2", [i["model"] for i in out["findings"]["missing"]])


if __name__ == "__main__":
    unittest.main()
