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

    def test_live_table_prices_neon_and_ignores_genie(self):
        # Issue #957: gemini-4-neon has a row since 2026-11-28.1, at the page's
        # price; genie-4 is a world-generation (video) model and is ignored.
        table = json.loads((pw.ROOT / "pricing" / "pricing.json").read_text(encoding="utf-8"))
        neon = self.m["gemini-4-neon"]
        self.assertEqual((neon.prices["input"], neon.prices["cache_read"], neon.prices["output"]), (3.0, 0.15, 15.0))
        models = [neon, self.m["genie-4"]]
        f = pw.compare(table, [(source("google"), models, "fixture", None)], "2026-11-28")
        self.assertEqual(f["missing"], [])
        self.assertEqual(f["changed"], [])
        self.assertEqual([i["model"] for i in f["ignored"]], ["genie-4"])
        self.assertEqual(pw.exit_code(f), 0)

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
        self.assertTrue({"gpt-4o", "gpt-5.4-pro", "gpt-6-cyber", "gpt-6-astra-law",
                         "gpt-6.2-sol-healthcare"} <= ignored)
        # A healthcare configuration is ignored; the model it configures is not.
        self.assertFalse(any(re.search(p, "gpt-6.2-sol") for p in source("openai").ignore))
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


def run(src_name, models, table, **kw):
    return pw.compare(table, [(source(src_name), models, "fixture", None)], "2026-11-17", **kw)


def info_only(f):
    return pw.exit_code(f) == 0


class TokensTest(unittest.TestCase):
    def test_exact_and_rounded(self):
        self.assertEqual(pw.tokens("1,048,576-token context window"), (1048576, True))
        self.assertEqual(pw.tokens("1M tokens"), (1000000, False))
        self.assertEqual(pw.tokens("128K"), (128000, False))
        self.assertIsNone(pw.tokens("not stated"))

    def test_rounded_figure_matches_within_five_percent(self):
        pm = pw.PageModel("m", "m", {}, context=1000000, context_exact=False)
        self.assertEqual(pw.context_finding({"id": "m", "context_window": 1048576}, pm), (None, None))
        pm.context_exact = True
        self.assertEqual(pw.context_finding({"id": "m", "context_window": 1048576}, pm)[0], "drift")
        self.assertEqual(pw.context_finding({"id": "m", "context_window": 0}, pm)[0], "info")


class ZenTest(unittest.TestCase):
    def setUp(self):
        self.m = by_id(pw.parse_zen(fixture("zen.html")))

    def test_ids_prices_and_struck_promotion(self):
        self.assertEqual(self.m["minimax-m2.7"].prices["input"], 0.3)
        self.assertEqual(self.m["minimax-m2.7"].prices["cache_read"], 0.06)
        self.assertIsNone(self.m["minimax-m2.7"].prices["cache_write_5m"])
        # "<del>$4.00</del> $2.00": today's price, not the struck one.
        self.assertEqual(self.m["gemini-4-carbon"].prices["input"], 2.0)
        self.assertEqual(self.m["gemini-3.7-flash"].prices["output"], 3.75)
        self.assertEqual(self.m["gpt-6-sol"].tier_prices["input"], 4.0)
        # Listed only in the deprecation table, by name: not a model here.
        self.assertNotIn("deepseek-v4-flash", self.m)

    def test_only_zen_priced_rows_are_compared(self):
        table = {"version": "t", "models": [
            row("minimax-m2.7", 0.3, 0.3, 0.3, 0.06, 1.5),  # output differs from Zen's $1.20
            row("claude-opus-5-5", 9, 9, 9, 9, 99),  # differs too, but Anthropic is its source
        ]}
        f = run("zen", list(self.m.values()), table)
        self.assertEqual([i["model"] for i in f["changed"]], ["minimax-m2.7"])
        self.assertEqual(pw.exit_code(f), 1)
        unlisted = {i["model"] for i in f["unlisted"]}
        self.assertIn("glm-5.3", unlisted)
        self.assertNotIn("claude-opus-5-5", unlisted)
        self.assertFalse(any(m.endswith("-free") for m in unlisted))

    def test_new_zen_model_is_information(self):
        f = run("zen", [self.m["glm-5.3"]], {"version": "t", "models": []})
        self.assertTrue(info_only(f))
        self.assertEqual(f["missing"], [])
        self.assertIn("Zen sells it", pw.report(f, {"version": "t"}, [], "2026-11-17"))

    def test_zen_priced_rows_cite_zen(self):
        table = json.loads((HERE.parent / "pricing" / "pricing.json").read_text(encoding="utf-8"))
        zen_notes = [n for n in table["notes"] if "opencode.ai/docs/zen" in n]
        for mid in pw.ZEN_PRICED:
            self.assertTrue(any(mid in n for n in zen_notes), mid)


class DeepSeekTest(unittest.TestCase):
    def setUp(self):
        self.m = by_id(pw.parse_deepseek(fixture("deepseek.md.txt")))

    def test_off_peak_prices_and_context(self):
        flash = self.m["deepseek-flash"]
        self.assertEqual((flash.prices["input"], flash.prices["cache_read"], flash.prices["output"]),
                         (0.15, 0.003, 0.6))
        self.assertIsNone(flash.prices["cache_write_5m"])
        self.assertEqual(self.m["deepseek-v4-pro"].prices["output"], 1.98)  # not the peak $3.96
        self.assertEqual((flash.context, flash.context_exact), (1000000, False))

    def test_legacy_names_are_aliases(self):
        self.assertTrue(self.m["deepseek-v4-flash-vision-exp"].alias)
        f = run("deepseek", list(self.m.values()), {"version": "t", "models": [
            row("deepseek-flash", 0.15, 0.15, 0.15, 0.003, 0.6), row("deepseek-v4-flash", 0.15, 0.15, 0.15, 0.003, 0.6),
            row("deepseek-v4-pro", 0.66, 0.66, 0.66, 0.022, 1.98)]})
        self.assertTrue(info_only(f), f)
        self.assertEqual(f["gone"], [])


class MiniMaxTest(unittest.TestCase):
    def test_standard_tab_and_tier(self):
        m = by_id(pw.parse_minimax(fixture("minimax.md.txt")))
        self.assertEqual(sorted(m), ["minimax-m3", "minimax-m3.1-flash"])
        self.assertEqual(m["minimax-m3.1-flash"].prices["cache_read"], 0.015)
        m3 = m["minimax-m3"]
        self.assertEqual(m3.prices["input"], 0.3)  # not struck $0.60, not Priority $0.45
        self.assertEqual(m3.tier_prices["output"], 2.4)
        self.assertTrue(source("minimax").owns("minimax-m3"))
        self.assertFalse(source("minimax").owns("minimax-m2.7"))  # Zen's figure


class KimiTest(unittest.TestCase):
    def test_reads_the_js_payload(self):
        m = by_id(pw.parse_kimi(fixture("kimi.html")))
        k3 = m["kimi-k3"]
        self.assertEqual(k3.prices, {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                                     "cache_write_5m": 3.0, "cache_write_1h": 6.0})
        self.assertEqual((k3.context, k3.context_exact), (1048576, True))
        self.assertEqual(m["kimi-k2.6"].prices["cache_read"], 0.16)
        self.assertIsNone(m["kimi-k2.6"].prices["cache_write_5m"])
        self.assertEqual(m["kimi-k2.7-code"].context, 262144)

    def test_empty_rendered_table_is_unreadable(self):
        with self.assertRaises(pw.Unreadable):
            pw.parse_kimi("<table><thead><tr /></thead><tbody /></table>")


class CursorTest(unittest.TestCase):
    def setUp(self):
        self.models = pw.parse_cursor(fixture("cursor.html"))
        self.m = by_id(self.models)

    def test_own_models_under_cursor(self):
        self.assertEqual(self.m["cursor-composer-2.5"].prices["cache_read"], 0.2)
        self.assertEqual(self.m["cursor-composer-2.5-fast"].prices["output"], 15.0)
        self.assertEqual(self.m["cursor-grok-4.7-500k-fast"].prices["cache_read"], 1.5)
        self.assertEqual(self.m["cursor-grok-4.5-fast"].prices["output"], 18.0)
        self.assertEqual(self.m["cursor-muse-wonder"].prices["input"], 4.0)
        self.assertIn("claude-opus-5.5", self.m)
        self.assertIn("gpt-5.6-sol", self.m)
        self.assertNotIn("grok-4.7", self.m)

    def test_the_table_has_every_cursor_priced_model(self):
        # The live table against the fixture: every cursor- row is on the page
        # at its figure and every page name maps to a row.
        table = json.loads((pw.ROOT / "pricing" / "pricing.json").read_text(encoding="utf-8"))
        f = run("cursor", self.models, table, cursor_local=pw.cursor_local_ids())
        self.assertEqual(f["unmapped"], [])
        self.assertEqual(f["gone"], [])
        self.assertEqual(f["changed"], [])
        self.assertEqual(f["missing"], [])

    def test_family_id_map_matches_go(self):
        src = (pw.ROOT / "internal" / "api" / "cursor.go").read_text(encoding="utf-8")
        block = re.search(r"cursorFamilyIDs\s*=\s*map\[string\]string\{([^}]*)\}", src)
        self.assertIsNotNone(block)
        go = dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', block.group(1)))
        self.assertEqual(go, pw.CURSOR_FAMILY_ID)

    def test_family_matches_internal_modelclass(self):
        # The same cases as internal/modelclass TestFamilyJoinsOneModelAcrossAgents.
        for given, want in {"claude-4.5-sonnet-thinking": "claude-sonnet-4-5", "claude-4-sonnet": "claude-sonnet-4",
                            "claude-opus-4-1-20250805": "claude-opus-4-1", "claude-opus-5-5[1m]": "claude-opus-5-5",
                            "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6", "gpt-5-fast": "gpt-5",
                            "composer-2.5-fast": "composer-2.5", "GPT-4.1": "gpt-4.1", "": ""}.items():
            self.assertEqual(pw.cursor_family(given), want, given)

    def test_unmapped_names_are_information(self):
        table = {"version": "t", "models": [
            row("cursor-composer-2.5", 0.5, 0, 0, 0.2, 2.5), row("cursor-composer-2.5-fast", 3, 0, 0, 0.5, 15),
            row("claude-opus-5-5", 4, 5, 8, 0.2, 20), row("gpt-5.6-sol", 4, 5, 5, 0.4, 20)]}
        for pm in self.models:  # the Cursor-priced rows at the page's figures
            if pm.id.startswith("cursor-") and not pm.id.startswith("cursor-composer"):
                p = pm.prices
                table["models"].append(row(pm.id, p["input"], 0, 0, p["cache_read"], p["output"]))
        f = run("cursor", self.models, table, cursor_local=["sonnet-4", "gpt-5.6-sol"])
        unmapped = {i["id"] for i in f["unmapped"]}
        self.assertIn("gemini-3.1-pro", unmapped)
        self.assertIn("sonnet-4", unmapped)
        self.assertNotIn("grok-4.7", unmapped)  # Cursor-priced: compared, not mapped
        self.assertNotIn("claude-opus-5.5", unmapped)
        self.assertNotIn("gpt-5.6-sol", unmapped)
        self.assertNotIn("cursor-composer-2.5", unmapped)
        self.assertTrue(info_only(f), f)

    def test_composer_price_change_is_drift(self):
        table = {"version": "t", "models": [row("cursor-composer-2.5", 0.6, 0, 0, 0.2, 2.5)]}
        f = run("cursor", self.models, table, cursor_local=[])
        self.assertEqual(f["changed"][0]["diff"], {"input": {"table": 0.6, "page": 0.5}})

    def test_picker_ids_read_from_go(self):
        self.assertIn("gpt-5", pw.cursor_local_ids())


class CodexTest(unittest.TestCase):
    def setUp(self):
        self.models = pw.parse_codex(fixture("codex-models.json"))

    def test_listed_and_hidden(self):
        m = by_id(self.models)
        self.assertFalse(m["gpt-6-astra"].hidden)
        self.assertTrue(m["codex-auto-review"].hidden)

    def test_listed_model_without_a_row_is_drift(self):
        f = run("codex", self.models, {"version": "t", "models": [row("gpt-6-sol", 2, 2.5, 2.5, 0.2, 10)]})
        missing = {i["model"] for i in f["missing"]}
        self.assertIn("gpt-6-astra", missing)
        self.assertNotIn("codex-auto-review", missing)
        self.assertIn("codex-auto-review", {i["model"] for i in f["unlisted"]})
        self.assertEqual(pw.exit_code(f), 1)
        self.assertIn("Codex offers it", pw.report(f, {"version": "t"}, [], "2026-11-17"))

    def test_the_table_has_every_listed_codex_model(self):
        # The live table against the fixture: every model Codex lists in its
        # picker has a row (gpt-6.2-astra and gpt-6.2-sol since 2026-11-17.4).
        table = json.loads((pw.ROOT / "pricing" / "pricing.json").read_text(encoding="utf-8"))
        f = run("codex", self.models, table)
        self.assertEqual(f["missing"], [])

    def test_moved_file_is_found_again(self):
        raw = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/new-home/models.json"

        def fetcher(url, headers):
            if url.startswith("https://api.github.com/"):
                return json.dumps({"tree": [{"path": "codex-rs/new-home/models.json"},
                                            {"path": "codex-rs/core/tests/models.json"}]})
            if url == raw:
                return fixture("codex-models.json")
            raise OSError("404")
        models, how, err = pw.read_source(source("codex"), fetcher=fetcher)
        self.assertEqual(how, raw)
        self.assertIsNone(err)

    def test_unreachable_is_reported(self):
        def fetcher(url, headers):
            raise OSError("offline")
        models, how, err = pw.read_source(source("codex"), fetcher=fetcher)
        self.assertIsNone(models)
        self.assertIn("offline", err)
        f = pw.compare({"version": "t", "models": []}, [(source("codex"), None, None, err)])
        self.assertEqual(pw.exit_code(f), 2)


class OverviewTest(unittest.TestCase):
    def test_anthropic_context(self):
        m = by_id(pw.parse_anthropic_models(fixture("anthropic-models.md.txt")))
        self.assertEqual((m["claude-opus-5-5"].context, m["claude-opus-5-5"].context_exact), (1000000, False))
        self.assertEqual(m["claude-opus-4-1"].context, 200000)
        table = {"version": "t", "models": [row("claude-opus-5-5", 4, 5, 8, 0.2, 20)]}
        table["models"][0]["context_window"] = 1000000
        self.assertTrue(info_only(run("anthropic-models", list(m.values()), table)))
        table["models"][0]["context_window"] = 200000
        f = run("anthropic-models", list(m.values()), table)
        self.assertEqual(f["context"][0]["model"], "claude-opus-5-5")
        self.assertEqual(pw.exit_code(f), 1)
        self.assertTrue(any(i["model"] == "claude-sonnet-5-5" for i in f["unlisted"]))

    def test_anthropic_deprecations(self):
        m = by_id(pw.parse_anthropic_deprecations(fixture("anthropic-deprecations.md.txt")))
        self.assertNotIn("claude-opus-5-5", m)  # Active
        self.assertEqual(m["claude-sonnet-4-5-20250929"].retire,
                         "deprecated September 30, 2026, retirement date November 30, 2026")
        f = run("anthropic-deprecations", list(m.values()),
                {"version": "t", "models": [row("claude-sonnet-4-5", 3, 3.75, 6, 0.3, 15)]})
        self.assertEqual([i["row"] for i in f["retiring"]], ["claude-sonnet-4-5"])
        self.assertTrue(info_only(f))

    def test_openai_models_and_model_pages(self):
        models = pw.parse_openai_models(fixture("openai-models.md.txt"))
        m = by_id(models)
        self.assertIn("gpt-6-astra", m)
        self.assertIn("gpt-rosalind-research", m)
        table = {"version": "t", "models": [row("gpt-6-astra", 10, 12.5, 12.5, 1, 50), row("gpt-5.5", 5, 0, 0, 0.5, 30)]}
        table["models"][0]["context_window"] = 1050000
        table["models"][1]["context_window"] = 0
        asked = []

        def fetcher(url, headers):
            asked.append(url)
            if url.endswith("/gpt-6-astra.md"):
                return fixture("openai-model.md.txt")
            raise OSError("HTTP Error 404")
        pw.fill_details(source("openai-models"), models, pw.current_rows(table, "2026-11-17"), fetcher)
        self.assertEqual(len(asked), 2)  # priced models only
        self.assertEqual((m["gpt-6-astra"].context, m["gpt-6-astra"].context_exact), (1050000, True))
        f = run("openai-models", models, table)
        self.assertTrue(info_only(f), f)
        self.assertEqual([i["model"] for i in f["detail"]], ["gpt-5.5"])
        table["models"][0]["context_window"] = 400000
        f = run("openai-models", models, table)
        self.assertEqual(f["context"][0]["page"], 1050000)
        # The -pro and rosalind ids are on the ignore list, not "new".
        self.assertNotIn("gpt-5.4-pro", {i["model"] for i in f["unlisted"]})

    def test_openai_deprecations(self):
        m = by_id(pw.parse_openai_deprecations(fixture("openai-deprecations.md.txt")))
        self.assertEqual(m["gpt-5"].retire, "shuts down Dec 11, 2026, replacement gpt-6.1-sol")
        f = run("openai-deprecations", list(m.values()), {"version": "t", "models": [row("gpt-5", 1.25, 0, 0, 0.125, 10)]})
        self.assertEqual({i["model"] for i in f["retiring"]}, {"gpt-5"})  # the dated id is ignored
        self.assertTrue(info_only(f))

    def test_gemini_models(self):
        m = by_id(pw.parse_gemini_models(fixture("gemini-models.md.txt")))
        self.assertEqual((m["gemini-4-carbon"].context, m["gemini-4-carbon"].context_exact), (1000000, False))
        self.assertIn("December 1, 2026", m["gemini-2.5-flash"].retire)
        self.assertIn("`gemini-2.5-flash` will automatically route", m["gemini-2.5-flash"].retire)
        self.assertEqual(pw.gemini_model_context(fixture("gemini-model.md.txt")), (1048576, True))


class OpenRouterTest(unittest.TestCase):
    def test_ids_are_hints_only(self):
        models = pw.parse_openrouter(fixture("openrouter.json"))
        m = by_id(models)
        self.assertIn("claude-opus-4-8", m)  # dotted on OpenRouter
        self.assertNotIn("claude-opus-4-8:batch", m)
        self.assertFalse(any(i.startswith("gemma") for i in m))  # :free only
        self.assertFalse(any(i.startswith("grok") for i in m))  # not a watched vendor
        table = {"version": "t", "models": [row("claude-opus-4-8", 5, 6.25, 10, 0.5, 25),
                                            row("gpt-6.1-sol", 2, 2.5, 2.5, 0.1, 10)]}
        f = run("openrouter", models, table)
        unlisted = {i["model"] for i in f["unlisted"]}
        self.assertIn("kimi-k2.5", unlisted)
        self.assertNotIn("claude-opus-4-8", unlisted)
        self.assertNotIn("gpt-6.1-sol-pro", unlisted)  # OpenAI's ignore list applies
        self.assertTrue(info_only(f))
        self.assertIn("new model seen on OpenRouter; check the vendor page",
                      pw.report(f, table, [], "2026-11-17"))


class NewParsersUnreadableTest(unittest.TestCase):
    def test_unrelated_page(self):
        page = "# Pricing\n\n| Concept | Details |\n| --- | --- |\n| a | b |\n"
        for parse in (pw.parse_zen, pw.parse_deepseek, pw.parse_minimax, pw.parse_kimi, pw.parse_cursor,
                      pw.parse_codex, pw.parse_anthropic_models, pw.parse_anthropic_deprecations,
                      pw.parse_openai_models, pw.parse_openai_deprecations, pw.parse_gemini_models,
                      pw.parse_openrouter):
            with self.assertRaises(pw.Unreadable, msg=parse.__name__):
                parse(page)

    def test_every_source_has_a_mode_compare_knows(self):
        for s in pw.SOURCES:
            self.assertIn(s.mode, ("price", "zen", "cursor", "catalog", "overview", "retire", "early"), s.name)


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
