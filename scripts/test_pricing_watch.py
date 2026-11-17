"""Tests for scripts/pricing-watch.py, offline, against saved page excerpts.

    python3 -m unittest discover -s scripts -p 'test_*.py'   (make test-scripts)
"""

import importlib.util
import io
import json
import pathlib
import sys
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


def row(mid, inp, cw5, cw1, cr, out, until=None):
    r = {"id": mid, "display": mid, "input": inp, "cache_write_5m": cw5,
         "cache_write_1h": cw1, "cache_read": cr, "output": out}
    if until:
        r["until"] = until
    return r


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

    def test_new_model_caught_by_prefix(self):
        f = self.findings()
        col = {i["model"]: i["row"] for i in f["collision"]}
        self.assertEqual(col["claude-fable-5-2"], "claude-fable-5")
        self.assertNotIn("claude-mythos-5-2", col)  # no claude-mythos-5 row here
        self.assertIn("claude-mythos-5-2", [i["model"] for i in f["missing"]])
        self.assertEqual(pw.exit_code(f), 1)

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


class LookupTest(unittest.TestCase):
    rows = pw.current_rows({"models": [row("claude-opus-5", 5, 0, 0, 0, 25),
                                       row("claude-opus-5-5", 4, 0, 0, 0, 20)]})

    def test_longest_prefix(self):
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5-5-20261001")["id"], "claude-opus-5-5")
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5-1")["id"], "claude-opus-5")

    def test_provider_prefixes(self):
        self.assertEqual(pw.lookup(self.rows, "us.anthropic.claude-opus-5-5-v1:0")["id"], "claude-opus-5-5")
        self.assertEqual(pw.lookup(self.rows, "claude-opus-5@20260101")["id"], "claude-opus-5")
        self.assertEqual(pw.lookup(self.rows, "anthropic/claude-opus-5-5")["id"], "claude-opus-5-5")
        self.assertIsNone(pw.lookup(self.rows, "gpt-6-sol"))


class MainTest(unittest.TestCase):
    def test_json_from_saved_pages(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = pw.main(["--json", "--only", "anthropic",
                            "--source", f"anthropic={FIXTURES / 'anthropic.md.txt'}"])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(out["exit"], 1)
        self.assertEqual(out["sources"][0]["models"], 8)
        self.assertIn("claude-fable-5-2", [i["model"] for i in out["findings"]["collision"]])


if __name__ == "__main__":
    unittest.main()
