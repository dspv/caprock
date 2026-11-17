#!/usr/bin/env python3
"""Compare providers' published model prices with pricing/pricing.json.

    python3 scripts/pricing-watch.py            # markdown report on stdout
    python3 scripts/pricing-watch.py --json     # the same findings as JSON
    python3 scripts/pricing-watch.py --source anthropic=page.md   # read a saved page

Exit status: 0 no drift, 1 drift, 2 a source could not be read (drift or not),
3 the script itself failed. The daily `pricing-watch` workflow turns 1 and 2
into one GitHub issue titled "Pricing drift".

This script only reports. It never edits pricing/pricing.json: a price reaches
the table by hand, with its source and the date it was read (CLAUDE.md rule 6).

Each provider is one entry in SOURCES: a URL list to try in order and a parser
that turns the page text into PageModel rows. Adding a provider is a parser
function and an entry. Stdlib only, so CI needs nothing installed.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import html.parser
import json
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


@dataclasses.dataclass
class Source:
    name: str
    title: str
    urls: list  # (url, extra headers), tried in order
    parse: object  # fn(text) -> list[PageModel]
    owns: object  # fn(table id) -> bool: the rows this source can vouch for
    ignore: tuple = ()  # regexes: page ids deliberately not priced


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


# ---------------------------------------------------------------- sources

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
        ignore=(
            r"^gpt-4o", r"^gpt-3", r"-pro$", r"-\d{4}-\d{2}-\d{2}$", r"embedding", r"moderation",
            r"image", r"audio", r"realtime", r"transcribe", r"tts", r"search",
            r"cyber", r"rosalind", r"-law$", r"^chat-latest$", r"^sora", r"^dall-e",
            r"whisper", r"^computer-use", r"^codex-mini",
        ),
    ),
    Source(
        name="google",
        title="Google Gemini",
        urls=[
            ("https://ai.google.dev/gemini-api/docs/pricing.md.txt", {}),
            ("https://ai.google.dev/gemini-api/docs/pricing", {"Accept": "text/markdown"}),
        ],
        parse=parse_gemini,
        owns=lambda i: i.startswith("gemini-"),
        # The table notes say image, video, TTS, embedding and robotics models
        # are omitted because no code path can bill them.
        ignore=(
            r"tts", r"image", r"embedding", r"robotics", r"live", r"transcribe",
            r"lyria", r"gemma", r"omni", r"decision", r"nano-banana", r"audio",
            r"veo", r"imagen",
        ),
    ),
]


def fetch(url: str, headers: dict, timeout: float = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def read_source(src: Source, saved: str | None = None):
    """(models, how, error): the first URL whose page the parser accepts."""
    if saved is not None:
        try:
            return src.parse(pathlib.Path(saved).read_text(encoding="utf-8")), saved, None
        except (OSError, Unreadable) as e:
            return None, saved, str(e)
    errors = []
    for url, headers in src.urls:
        try:
            return src.parse(fetch(url, headers)), url, None
        except (urllib.error.URLError, OSError, ValueError) as e:
            errors.append(f"{url}: {e}")
        except Unreadable as e:
            errors.append(f"{url}: page read but not understood ({e})")
    return None, None, "; ".join(errors)


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


def compare(table: dict, results: list, today: str | None = None) -> dict:
    """Findings from [(source, models | None, how, error)], against the rows in
    force on `today` (default: the UTC date now)."""
    rows = current_rows(table, today)
    entered = changes_entered(table, today)
    f = {"missing": [], "collision": [], "changed": [], "gone": [], "unreadable": [],
         "tiers": [], "announced": [], "ignored": []}
    for src, models, how, err in results:
        if models is None:
            f["unreadable"].append({"source": src.name, "title": src.title, "error": err})
            continue
        seen = set()
        for pm in models:
            if any(re.search(p, pm.id) for p in src.ignore):
                f["ignored"].append({"source": src.name, "model": pm.id})
                continue
            seen.add(pm.id)
            row = lookup(rows, pm.id)
            base = {"source": src.name, "model": pm.id, "display": pm.display, "page": pm.prices}
            if pm.tiers and not (row and row.get("tiers") and row["id"] == pm.id):
                f["tiers"].append({**base, "tiers": pm.tiers})
            if pm.announced:
                f["announced"].append({**base, "announced": pm.announced, "entered": pm.id in entered})
            if row is None:
                f["missing"].append(base)
            elif row["id"] != pm.id:
                f["collision"].append({**base, "row": row["id"], "table": pick(row)})
            else:
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
        for r in rows:
            if src.owns(r["id"]) and r["id"] not in seen:
                f["gone"].append({"source": src.name, "model": r["id"]})
    return f


def pick(row: dict) -> dict:
    return {k: row.get(k) for k in FIELDS}


def exit_code(f: dict) -> int:
    if f["unreadable"]:
        return 2
    if f["missing"] or f["collision"] or f["changed"]:
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
    out = ["# Pricing drift", ""]
    out.append(f"Checked {today} against `pricing/pricing.json` version `{table.get('version')}`.")
    out.append("Prices are per 1M tokens in USD, as each page states them today.")
    out.append("")
    out.append("## Sources")
    out.append("")
    for src, models, how, err in results:
        if models is None:
            out.append(f"- **{src.title}:** could not read {src.title} pricing ({err}).")
        else:
            out.append(f"- **{src.title}:** {len(models)} models read from {how}")
    out.append("")

    def section(head, items, line):
        if items:
            out.append(f"## {head}")
            out.append("")
            out.extend(line(i) for i in items)
            out.append("")

    section("Missing from the table", f["missing"], lambda i:
            f"- **`{i['model']}`** ({i['display']}, {title[i['source']]}): {fmt_prices(i['page'])}. "
            "No row matches it, so its turns are unpriced.")
    section("Priced as a different model", f["collision"], lambda i:
            f"- **`{i['model']}`** ({i['display']}, {title[i['source']]}): page says {fmt_prices(i['page'])}; "
            f"the table prices it as `{i['row']}` ({fmt_prices(i['table'])}).")
    section("Price changed", f["changed"], lambda i:
            f"- **`{i['model']}`** ({title[i['source']]}): " + "; ".join(
                f"{k} table ${fmt(d['table'])} → page ${fmt(d['page'])}" for k, d in i["diff"].items()) + ".")
    section("Could not read", f["unreadable"], lambda i:
            f"- could not read {i['title']}: {i['error']}")

    info = f["gone"] or f["tiers"] or f["announced"]
    if info:
        out.append("## For information")
        out.append("")
    if f["gone"]:
        out.append("In the table, not on the page (retired, renamed, or listed elsewhere):")
        out.append("")
        out.extend(f"- `{i['model']}` ({title[i['source']]})" for i in f["gone"])
        out.append("")
    if f["announced"]:
        out.append("Announced price changes:")
        out.append("")
        out.extend(f"- `{i['model']}`: " + "; ".join(i["announced"])
                   + (" (entered in the table as a dated row)" if i.get("entered") else "")
                   for i in f["announced"])
        out.append("")
    if f["tiers"]:
        out.append("Prices the table does not model (a prompt-size tier the row lacks, or audio input):")
        out.append("")
        out.extend(f"- `{i['model']}`: " + "; ".join(i["tiers"]) for i in f["tiers"])
        out.append("")
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
    results = []
    for src in wanted:
        models, how, err = read_source(src, saved.get(src.name))
        results.append((src, models, how, err))
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
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
