#!/usr/bin/env python3
"""Compare providers' published model prices with pricing/pricing.json.

    python3 scripts/pricing-watch.py            # markdown report on stdout
    python3 scripts/pricing-watch.py --json     # the same findings as JSON
    python3 scripts/pricing-watch.py --source anthropic=page.md   # read a saved page

    python3 scripts/pricing-watch.py --only kimi --only zen   # some sources

Exit status: 0 no drift, 1 drift, 2 a source could not be read (drift or not),
3 the script itself failed. The daily `pricing-watch` workflow turns 1 and 2
into one GitHub issue titled "Pricing drift". Drift is a model with no row or
priced as another, a changed price, or a context window that differs; the rest
(new ids on model lists, Cursor names with no mapping, retirements, ...) is
reported "for information" and never sets the exit status.

This script only reports. It never edits pricing/pricing.json: a price reaches
the table by hand, with its source and the date it was read (CLAUDE.md rule 6).

Each source is one entry in SOURCES: a URL list to try in order, a parser that
turns the page text into PageModel rows, and a mode saying how compare() holds
them against the table (vendor prices, a gateway, Cursor, Codex's catalog, a
model list, a deprecations page, OpenRouter). Adding a source is a parser
function and an entry. Stdlib only, so CI needs nothing installed.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import html.parser
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE = ROOT / "pricing" / "pricing.json"

FIELDS = ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output")
USER_AGENT = "caprock-pricing-watch (+https://github.com/cybrixcc/caprock)"


@dataclasses.dataclass
class PageModel:
    """One model as a pricing page lists it, prices per 1M tokens in USD.

    A field the page does not give is None and is not compared: Gemini bills
    cache storage by the hour, not a per-token write; older OpenAI models show
    "-" for cache writes.
    """

    id: str
    display: str
    prices: dict
    tiers: list = dataclasses.field(default_factory=list)  # higher-tier rows, text
    announced: list = dataclasses.field(default_factory=list)  # future price lines
    # The highest prompt-size tier's prices, by FIELDS, when the page gives
    # them as numbers; compared with the row's own highest `tiers` entry.
    tier_prices: dict = dataclasses.field(default_factory=dict)
    # The context window in tokens as the page states it, and whether the page
    # gave the exact figure (1,048,576) or a rounded one ("1M tokens").
    context: int | None = None
    context_exact: bool = False
    retire: str = ""  # a deprecation or retirement the page states, for information
    hidden: bool = False  # in a catalog but not offered in its picker (Codex)
    alias: bool = False  # named on the page as another name for a priced model
    detail_error: str = ""  # the model's own page could not be read


@dataclasses.dataclass
class Source:
    name: str
    title: str
    urls: list  # (url, extra headers), tried in order
    parse: object  # fn(text) -> list[PageModel]
    owns: object  # fn(table id) -> bool: the rows this source can vouch for
    ignore: tuple = ()  # regexes: page ids deliberately not priced
    # How the page's models are held against the table (compare()):
    #   price     the vendor's own prices: a change or a missing row is drift
    #   zen       a gateway: only the rows sourced from it are compared
    #   cursor    Cursor's own models are compared; the rest are name mapping
    #   catalog   an agent's model list: a listed model with no row is drift
    #   overview  a vendor's model list: new ids, context windows, retirements
    #   retire    a deprecations page: retirement dates of priced models
    #   early     OpenRouter: an id with no row is a hint, never a price
    mode: str = "price"
    # fn(id) -> URL of a model's own page, read for its context window when
    # the list page does not state one (overview sources only).
    detail: object = None
    detail_parse: object = None  # fn(text) -> (tokens, exact) or None
    # fn(fetch) -> [(url, headers)] tried when every URL in `urls` failed.
    discover: object = None


class Unreadable(Exception):
    """The page came back but did not hold the table the parser expects."""


# ---------------------------------------------------------------- helpers

_PRICE = re.compile(r"\$\s*([0-9]+(?:\.[0-9]+)?)")


def price(cell: str):
    """First dollar amount in a cell, or None for "-", "Free", empty."""
    m = _PRICE.search(cell or "")
    return float(m.group(1)) if m else None


def strip_markup(s: str) -> str:
    s = re.sub(r"<sup>.*?</sup>", "", s)
    s = re.sub(r"\{%.*?%\}", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)  # [text](link) -> text
    return " ".join(s.split())


def md_tables(text: str):
    """Yield every pipe table as a list of rows, each a list of cells."""
    rows: list = []
    for line in text.splitlines() + [""]:
        s = line.strip()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
                rows.append(cells)
            continue
        if rows:
            yield rows
            rows = []


class _HTMLTables(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables: list = []
        self._row = None
        self._cell = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            self.tables.append([])
        elif tag == "tr" and self._depth:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "sup" and self._cell is not None:
            self._cell.append("\0")  # footnote marks are dropped below
        elif self._cell is not None:
            self._cell.append("\n")  # a block inside a cell: name, then a blurb

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = "".join(self._cell)
            text = re.sub(r"\0[0-9*,\s]*", "", text)
            lines = (" ".join(line.split()) for line in text.split("\n"))
            self._row.append("\n".join(line for line in lines if line))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.tables[-1].append(self._row)
            self._row = None
        elif tag == "table" and self._depth:
            self._depth -= 1

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def html_tables(text: str) -> list:
    p = _HTMLTables()
    p.feed(text)
    return [t for t in p.tables if t]


def any_tables(text: str) -> list:
    """HTML tables when the page is HTML, else pipe tables."""
    if "<table" in text[:400000].lower() and not re.search(r"^\s*\|.*\|\s*$", text, re.M):
        return html_tables(text)
    return list(md_tables(text))


_TOKENS = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*([KM])?(?![\w.])", re.I)


def tokens(s: str):
    """(tokens, exact) from "1,048,576", "262,144-token", "1M tokens", "128K";
    None when there is no figure. "1M" is rounded: 1,000,000 or 1,048,576."""
    m = _TOKENS.search(s or "")
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    mult = {"k": 1_000, "m": 1_000_000}.get((m.group(2) or "").lower(), 1)
    return int(n * mult), mult == 1


# ---------------------------------------------------------------- Anthropic

_TIER = re.compile(r"\((for prompts [^)]*)\)", re.I)


def drop_parens(s: str) -> str:
    """Remove every parenthetical, nested ones included, innermost first."""
    while True:
        t = re.sub(r"\s*\([^()]*\)", "", s)
        if t == s:
            return t.strip()
        s = t


def anthropic_id(display: str) -> str:
    """"Claude Opus 5.5" -> "claude-opus-5-5"."""
    return re.sub(r"[^a-z0-9]+", "-", drop_parens(display).lower()).strip("-")


def anthropic_rows(rows: list) -> list:
    """The "Model pricing" table: Model, input, 5m write, 1h write, hits, output.

    The markdown page has one header row; the HTML page groups columns under a
    first header row and names them in a second, so the header is the first
    row that names an input column.
    """
    for n, cells in enumerate(rows[:3]):
        header = [strip_markup(c).lower() for c in cells]
        if header and header[0] in ("model", "name") and any("input" in c for c in header):
            break
    else:
        raise Unreadable("no Model / input header")
    col = {}
    for i, h in enumerate(header):
        if "input" in h:
            col["input"] = i
        elif "5m" in h:
            col["cache_write_5m"] = i
        elif "1h" in h:
            col["cache_write_1h"] = i
        elif "hit" in h:
            col["cache_read"] = i
        elif "output" in h:
            col["output"] = i
    if set(col) != set(FIELDS):
        raise Unreadable(f"columns found: {sorted(col)}")
    out: dict = {}
    for cells in rows[n + 1:]:
        display = strip_markup(cells[0].split("\n")[0])
        if not display.lower().startswith("claude"):
            continue
        prices = {f: price(strip_markup(cells[i])) for f, i in col.items() if i < len(cells)}
        mid = anthropic_id(display)
        tier = _TIER.search(display)
        clean = drop_parens(display)
        if mid in out:
            out[mid].tiers.append(f"{tier.group(1) if tier else display}: " + fmt_prices(prices))
            out[mid].tier_prices = prices
            continue
        out[mid] = PageModel(mid, clean, prices)
    if not out:
        raise Unreadable("the table had no Claude rows")
    return list(out.values())


def parse_anthropic(text: str) -> list:
    if "<table" in text[:200000].lower() and "| model" not in text.lower():
        tables = html_tables(text)
    else:
        tables = list(md_tables(text))
    for rows in tables:
        try:
            return anthropic_rows(rows)
        except Unreadable:
            continue
    raise Unreadable("no model pricing table")


# ---------------------------------------------------------------- OpenAI

_SPEEDS = ("standard", "batch", "flex", "fast", "ultrafast", "priority")


def _openai_speed(line: str, current: str) -> str:
    s = line.strip("# ").lower()
    for speed in _SPEEDS:
        if s == speed or s == f"{speed} pricing data":
            return speed
    return current


def parse_openai(text: str) -> list:
    """Standard-tier tables of developers.openai.com/api/docs/pricing.md.

    Short-context columns are the row; long context is a tier. OpenAI's
    30-minute cache write is compared with both write columns, as the table
    carries it in both (pricing.json notes on gpt-6).
    """
    speed = ""
    out: dict = {}
    rows: list = []
    lines = text.splitlines() + [""]
    for line in lines:
        s = line.strip()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
                rows.append(cells)
            continue
        if rows:
            if speed == "standard":
                _openai_table(rows, out)
            rows = []
        if s:
            speed = _openai_speed(s, speed)
    if not out:
        raise Unreadable("no standard-tier model table")
    return list(out.values())


def _openai_table(rows: list, out: dict) -> None:
    header = [strip_markup(c).lower() for c in rows[0]]
    if "model" not in header:
        return
    m = header.index("model")

    def find(*names):
        for n in names:
            if n in header:
                return header.index(n)
        return None

    col = {
        "input": find("short context input", "input"),
        "output": find("short context output", "output"),
        "cache_read": find("short context cached input", "cached input"),
        "write": find("short context 30m write", "30m write"),
    }
    long_in = find("long context input")
    long_col = {
        "input": long_in,
        "output": find("long context output"),
        "cache_read": find("long context cached input"),
        "write": find("long context 30m write"),
    }
    if col["input"] is None or col["output"] is None:
        return
    for cells in rows[1:]:
        if len(cells) <= max(i for i in col.values() if i is not None):
            continue
        raw = strip_markup(cells[m])
        name = raw.lower()
        long_ctx = "(long context)" in name
        mid = drop_parens(name)
        if not mid:
            continue

        def cell(key):
            i = col[key]
            return price(cells[i]) if i is not None else None

        write = cell("write")
        prices = {
            "input": cell("input"),
            "output": cell("output"),
            "cache_read": cell("cache_read"),
            "cache_write_5m": write,
            "cache_write_1h": write,
        }
        if prices["input"] is None and prices["output"] is None:
            continue
        if long_ctx:
            if mid in out:
                out[mid].tiers.append("long context: " + fmt_prices(prices))
                out[mid].tier_prices = prices
            continue
        if mid in out:
            continue
        pm = PageModel(mid, drop_parens(raw), prices)
        if long_in is not None and long_in < len(cells) and price(cells[long_in]) is not None:
            pm.tiers.append(f"long context: input ${fmt(price(cells[long_in]))}")

            def long_cell(key):
                i = long_col[key]
                return price(cells[i]) if i is not None and i < len(cells) else None

            lw = long_cell("write")
            pm.tier_prices = {"input": long_cell("input"), "output": long_cell("output"),
                              "cache_read": long_cell("cache_read"),
                              "cache_write_5m": lw, "cache_write_1h": lw}
        out[mid] = pm


# ---------------------------------------------------------------- Google

_GEMINI_SECTION = re.compile(r'^## (.+?)\s*\{%\s*id="([^"]+)"\s*%\}', re.M)


def parse_gemini(text: str) -> list:
    """ai.google.dev/gemini-api/docs/pricing as markdown: one `## Model` section
    per model, a Standard tab, a bullet table whose third cell is the paid tier.
    The first dollar amount in that cell is today's price; prompt-size tiers and
    dated changes after it are reported for information.
    """
    heads = list(_GEMINI_SECTION.finditer(text))
    out: dict = {}
    for n, h in enumerate(heads):
        body = text[h.end(): heads[n + 1].start() if n + 1 < len(heads) else len(text)]
        ident = re.search(r"\*\[`([a-z0-9.\-]+)`\]", body)
        mid = (ident.group(1) if ident else h.group(2)).lower()
        tab = re.search(r'\{%\s*tab title="Standard"\s*%\}(.*?)\{%\s*/tab\s*%\}', body, re.S)
        if not tab:
            continue
        cells = _gemini_cells(tab.group(1))
        prices = {f: None for f in FIELDS}
        announced, tiers, tier_prices = [], [], {}
        for feature, paid in cells:
            key = {
                "input price": "input",
                "output price": "output",
                "context caching price": "cache_read",
            }.get(re.sub(r"\s*\(.*", "", feature.lower()).strip())
            if not key:
                continue
            prices[key] = price(paid)
            lines = [line for line in paid.splitlines() if line.strip()]
            for line in lines[1:]:
                if "storage price" in line:
                    continue
                if re.search(r"starting|from \w+ \d", line, re.I):
                    announced.append(f"{key}: {line.strip().rstrip('.')}")
                elif price(line) is not None:
                    tiers.append(f"{key}: {line.strip()}")
                    if re.search(r"prompts\s*>", line):
                        tier_prices[key] = price(line)
        if prices["input"] is None and prices["output"] is None:
            continue
        if mid not in out:
            out[mid] = PageModel(mid, strip_markup(h.group(1)), prices, tiers, announced, tier_prices)
    if not out:
        raise Unreadable("no model sections with a Standard tab")
    return list(out.values())


def _gemini_cells(table: str) -> list:
    """(feature, paid-tier text) per row of a `{% table %}` bullet table."""
    out = []
    for row in re.split(r"\n\s*---\s*\n", table):
        items = re.split(r"\n\s*\* ", "\n" + row)
        items = [strip_markup_keep_lines(i) for i in items if i.strip()]
        if len(items) >= 3:
            out.append((items[0], items[2]))
    return out


def strip_markup_keep_lines(s: str) -> str:
    return "\n".join(strip_markup(line) for line in s.splitlines() if strip_markup(line))


def _blank() -> dict:
    return {f: None for f in FIELDS}


# ---------------------------------------------------------------- OpenCode Zen

# Rows whose price is OpenCode Zen's, because the vendor no longer lists the
# model (pricing.json notes on minimax-m2.7 and gemini-3.7-flash). Zen is a
# gateway: for every other model the vendor's own price is the row's source,
# so Zen is compared only on these.
ZEN_PRICED = ("minimax-m2.7", "gemini-3.7-flash")


def parse_zen(text: str) -> list:
    """opencode.ai/docs/zen: a table of model names and ids, then a price table
    by name. A promotion prints the old price struck through (<del>) before
    today's; a prompt-size tier is a second row "(> 272K tokens)"."""
    text = re.sub(r"<del>.*?</del>|~~.*?~~", "", text, flags=re.S)
    tables = any_tables(text)
    ids = {}
    for rows in tables:
        header = [strip_markup(c).lower() for c in rows[0]]
        if header[:2] == ["model", "model id"]:
            for cells in rows[1:]:
                if len(cells) >= 2:
                    ids[strip_markup(cells[0])] = strip_markup(cells[1]).lower()
    out: dict = {}
    for rows in tables:
        header = [strip_markup(c).lower() for c in rows[0]]
        if not header or header[0] != "model" or "input" not in header or "output" not in header:
            continue
        col = {"input": header.index("input"), "output": header.index("output")}
        for i, h in enumerate(header):
            if h.startswith("cached read"):
                col["cache_read"] = i
            elif h.startswith("cached write"):
                col["cache_write_5m"] = i
        for cells in rows[1:]:
            raw = strip_markup(cells[0])
            mid = ids.get(drop_parens(raw))
            if not mid:
                continue  # a deprecated model, listed by name only
            prices = _blank()
            for k, i in col.items():
                prices[k] = price(cells[i]) if i < len(cells) else None
            tier = re.search(r"\(([<>≤≥][^)]*)\)", raw)
            if mid in out:
                out[mid].tiers.append(f"{tier.group(1) if tier else raw}: " + fmt_prices(prices))
                out[mid].tier_prices = prices
                continue
            out[mid] = PageModel(mid, drop_parens(raw), prices)
    if not ids or not out:
        raise Unreadable("no model id table and price table")
    return list(out.values())


def is_free(mid: str) -> bool:
    """internal/cost isFreeModel: a gateway's no-charge variant."""
    return mid.endswith("-free") or mid.endswith(":free")


# ---------------------------------------------------------------- DeepSeek


def parse_deepseek(text: str) -> list:
    """api-docs.deepseek.com/quick_start/pricing: one table with a column per
    model and a row per property; the price rows are split into off-peak and
    peak. The row carries off-peak (pricing.json, deepseek-flash note), so
    off-peak is compared. DeepSeek lists no cache write. Legacy names quoted
    on the page (`deepseek-v4-flash`) count as listed, not as new models."""
    for rows in any_tables(text):
        header = [strip_markup(c) for c in rows[0]]
        cols = [(i, re.sub(r"\(\d+\)$", "", h).strip().lower()) for i, h in enumerate(header)
                if i and re.match(r"deepseek-", h.lower())]
        if not header or header[0].upper() != "MODEL" or not cols:
            continue
        first = cols[0][0]
        out = {mid: PageModel(mid, mid, _blank()) for _, mid in cols}
        for cells in rows[1:]:
            label = " ".join(strip_markup(c).upper() for c in cells[:first])
            if "CONTEXT LENGTH" in label:
                for i, mid in cols:
                    t = tokens(strip_markup(cells[i])) if i < len(cells) else None
                    if t:
                        out[mid].context, out[mid].context_exact = t
            if "PRICING" not in label or "OFF-PEAK" not in label:
                continue
            key = ("cache_read" if "CACHE HIT" in label else "input" if "CACHE MISS" in label
                   else "output" if "OUTPUT" in label else None)
            if key:
                for i, mid in cols:
                    out[mid].prices[key] = price(cells[i]) if i < len(cells) else None
        if not any(pm.prices["input"] is not None for pm in out.values()):
            raise Unreadable("the model table has no off-peak prices")
        for alias in sorted(set(re.findall(r"`(deepseek-[a-z0-9.\-]+)`", text)) - set(out)):
            out[alias] = PageModel(alias, alias, _blank(), alias=True)
        return list(out.values())
    raise Unreadable("no model table with deepseek- columns")


# ---------------------------------------------------------------- MiniMax


def parse_minimax(text: str) -> list:
    """platform.minimax.io/docs/guides/pricing-paygo, the "## LLM" section: a
    table per tab (Standard, Priority), inside blockquotes; a promotion strikes
    the old price through (~~$0.60~~ $0.30). Priority (1.5x) is not modelled,
    so only untabbed and Standard tables are read. A "> 512k input tokens" row
    is the model's upper prompt-size tier."""
    sec = re.search(r"^#+\s*LLM\s*$(.*?)(?=^##\s)", text, re.M | re.S)
    if not sec:
        raise Unreadable("no LLM section")
    out: dict = {}
    tab, rows = "", []
    for line in sec.group(1).splitlines() + [""]:
        s = re.sub(r"^\s*>\s?", "", line).strip()
        m = re.match(r"\[tab\]\s*(.+)", s)
        if m:
            tab = m.group(1).strip().lower()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if not all(re.fullmatch(r":?-+:?", c) for c in cells if c):
                rows.append(cells)
            continue
        if rows and not tab.startswith("priority"):
            _minimax_table(rows, out)
        rows = []
    if not out:
        raise Unreadable("no MiniMax model rows in the LLM section")
    return list(out.values())


def _minimax_table(rows: list, out: dict) -> None:
    header = [strip_markup(c.replace("*", "")).lower() for c in rows[0]]
    if not header or header[0] != "model":
        return
    col = {}
    for i, h in enumerate(header):
        if h.startswith("input"):
            col["input"] = i
        elif h.startswith("output"):
            col["output"] = i
        elif "caching read" in h:
            col["cache_read"] = i
    if "input" not in col or "output" not in col:
        return
    for cells in rows[1:]:
        name = re.match(r"\*\*([^*]+)\*\*\s*(.*)", cells[0].strip())
        if not name:
            continue
        mid = name.group(1).strip().lower()
        rest = strip_markup(name.group(2).replace("\\", ""))
        prices = _blank()
        for k, i in col.items():
            cell = re.sub(r"~~.*?~~", "", cells[i]).replace("\\$", "$") if i < len(cells) else ""
            prices[k] = price(cell)
        if rest.startswith(">") and mid in out:
            out[mid].tiers.append(f"{rest.split(' Permanent')[0]}: " + fmt_prices(prices))
            out[mid].tier_prices = prices
        elif mid not in out:
            out[mid] = PageModel(mid, name.group(1).strip(), prices)


# ---------------------------------------------------------------- Kimi

_KIMI_COL = {"input": "input", "output": "output", "cached input": "cache_read",
             "5m writes": "cache_write_5m", "1h writes": "cache_write_1h"}


def parse_kimi(text: str) -> list:
    """platform.kimi.ai/docs/pricing/chat renders its tables in the browser;
    the HTML and the .md export carry empty <table>s. The figures are in the
    page's JS payload as DocTable props: `columns:[{title:...}]` and
    `rows:[[id, "$2.00 / MTok", ...]]`. Each table follows a sentence giving
    the series' context window."""
    out: dict = {}
    for m in re.finditer(r"columns:\[(.*?)\],rows:\[\[(.*?)\]\]\}", text, re.S):
        titles = [(a or b).strip().lower() for a, b in re.findall(
            r"\{title:(?:`([^`]*)`|_jsx\(Tooltip,\{tip:`[^`]*`,children:`([^`]*)`\}\))", m.group(1))]
        if not titles or titles[0] != "model":
            continue
        ctx = None
        before = re.findall(r"support[s]? an? ([\d,]+)-token context window", text[:m.start()])
        if before:
            ctx = tokens(before[-1])
        for row in re.split(r"\],\[", m.group(2)):
            vals = re.findall(r"`([^`]*)`", row)
            ids = [v for v in vals if re.fullmatch(r"kimi-[a-z0-9.\-]+", v)]
            cells = [v for v in vals if "$" in v]
            if not ids or not cells:
                continue
            prices = _blank()
            for title, cell in zip(titles[1:], cells):
                key = _KIMI_COL.get(title)
                if key:
                    prices[key] = price(cell)
            mid = ids[0]
            if mid not in out:
                pm = PageModel(mid, mid, prices)
                if ctx:
                    pm.context, pm.context_exact = ctx
                out[mid] = pm
    if not out:
        raise Unreadable("no DocTable rows in the page source (the table is rendered in the browser)")
    return list(out.values())


# ---------------------------------------------------------------- Cursor


def cursor_slug(display: str) -> str:
    """"Claude Opus 5.5" -> "claude-opus-5.5", "Composer 2.5 (Fast)" ->
    "composer-2.5-fast": the spelling Cursor's own ids use."""
    s = display.lower().replace("(fast)", "fast")
    return re.sub(r"[^a-z0-9.]+", "-", s).strip("-")


# internal/modelclass Family, reimplemented: one model named by two agents
# reduces to one family (Cursor's "claude-4.5-sonnet-thinking" and Claude
# Code's "claude-sonnet-4-5-20250929" are both "claude-sonnet-4-5").
_CURSOR_CLAUDE = re.compile(r"^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)\b")
_API_CLAUDE = re.compile(r"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?\b")


def cursor_family(mid: str) -> str:
    m = mid.strip().lower()
    if m.endswith("[1m]"):
        m = m[:-4]
    if "/" in m:
        m = m[m.rfind("/") + 1:]
    g = _CURSOR_CLAUDE.match(m)
    if g:
        return f"claude-{g.group(2)}-{g.group(1).replace('.', '-')}"
    g = _API_CLAUDE.match(m)
    if g:
        return f"claude-{g.group(1)}-{g.group(2)}" + (f"-{g.group(3)}" if g.group(3) else "")
    for suf in ("-thinking", "-max", "-fast", "-1m"):
        if m.endswith(suf):
            m = m[:-len(suf)]
    return m


# internal/api cursorFamilyID: a family whose table id differs.
CURSOR_FAMILY_ID = {"composer-2.5": "cursor-composer-2.5"}


def cursor_local_ids() -> list:
    """The model ids Caprock's Cursor picker offers without asking Cursor
    (internal/agentcat cursorHelpModels), read from the Go source."""
    try:
        src = (ROOT / "internal" / "agentcat" / "cursor.go").read_text(encoding="utf-8")
    except OSError:
        return []
    m = re.search(r"cursorHelpModels\s*=\s*\[\]string\{([^}]*)\}", src)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def parse_cursor(text: str) -> list:
    """cursor.com/docs/models: price tables by display name. Cursor's own
    models (Composer) are rows under cursor- and are compared; every other
    name is checked for a vendor row it maps to (compare(), mode cursor)."""
    out: dict = {}
    for rows in any_tables(text):
        header = [strip_markup(c).lower() for c in rows[0]]
        if not header or header[0] != "name" or "input" not in header or "output" not in header:
            continue
        col = {"input": header.index("input"), "output": header.index("output")}
        for i, h in enumerate(header):
            if h == "cache read":
                col["cache_read"] = i
            elif h == "cache write":
                col["cache_write_5m"] = i
        for cells in rows[1:]:
            display = strip_markup(cells[0])
            slug = cursor_slug(display)
            mid = "cursor-" + slug if slug.startswith("composer") else slug
            if not slug or mid in out:
                continue
            prices = _blank()
            for k, i in col.items():
                prices[k] = price(cells[i]) if i < len(cells) else None
            out[mid] = PageModel(mid, display, prices)
    if not out:
        raise Unreadable("no Name / Input / Output price table")
    return list(out.values())


# ---------------------------------------------------------------- Codex


def parse_codex(text: str) -> list:
    """openai/codex codex-rs/models-manager/models.json: the catalog Codex's
    model picker lists (`visibility: "list"`); hidden entries are Codex's own
    machinery. Its context_window is Codex's working limit, not the model's,
    so it is not compared."""
    try:
        data = json.loads(text)
    except ValueError as e:
        raise Unreadable(f"not JSON ({e})") from None
    models = data.get("models") if isinstance(data, dict) else None
    if not isinstance(models, list) or not models:
        raise Unreadable("no `models` list")
    out = []
    for m in models:
        slug = (m.get("slug") or "").strip().lower() if isinstance(m, dict) else ""
        if slug:
            out.append(PageModel(slug, m.get("display_name") or slug, _blank(),
                                 hidden=m.get("visibility") != "list"))
    if not out:
        raise Unreadable("no model slugs")
    return out


def codex_discover(fetcher) -> list:
    """Find the catalog file again if it moved: the repository tree, every
    models.json under codex-rs that is not a test fixture."""
    tree = json.loads(fetcher("https://api.github.com/repos/openai/codex/git/trees/main?recursive=1",
                              {"Accept": "application/vnd.github+json"}))
    paths = [e["path"] for e in tree.get("tree", [])
             if re.fullmatch(r"codex-rs/.*/models\.json", e.get("path", "")) and "test" not in e["path"]]
    return [(f"https://raw.githubusercontent.com/openai/codex/main/{p}", {}) for p in paths]


# ---------------------------------------------------------------- model lists


def parse_anthropic_models(text: str) -> list:
    """platform.claude.com models overview, "All models": a row per model with
    its context window ("1M tokens"). Retirements are read from the
    deprecations page, which dates them."""
    for rows in any_tables(text):
        header = [strip_markup(c).lower() for c in rows[0]]
        ci = next((i for i, h in enumerate(header) if "context window" in h), None)
        if not header or header[0] != "model" or ci is None:
            continue
        out = []
        for cells in rows[1:]:
            raw = strip_markup(cells[0])
            if not raw.lower().startswith("claude"):
                continue
            pm = PageModel(anthropic_id(raw), drop_parens(raw), _blank())
            t = tokens(strip_markup(cells[ci])) if ci < len(cells) else None
            if t:
                pm.context, pm.context_exact = t
            out.append(pm)
        if out:
            return out
    raise Unreadable("no All models table with a context window column")


def parse_anthropic_deprecations(text: str) -> list:
    """platform.claude.com model deprecations: API model name, state,
    deprecated, tentative retirement date. Only models not Active are kept."""
    for rows in any_tables(text):
        header = [strip_markup(c).lower() for c in rows[0]]
        if not header or header[0] != "api model name" or "current state" not in header:
            continue
        st, dep = header.index("current state"), header.index("deprecated") if "deprecated" in header else None
        ret = next((i for i, h in enumerate(header) if "retirement" in h), None)
        out = []
        for cells in rows[1:]:
            state = strip_markup(cells[st]) if st < len(cells) else ""
            if not state or state.lower() == "active":
                continue
            parts = [state.lower()]
            if dep is not None and dep < len(cells) and strip_markup(cells[dep]) not in ("", "N/A"):
                parts.append(f"deprecated {strip_markup(cells[dep])}")
            if ret is not None and ret < len(cells):
                parts.append(f"retirement date {strip_markup(cells[ret])}")
            if parts[0] == "deprecated" and len(parts) > 1 and parts[1].startswith("deprecated"):
                parts = parts[1:]
            mid = strip_markup(cells[0]).lower()
            out.append(PageModel(mid, mid, _blank(), retire=", ".join(parts)))
        return out
    raise Unreadable("no API model name / current state table")


def parse_openai_models(text: str) -> list:
    """developers.openai.com/api/docs/models/all.md: a link per model page."""
    ids = re.findall(r"\(/api/docs/models/([a-z0-9][a-z0-9.\-]*)\.md\)", text)
    ids += re.findall(r"Model ID: `([^`]+)`", text)
    out, seen = [], set()
    for mid in (i.lower() for i in ids):
        if mid in ("all", "compare") or mid in seen:
            continue
        seen.add(mid)
        out.append(PageModel(mid, mid, _blank()))
    if not out:
        raise Unreadable("no model page links")
    return out


def openai_model_context(text: str):
    m = re.search(r"([\d,]+)\s+context window", text)
    return tokens(m.group(1)) if m else None


def parse_openai_deprecations(text: str) -> list:
    """developers.openai.com/api/docs/deprecations.md: shutdown date, affected
    model ids in backticks, replacement."""
    out: dict = {}
    for rows in md_tables(text):
        header = [strip_markup(c).lower() for c in rows[0]]
        if "shutdown date" not in header or "affected model" not in header:
            continue
        sd, am = header.index("shutdown date"), header.index("affected model")
        rp = header.index("recommended replacement") if "recommended replacement" in header else None
        for cells in rows[1:]:
            if am >= len(cells):
                continue
            when = strip_markup(cells[sd].replace("*", ""))
            repl = strip_markup(cells[rp]).replace("`", "") if rp is not None and rp < len(cells) else ""
            for mid in re.findall(r"`([^`]+)`", cells[am]):
                mid = mid.lower()
                if mid not in out:
                    out[mid] = PageModel(mid, mid, _blank(),
                                         retire=f"shuts down {when}" + (f", replacement {repl}" if repl else ""))
    if not out:
        raise Unreadable("no Shutdown date / Affected model table")
    return list(out.values())


def parse_gemini_models(text: str) -> list:
    """ai.google.dev/gemini-api/docs/models as markdown: model codes in
    backticks or bold, a card per headline model with its context ("1M
    tokens"), and a caution callout per deprecated model."""
    out: dict = {}
    for mid in re.findall(r"`(gemini-[a-z0-9.\-]+)`|\*\*(gemini-[a-z0-9.\-]+)\*\*", text):
        mid = (mid[0] or mid[1]).lower()
        out.setdefault(mid, PageModel(mid, mid, _blank()))
    for m in re.finditer(r"\*Model code\*\s*\*\*([a-z0-9.\-]+)\*\*[^{]*?\*Context\*\s*\*\*([^*]+)\*\*", text):
        t = tokens(m.group(2))
        if m.group(1) in out and t:
            out[m.group(1)].context, out[m.group(1)].context_exact = t
    for m in re.finditer(r"`(gemini-[a-z0-9.\-]+)` is \[deprecated\]\([^)]*\)(.*?)\{%\s*/callout\s*%\}", text, re.S):
        body = " ".join(strip_markup(m.group(2)).split())
        when = re.search(r"(Effective .*?)(?:\.(?:\s|$)|$)", body)
        if m.group(1) in out:
            out[m.group(1)].retire = "deprecated" + (f"; {when.group(1)}" if when else "")
    if not out:
        raise Unreadable("no gemini- model codes")
    return list(out.values())


def gemini_model_context(text: str):
    m = re.search(r"(?:Context window[^*\n]*\*\*|Input token limit\*\*)\s*([\d,]+)", text)
    return tokens(m.group(1)) if m else None


# ---------------------------------------------------------------- OpenRouter

# OpenRouter vendor prefix -> the price source whose ignore list applies.
OPENROUTER_VENDORS = {"anthropic": "anthropic", "openai": "openai", "google": "google",
                      "deepseek": "deepseek", "minimax": "minimax", "moonshotai": "kimi"}


def parse_openrouter(text: str) -> list:
    """openrouter.ai/api/v1/models: ids only. Anthropic's are dotted there
    ("anthropic/claude-opus-4.8"), dashed in the table. A variant after ":"
    (":batch", ":free") is the same model."""
    try:
        data = json.loads(text).get("data")
    except (ValueError, AttributeError) as e:
        raise Unreadable(f"not the models JSON ({e})") from None
    if not isinstance(data, list) or not data:
        raise Unreadable("no `data` list")
    out: dict = {}
    for m in data:
        full = (m.get("id") or "").lower() if isinstance(m, dict) else ""
        vendor, _, mid = full.partition("/")
        if vendor not in OPENROUTER_VENDORS or not mid or full.endswith(":free"):
            continue
        mid = mid.split(":")[0]
        if vendor == "anthropic":
            mid = re.sub(r"(\d)\.(\d)", r"\1-\2", mid)
        out.setdefault(mid, PageModel(mid, full.split(":")[0], _blank()))
    if not out:
        raise Unreadable("no models from the watched vendors")
    return list(out.values())


# ---------------------------------------------------------------- sources

OPENAI_IGNORE = (
    r"^gpt-4o", r"^gpt-3", r"-pro$", r"-\d{4}-\d{2}-\d{2}$", r"embedding", r"moderation",
    r"image", r"audio", r"realtime", r"transcribe", r"tts", r"search",
    r"cyber", r"rosalind", r"-law$", r"chat-latest$", r"^sora", r"^dall-e",
    r"whisper", r"^computer-use", r"^codex-mini",
    # Generations before gpt-4.1 that no agent Caprock watches runs.
    r"^babbage", r"^davinci", r"^gpt-4$", r"^gpt-4-", r"^gpt-4\.5", r"^o1",
)
GOOGLE_IGNORE = (
    r"tts", r"image", r"embedding", r"robotics", r"live", r"transcribe",
    r"lyria", r"gemma", r"omni", r"decision", r"nano-banana", r"audio",
    r"veo", r"imagen",
)

SOURCES = [
    Source(
        name="anthropic",
        title="Anthropic",
        urls=[
            ("https://platform.claude.com/docs/en/about-claude/pricing.md", {}),
            ("https://platform.claude.com/docs/en/about-claude/pricing", {"Accept": "text/markdown"}),
            ("https://platform.claude.com/docs/en/about-claude/pricing", {"Accept": "text/html"}),
        ],
        parse=parse_anthropic,
        owns=lambda i: i.startswith("claude-"),
    ),
    Source(
        name="openai",
        title="OpenAI",
        urls=[
            ("https://developers.openai.com/api/docs/pricing.md", {}),
            ("https://developers.openai.com/api/docs/pricing", {"Accept": "text/markdown"}),
        ],
        parse=parse_openai,
        owns=lambda i: i.startswith("gpt-") or re.match(r"o\d", i) is not None,
        # Not reachable from a coding agent Caprock observes, or a generation
        # no agent runs: the table prices what Codex and the chat feature use.
        # -pro models are not run by Codex. gpt-4o and gpt-3.x are not either.
        # A dated id (gpt-4.1-2025-04-14) is listed only in the fine-tuning
        # table, whose columns are training and fine-tuned inference prices,
        # not the model's own.
        ignore=OPENAI_IGNORE,
    ),
    Source(
        name="google",
        title="Google Gemini",
        urls=[
            ("https://ai.google.dev/gemini-api/docs/pricing.md.txt", {}),
            ("https://ai.google.dev/gemini-api/docs/pricing", {"Accept": "text/markdown"}),
        ],
        parse=parse_gemini,
        owns=lambda i: i.startswith("gemini-") and i not in ZEN_PRICED,
        # The table notes say image, video, TTS, embedding and robotics models
        # are omitted because no code path can bill them.
        ignore=GOOGLE_IGNORE,
    ),
    Source(
        name="deepseek",
        title="DeepSeek",
        urls=[
            ("https://api-docs.deepseek.com/quick_start/pricing.md", {}),
            ("https://api-docs.deepseek.com/quick_start/pricing", {"Accept": "text/html"}),
        ],
        parse=parse_deepseek,
        owns=lambda i: i.startswith("deepseek-"),
    ),
    Source(
        name="minimax",
        title="MiniMax",
        urls=[
            ("https://platform.minimax.io/docs/guides/pricing-paygo.md", {}),
            ("https://platform.minimax.io/docs/guides/pricing-paygo", {"Accept": "text/markdown"}),
        ],
        parse=parse_minimax,
        owns=lambda i: i.startswith("minimax-") and i not in ZEN_PRICED,
    ),
    Source(
        name="kimi",
        title="Moonshot Kimi",
        # The rendered page and its .md export carry empty tables; the figures
        # are in the HTML's JS payload (pricing.json, Kimi note).
        urls=[("https://platform.kimi.ai/docs/pricing/chat", {"Accept": "text/html"})],
        parse=parse_kimi,
        owns=lambda i: i.startswith("kimi-"),
    ),
    Source(
        name="zen",
        title="OpenCode Zen",
        urls=[
            ("https://opencode.ai/docs/zen/", {"Accept": "text/html"}),
            ("https://opencode.ai/docs/zen.md", {}),
        ],
        parse=parse_zen,
        owns=lambda i: i in ZEN_PRICED,
        mode="zen",
    ),
    Source(
        name="cursor",
        title="Cursor",
        urls=[("https://cursor.com/docs/models", {"Accept": "text/html"})],
        parse=parse_cursor,
        owns=lambda i: i.startswith("cursor-"),
        mode="cursor",
    ),
    Source(
        name="codex",
        title="Codex model catalog",
        urls=[("https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json", {})],
        parse=parse_codex,
        owns=lambda i: False,
        mode="catalog",
        discover=codex_discover,
    ),
    Source(
        name="anthropic-models",
        title="Anthropic models overview",
        urls=[("https://platform.claude.com/docs/en/about-claude/models/overview.md", {})],
        parse=parse_anthropic_models,
        owns=lambda i: i.startswith("claude-"),
        mode="overview",
    ),
    Source(
        name="anthropic-deprecations",
        title="Anthropic model deprecations",
        urls=[("https://platform.claude.com/docs/en/about-claude/model-deprecations.md", {})],
        parse=parse_anthropic_deprecations,
        owns=lambda i: i.startswith("claude-"),
        mode="retire",
    ),
    Source(
        name="openai-models",
        title="OpenAI models",
        urls=[("https://developers.openai.com/api/docs/models/all.md", {})],
        parse=parse_openai_models,
        owns=lambda i: i.startswith("gpt-") or re.match(r"o\d", i) is not None,
        ignore=OPENAI_IGNORE + (r"^gpt-oss", r"^gpt-live", r"^omni-", r"^text-"),
        mode="overview",
        detail=lambda i: f"https://developers.openai.com/api/docs/models/{i}.md",
        detail_parse=openai_model_context,
    ),
    Source(
        name="openai-deprecations",
        title="OpenAI deprecations",
        urls=[("https://developers.openai.com/api/docs/deprecations.md", {})],
        parse=parse_openai_deprecations,
        owns=lambda i: i.startswith("gpt-") or re.match(r"o\d", i) is not None,
        mode="retire",
    ),
    Source(
        name="google-models",
        title="Gemini models",
        urls=[
            ("https://ai.google.dev/gemini-api/docs/models.md.txt", {}),
            ("https://ai.google.dev/gemini-api/docs/models", {"Accept": "text/markdown"}),
        ],
        parse=parse_gemini_models,
        owns=lambda i: i.startswith("gemini-"),
        ignore=GOOGLE_IGNORE + (r"computer-use", r"customtools"),
        mode="overview",
        detail=lambda i: f"https://ai.google.dev/gemini-api/docs/models/{i}.md.txt",
        detail_parse=gemini_model_context,
    ),
    Source(
        name="openrouter",
        title="OpenRouter",
        urls=[("https://openrouter.ai/api/v1/models", {"Accept": "application/json"})],
        parse=parse_openrouter,
        owns=lambda i: False,
        mode="early",
    ),
]


def source(name: str) -> Source:
    return next(s for s in SOURCES if s.name == name)


def fetch(url: str, headers: dict, timeout: float = 30) -> str:
    extra = {}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        extra["Authorization"] = f"Bearer {token}"  # 5,000 requests an hour, not 60
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **extra, **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def read_source(src: Source, saved: str | None = None, rows: list | None = None, fetcher=fetch):
    """(models, how, error): the first URL whose page the parser accepts.

    For an overview source, a priced model the list gives no context window
    for is read from its own page; a page that fails there is noted on the
    model (information), not an unreadable source. A saved page is read
    offline and fetches nothing more."""
    if saved is not None:
        try:
            return src.parse(pathlib.Path(saved).read_text(encoding="utf-8")), saved, None
        except (OSError, Unreadable) as e:
            return None, saved, str(e)
    errors = []
    urls = list(src.urls)
    tried_discover = False
    while urls:
        url, headers = urls.pop(0)
        try:
            models = src.parse(fetcher(url, headers))
            if src.detail and rows is not None:
                fill_details(src, models, rows, fetcher)
            return models, url, None
        except (urllib.error.URLError, OSError, ValueError) as e:
            errors.append(f"{url}: {e}")
        except Unreadable as e:
            errors.append(f"{url}: page read but not understood ({e})")
        if not urls and src.discover and not tried_discover:
            tried_discover = True
            try:
                urls = [u for u in src.discover(fetcher) if u not in src.urls]
            except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
                errors.append(f"finding the file again: {e}")
    return None, None, "; ".join(errors)


def fill_details(src: Source, models: list, rows: list, fetcher=fetch) -> None:
    """Read the context window from each priced model's own page."""
    for pm in models:
        if pm.context is not None or not src.owns(pm.id) or ignored(src, pm):
            continue
        row = lookup(rows, pm.id)
        if row is None or row["id"] != pm.id:
            continue
        url = src.detail(pm.id)
        try:
            t = src.detail_parse(fetcher(url, {}))
        except (urllib.error.URLError, OSError, ValueError) as e:
            pm.detail_error = f"{url}: {e}"
            continue
        if t:
            pm.context, pm.context_exact = t
        else:
            pm.detail_error = f"{url}: no context window on the page"


# ---------------------------------------------------------------- comparison


def current_rows(table: dict, today: str | None = None) -> list:
    """The row in force on `today` (YYYY-MM-DD, UTC) for each id, longest id
    first, as internal/cost sorts them.

    internal/cost LookupAt with no timestamp reads the clock: a row whose
    `until` is today or later is still the price, and a change entered in
    advance (the next row) is not yet. Rows for one id are oldest first.
    """
    today = today or dt.datetime.now(dt.timezone.utc).date().isoformat()
    rows, seen = [], set()
    for r in table["models"]:
        if r["id"] in seen:
            continue
        if not r.get("until") or r["until"] >= today:
            rows.append(r)
            seen.add(r["id"])
    return sorted(rows, key=lambda r: len(r["id"]), reverse=True)


def changes_entered(table: dict, today: str | None = None) -> set:
    """Ids whose row in force today is followed by a later one: an announced
    change already in the table."""
    today = today or dt.datetime.now(dt.timezone.utc).date().isoformat()
    return {r["id"] for r in table["models"] if r.get("until") and r["until"] >= today}


def normalize(model: str) -> str:
    """internal/cost normalizeModel, reimplemented."""
    m = model.strip().lower()
    i = m.find("anthropic.")
    if i >= 0:
        m = m[i + len("anthropic."):]
    i = m.find("@")
    if i >= 0:
        m = m[:i]
    i = m.rfind("/")
    if i >= 0:
        m = m[i + 1:]
    return m


# internal/cost modelSuffix: what may follow a row's id in an id it matches —
# a dated snapshot, a Bedrock version, a bracket ("[1m]"), or ":" and anything.
_SUFFIX = re.compile(r"(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[[^\]]*\])?(?::.*)?")


def matches(m: str, row_id: str) -> bool:
    """internal/cost matchesID: the row's id, or it plus a suffix naming the
    same model. claude-fable-5-2 is not claude-fable-5."""
    return m.startswith(row_id) and _SUFFIX.fullmatch(m[len(row_id):]) is not None


def lookup(rows: list, model: str):
    """internal/cost LookupAt at "now": the longest row id that matches it."""
    m = normalize(model)
    for r in rows:
        if matches(m, r["id"]):
            return r
    return None


def same(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def ignored(src: Source, pm: PageModel) -> bool:
    patterns = src.ignore
    if src.mode == "early":
        vendor = pm.display.split("/")[0]
        if vendor in OPENROUTER_VENDORS:
            patterns = patterns + source(OPENROUTER_VENDORS[vendor]).ignore
    return any(re.search(p, pm.id) for p in patterns)


def context_finding(row: dict, pm: PageModel):
    """("drift" | "info" | None, item): the page's context window against the
    row's. A rounded figure ("1M") matches a row within 5% of it."""
    if pm.context is None:
        return None, None
    have = int(row.get("context_window") or 0)
    item = {"model": pm.id, "row": row["id"], "table": have, "page": pm.context, "exact": pm.context_exact}
    if have == 0:
        return "info", item
    if have == pm.context or (not pm.context_exact and abs(have - pm.context) <= 0.05 * pm.context):
        return None, None
    return "drift", item


DRIFT = ("missing", "collision", "changed", "context")
INFO = ("gone", "tiers", "announced", "ignored", "unlisted", "unmapped", "context_unknown",
        "retiring", "detail")


def compare(table: dict, results: list, today: str | None = None, cursor_local=None) -> dict:
    """Findings from [(source, models | None, how, error)], against the rows in
    force on `today` (default: the UTC date now). Only the DRIFT keys and an
    unreadable source change the exit status; the INFO keys are reported."""
    rows = current_rows(table, today)
    entered = changes_entered(table, today)
    f = {k: [] for k in DRIFT + INFO + ("unreadable",)}
    for src, models, how, err in results:
        if models is None:
            f["unreadable"].append({"source": src.name, "title": src.title, "error": err})
            continue
        seen = set()
        for pm in models:
            if ignored(src, pm):
                f["ignored"].append({"source": src.name, "model": pm.id})
                continue
            seen.add(pm.id)
            base = {"source": src.name, "model": pm.id, "display": pm.display, "page": pm.prices}
            if pm.detail_error:
                f["detail"].append({"source": src.name, "model": pm.id, "error": pm.detail_error})
            if pm.alias:
                continue
            row = lookup(rows, pm.id)
            if src.mode in ("overview", "retire", "early", "catalog"):
                if pm.retire and row is not None:
                    f["retiring"].append({"source": src.name, "model": pm.id, "row": row["id"], "retire": pm.retire})
                if src.mode == "retire":
                    continue
                if row is None:
                    if src.mode == "catalog" and not pm.hidden:
                        f["missing"].append(base)
                    else:
                        f["unlisted"].append({**base, "hidden": pm.hidden})
                    continue
                if src.mode == "overview" and row["id"] == pm.id:
                    kind, item = context_finding(row, pm)
                    if kind:
                        f["context" if kind == "drift" else "context_unknown"].append({"source": src.name, **item})
                continue
            if src.mode == "zen":
                if is_free(pm.id):
                    continue
                if pm.id not in ZEN_PRICED:
                    if row is None:
                        f["unlisted"].append(base)
                    continue  # the vendor's own price is the row's source
            if src.mode == "cursor" and not src.owns(pm.id):
                fam = cursor_family(pm.id)
                if lookup(rows, CURSOR_FAMILY_ID.get(fam, fam)) is None:
                    f["unmapped"].append({"source": src.name, "model": pm.display, "id": pm.id, "family": fam})
                continue
            if pm.tiers and not (row and row.get("tiers") and row["id"] == pm.id):
                f["tiers"].append({**base, "tiers": pm.tiers})
            if pm.announced:
                f["announced"].append({**base, "announced": pm.announced, "entered": pm.id in entered})
            if row is None:
                f["missing"].append(base)
            elif row["id"] != pm.id:
                f["collision"].append({**base, "row": row["id"], "table": pick(row)})
            else:
                kind, item = context_finding(row, pm)
                if kind:
                    f["context" if kind == "drift" else "context_unknown"].append({"source": src.name, **item})
                diff = {k: {"table": row.get(k), "page": v} for k, v in pm.prices.items()
                        if v is not None and not same(float(row.get(k, 0.0)), v)}
                # The row's highest prompt-size tier against the page's, when
                # both have one; a tier the row lacks is listed for information.
                if row.get("tiers") and pm.tier_prices:
                    top = row["tiers"][-1]
                    for k, v in pm.tier_prices.items():
                        if v is not None and not same(float(top.get(k, 0.0)), v):
                            diff[f"{k} above {top['above_prompt_tokens']:,} tokens"] = {"table": top.get(k), "page": v}
                if diff:
                    f["changed"].append({**base, "table": pick(row), "diff": diff})
        if src.mode == "cursor":
            # The ids Caprock's own Cursor picker offers, mapped the same way.
            for mid in cursor_local_ids() if cursor_local is None else cursor_local:
                fam = cursor_family(mid)
                if lookup(rows, CURSOR_FAMILY_ID.get(fam, fam)) is None:
                    f["unmapped"].append({"source": "cursor-picker", "model": mid, "id": mid, "family": fam})
        if src.mode in ("price", "cursor", "zen"):
            for r in rows:
                if src.owns(r["id"]) and r["id"] not in seen:
                    f["gone"].append({"source": src.name, "model": r["id"]})
    return f


def pick(row: dict) -> dict:
    return {k: row.get(k) for k in FIELDS}


def exit_code(f: dict) -> int:
    if f["unreadable"]:
        return 2
    if any(f.get(k) for k in DRIFT):
        return 1
    return 0


# ---------------------------------------------------------------- report


def fmt(v) -> str:
    if v is None:
        return "-"
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if "." not in s or len(s.split(".")[1]) >= 2 else s + "0"


def fmt_prices(p: dict) -> str:
    names = {"input": "in", "cache_write_5m": "5m write", "cache_write_1h": "1h write",
             "cache_read": "cache read", "output": "out"}
    return ", ".join(f"{names[k]} ${fmt(p[k])}" for k in FIELDS if p.get(k) is not None)


def report(f: dict, table: dict, results: list, today: str) -> str:
    title = {s.name: s.title for s in SOURCES}
    title["cursor-picker"] = "Caprock's Cursor picker"
    out = ["# Pricing drift", ""]
    out.append(f"Checked {today} against `pricing/pricing.json` version `{table.get('version')}`.")
    out.append("Prices are per 1M tokens in USD, as each page states them today.")
    out.append("")
    out.append("## Sources")
    out.append("")
    for src, models, how, err in results:
        if models is None:
            out.append(f"- **{src.title}:** could not read {src.title} ({err}).")
        else:
            out.append(f"- **{src.title}:** {len(models)} models read from {how}")
    out.append("")

    def section(head, items, line):
        if items:
            out.append(f"## {head}")
            out.append("")
            out.extend(line(i) for i in items)
            out.append("")

    def missing_line(i):
        prices = fmt_prices(i["page"])
        if i["source"] == "codex":
            return (f"- **`{i['model']}`** ({i['display']}): Codex offers it in its model picker; "
                    "no row matches it, so its turns are unpriced.")
        return (f"- **`{i['model']}`** ({i['display']}, {title[i['source']]}): {prices}. "
                "No row matches it, so its turns are unpriced.")

    section("Missing from the table", f["missing"], missing_line)
    section("Priced as a different model", f["collision"], lambda i:
            f"- **`{i['model']}`** ({i['display']}, {title[i['source']]}): page says {fmt_prices(i['page'])}; "
            f"the table prices it as `{i['row']}` ({fmt_prices(i['table'])}).")
    section("Price changed", f["changed"], lambda i:
            f"- **`{i['model']}`** ({title[i['source']]}): " + "; ".join(
                f"{k} table ${fmt(d['table'])} → page ${fmt(d['page'])}" for k, d in i["diff"].items()) + ".")
    section("Context window differs", f["context"], lambda i:
            f"- **`{i['model']}`** ({title[i['source']]}): table {i['table']:,} tokens, page "
            f"{i['page']:,}{'' if i['exact'] else ' (rounded on the page)'}. The context fill % uses the row.")
    section("Could not read", f["unreadable"], lambda i:
            f"- could not read {i['title']}: {i['error']}")

    if any(f[k] for k in INFO if k != "ignored"):
        out.append("## For information")
        out.append("")
        out.append("Nothing below opens or keeps the issue open.")
        out.append("")

    def para(head, lines):
        if lines:
            out.append(head)
            out.append("")
            out.extend(lines)
            out.append("")

    para("In the table, not on the page (retired, renamed, or listed elsewhere):",
         [f"- `{i['model']}` ({title[i['source']]})" for i in f["gone"]])
    para("Announced price changes:",
         [f"- `{i['model']}`: " + "; ".join(i["announced"])
          + (" (entered in the table as a dated row)" if i.get("entered") else "") for i in f["announced"]])
    para("Prices the table does not model (a prompt-size tier the row lacks, or audio input):",
         [f"- `{i['model']}`: " + "; ".join(i["tiers"]) for i in f["tiers"]])
    by_src: dict = {}
    for i in f["unlisted"]:
        by_src.setdefault(i["source"], []).append(i["model"] + (" (hidden)" if i.get("hidden") else ""))
    hints = {
        "zen": "Zen sells it; first-party price wins where one exists",
        "openrouter": "new model seen on OpenRouter; check the vendor page",
        "codex": "hidden in Codex's picker",
    }
    para("Models listed with no row in the table (a hint to check the vendor's page, never a price):",
         [f"- **{title[s]}** ({hints.get(s, 'listed by the vendor')}): " + ", ".join(f"`{m}`" for m in sorted(ms))
          for s, ms in by_src.items()])
    para("Cursor model names Caprock cannot map to a priced vendor id (no figure in the "
         "\"at list price\" column; Cursor's own cost is never taken from the table):",
         [f"- {i['model']} (`{i['id']}` → family `{i['family']}`, {title[i['source']]})" for i in f["unmapped"]])
    para("Context windows the table does not record (context_window 0):",
         [f"- `{i['model']}` ({title[i['source']]}): page {i['page']:,} tokens"
          + ("" if i["exact"] else " (rounded)") for i in f["context_unknown"]])
    para("Deprecations and retirements of priced models:",
         [f"- `{i['model']}` (row `{i['row']}`, {title[i['source']]}): {i['retire']}" for i in f["retiring"]])
    para("Model pages not read (context window not checked):",
         [f"- `{i['model']}`: {i['error']}" for i in f["detail"]])
    if f["ignored"]:
        out.append(f"{len(f['ignored'])} page models are deliberately not priced and were skipped "
                   "(the `ignore` lists in `scripts/pricing-watch.py`).")
        out.append("")
    if exit_code(f) == 0:
        out.append("No drift: every watched model on the pages matches its row.")
    else:
        out.append("Copy a number into `pricing/pricing.json` by hand, with the page and the date "
                   "it was read in a note, and bump `version` "
                   "(`.ai/06-engineering-rules.md`, pricing). This report is not a source.")
    return "\n".join(out).rstrip() + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true", help="print findings as JSON")
    ap.add_argument("--table", default=str(TABLE), help="pricing table to compare against")
    ap.add_argument("--source", action="append", default=[], metavar="NAME=FILE",
                    help="read a saved page for a source instead of fetching it")
    ap.add_argument("--only", action="append", default=[], metavar="NAME",
                    help="check only these sources")
    args = ap.parse_args(argv)

    table = json.loads(pathlib.Path(args.table).read_text(encoding="utf-8"))
    saved = dict(s.split("=", 1) for s in args.source)
    wanted = [s for s in SOURCES if not args.only or s.name in args.only]
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    rows = current_rows(table, today)
    results = []
    for src in wanted:
        models, how, err = read_source(src, saved.get(src.name), rows)
        results.append((src, models, how, err))
    f = compare(table, results, today)
    code = exit_code(f)
    if args.json:
        json.dump({"checked": today, "table_version": table.get("version"),
                   "exit": code, "findings": f,
                   "sources": [{"name": s.name, "read_from": how, "models": None if m is None else len(m),
                                "error": e} for s, m, how, e in results]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(report(f, table, results, today))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - any crash must not read as "drift"
        print(f"pricing-watch failed: {e!r}", file=sys.stderr)
        sys.exit(3)
