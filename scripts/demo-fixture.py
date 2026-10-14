#!/usr/bin/env python3
"""Derive the site stand's fixture from a real Caprock work session, read-only.

    python3 -I scripts/demo-fixture.py <session-id> "<from UTC>" "<to UTC>" testdata/demo/caprock-session.json

The owner asked for the site's captures to come from a real Caprock session
rather than a made-up one (2026-10-14). This reads the database of the
machine it runs on through a read-only URI, takes ONE orchestrating Claude
Code session whose checkout is this public repository (~/dev/caprock) and the
subagents it ran in this repository's worktrees, and keeps only the shape:
which tool ran when, on which repository-relative file or which first line of
a command, how long it took, the token counts of every turn, the subagents'
short task phrases, the plan-limit readings, the caprock project's daily
spend, and this repository's own pull requests and their CI (public).

Everything that reaches the file goes through an allow-list, and whatever
fails it is dropped rather than rewritten: no prompt text, no reply text, no
path outside the repository, no command that is not one of a few plain tools,
no line naming a key, a token, mail or Telegram, no other project. Scan the
output before committing it all the same (the stand's README says how).
"""
import json, os, re, sqlite3, sys, subprocess, hashlib

if len(sys.argv) != 5:
    sys.exit(__doc__)
SID, T0, T1, OUT = sys.argv[1:]
DATA = os.environ.get("CAPROCK_DATA_DIR") or os.path.expanduser("~/Library/Application Support/caprock")
db = sqlite3.connect("file:" + os.path.join(DATA, "caprock.db") + "?mode=ro", uri=True)
lo = int(db.execute("SELECT strftime('%s', ?)", (T0,)).fetchone()[0]) * 1000
hi = int(db.execute("SELECT strftime('%s', ?)", (T1,)).fetchone()[0]) * 1000
HOME = os.path.expanduser("~")

BAD = re.compile(r"/Users|/private|/tmp|/var/|Library|<<|@|https?:|token|secret|passw|keychain|telegram|mail|inbox|"
                 r"apikey|api_key|bearer|caprock-web|\.claude|scratchpad|tool-results|dspv|\$HOME|~|"
                 "[\u0400-\u04ff]|"
                 r"deepseek|oauth|imap|smtp|spacemail|icloud|gmail", re.I)
SKIP_AGENT = re.compile(r"secret|keychain|site|pricing|seo|guide|mail|telegram", re.I)
SKIP_PR = re.compile(r"mail|telegram|keychain|secret|security|password|deepseek|remote|relay", re.I)
ROOT = re.compile("^" + re.escape(HOME) + r"/dev/caprock(?:/\.claude/worktrees/agent-[0-9a-f]+)?/")
OK_CMD = {"git", "go", "gh", "grep", "rg", "sed", "make", "npm", "npx", "ls", "cat", "head", "wc", "diff", "find"}


def path(p):
    if not isinstance(p, str) or not ROOT.match(p):
        return None
    rel = ROOT.sub("", p)
    return None if BAD.search(rel) or rel.startswith(".") else rel


def command(c):
    if not isinstance(c, str):
        return None
    c = c.split("\n", 1)[0].strip()
    c = re.sub(r"^cd \S+ && ", "", c)
    c = re.sub(r"\s*(2>&1|2>/dev/null)", "", c)
    c = re.sub(r"\s*\|\s*(head|tail)( -n)? ?-?\d*$", "", c)
    if not c or BAD.search(c) or c.split()[0] not in OK_CMD or "sed -i" in c or len(c) < 12:
        return None
    if len(c) > 72:
        c = c[:72].rsplit(" ", 1)[0]
    # A cut can leave a dangling operator.
    c = re.sub(r"\s*(&&|\||;|\\)\s*$", "", c)
    return c


def target(tool, ti):
    if not isinstance(ti, dict):
        return None
    if tool in ("Read", "Edit", "Write", "MultiEdit"):
        return path(ti.get("file_path"))
    if tool == "Bash":
        return command(ti.get("command"))
    if tool in ("Grep", "Glob"):
        pat = ti.get("pattern")
        if isinstance(pat, str) and len(pat) <= 40 and not BAD.search(pat):
            return pat
    return None


def tool_rows(agent):
    cond = "(agent_id IS NULL OR agent_id = '')" if agent is None else "agent_id = ?"
    args = (SID, lo, hi) if agent is None else (SID, lo, hi, agent)
    pre = {}
    rows = []
    for ts, kind, tool, key, p in db.execute(
            f"SELECT ts, kind, tool, key, payload FROM events WHERE session_id=? AND source='hook' "
            f"AND kind IN ('tool.pre','tool.post') AND ts BETWEEN ? AND ? AND {cond} ORDER BY ts", args):
        d = json.loads(p)
        use = d.get("tool_use_id")
        if kind == "tool.pre":
            t = target(tool, d.get("tool_input"))
            if tool in ("Read", "Edit", "Write", "Bash", "Grep", "Glob", "MultiEdit") and t:
                pre[use] = len(rows)
                rows.append([round((ts - lo) / 1000), tool, t, None])
        elif use in pre:
            r = rows[pre[use]]
            r[3] = max(1, round((ts - lo) / 1000) - r[0])
    return rows


def turns(agent):
    cond = "(agent_id IS NULL OR agent_id = '')" if agent is None else "agent_id = ?"
    args = (SID, lo, hi) if agent is None else (SID, lo, hi, agent)
    return [[round((ts - lo) / 1000), m, ti or 0, to or 0, cr or 0, cw or 0]
            for ts, m, ti, to, cr, cw in db.execute(
                f"SELECT ts, model, tokens_in, tokens_out, cache_read, cache_write FROM events WHERE session_id=? "
                f"AND kind='turn.assistant' AND ts BETWEEN ? AND ? AND {cond} ORDER BY ts", args)]


agents = []
for ts, p in db.execute("SELECT ts, payload FROM events WHERE session_id=? AND kind='tool.post' AND tool='Agent' "
                        "AND source='hook' AND ts BETWEEN ? AND ? ORDER BY ts", (SID, lo - 30 * 60000, hi)):
    d = json.loads(p)
    r = d.get("tool_response") or {}
    ti = d.get("tool_input") or {}
    if not isinstance(r, dict) or not r.get("agentId"):
        continue
    desc = r.get("description") or ""
    if SKIP_AGENT.search(desc) or BAD.search(desc) or len(desc) > 60:
        continue
    aid = r["agentId"]
    calls = tool_rows(aid)
    if len(calls) < 8:
        continue
    branch = None
    for _, tool, t, _ in calls:
        m = re.search(r"checkout -q? ?-b (\S+)", t or "")
        if m and not BAD.search(m.group(1)):
            branch = m.group(1)
            break
    agents.append({
        "id": hashlib.sha1(aid.encode()).hexdigest()[:16],
        "type": ti.get("subagent_type") or "general-purpose",
        "description": desc,
        "branch": branch,
        "launched_s": round((ts - lo) / 1000),
        "turns": turns(aid),
        "calls": calls,
    })

daily = [[d, round(c, 2)] for d, c in db.execute(
    "SELECT julianday(day) - julianday(date(?)), sum(cost_usd) FROM daily_stats WHERE project='caprock' "
    "AND day > date(?, '-28 days') AND day <= date(?) GROUP BY day ORDER BY day", (T0, T0, T0))]
daily = [[int(d), c] for d, c in daily]

prs = []
seen = set()
for num, title, merged in db.execute(
        "SELECT p.number, p.title, p.merged_at > 0 FROM session_prs p JOIN sessions s USING(session_id) "
        "WHERE p.url LIKE 'https://github.com/dspv/caprock/pull/%' AND p.title != '' ORDER BY p.number DESC"):
    if num in seen or SKIP_PR.search(title) or BAD.search(title):
        continue
    seen.add(num)
    prs.append({"number": num, "title": title})
    if len(prs) >= 16:
        break

# Each pull request as GitHub shows it to anyone: dspv/caprock is public.
# Check times are seconds from the window's start, like everything else.
import datetime as _dt
def _s(iso):
    if not iso or iso.startswith("0001"):
        return None
    t = _dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    return round((t - lo) / 1000)
# A pull request's checks are what GitHub shows today, which is not what
# they were in the window once the branch is pushed again or re-run. So a
# fixture that exists keeps its pull requests as first read, and only a
# field it lacks is fetched; DEMO_REFRESH_PRS=1 reads them all again.
prev = {}
if os.path.exists(OUT) and os.environ.get("DEMO_REFRESH_PRS") != "1":
    prev = {p["number"]: p for p in json.load(open(OUT)).get("prs", [])}
    prs = [prev[p["number"]] if p["number"] in prev else p for p in prs]
for pr in prs:
    if pr["number"] in prev and "changed_files" in pr:
        continue
    if pr["number"] in prev:
        g = json.loads(subprocess.run(["gh", "pr", "view", str(pr["number"]), "--repo", "dspv/caprock", "--json",
                                       "changedFiles,commits"], capture_output=True, text=True, check=True).stdout)
        pr["changed_files"], pr["commits"] = g["changedFiles"], len(g["commits"])
        continue
    raw = subprocess.run(["gh", "pr", "view", str(pr["number"]), "--repo", "dspv/caprock", "--json",
                          "state,headRefName,additions,deletions,changedFiles,commits,mergeable,createdAt,mergedAt,statusCheckRollup"],
                         capture_output=True, text=True, check=True).stdout
    g = json.loads(raw)
    pr.update({
        "state": g["state"].lower(), "branch": g["headRefName"], "additions": g["additions"],
        "deletions": g["deletions"], "changed_files": g["changedFiles"], "commits": len(g["commits"]),
        "mergeable": g["mergeable"].lower(),
        "created_s": _s(g["createdAt"]), "merged_s": _s(g.get("mergedAt")),
        "checks": [{"name": c.get("name") or c.get("context"), "workflow": c.get("workflowName") or "",
                    "conclusion": (c.get("conclusion") or "").lower(), "started_s": _s(c.get("startedAt")),
                    "completed_s": _s(c.get("completedAt"))}
                   for c in g.get("statusCheckRollup") or [] if "${{" not in (c.get("name") or "")],
    })

# Only what existed by five minutes past the window, newest eight: a pull
# request opened later (this fixture's own, for one) is not part of it.
prs = [p for p in prs if p["created_s"] is not None and p["created_s"] <= round((hi - lo) / 1000) + 300][:8]

# The repository's recent history for the deck's figures band (merged per
# day, time to merge, CI time, red runs, Actions minutes): its merged pull
# requests of the last 14 days and its 100 newest workflow runs, as GitHub
# shows them to anyone. Times are seconds from the window's start; the stand
# places the newest of them at its own now. A title or branch the allow-list
# refuses is replaced by the pull request's number, not dropped, so the
# counts stay true. Kept as first read unless DEMO_REFRESH_PRS=1.
def _gh(*a):
    return json.loads(subprocess.run(["gh", *a], capture_output=True, text=True, check=True).stdout)


def _safe(text, fallback):
    return fallback if not text or SKIP_PR.search(text) or BAD.search(text) else text


history = None
if os.path.exists(OUT) and os.environ.get("DEMO_REFRESH_PRS") != "1":
    history = json.load(open(OUT)).get("history")
if history is None:
    shown = {p["number"] for p in prs}
    merged = []
    for g in _gh("pr", "list", "--repo", "dspv/caprock", "--state", "merged", "--limit", "60",
                 "--json", "number,title,createdAt,mergedAt,headRefName"):
        if g["number"] in shown:
            continue
        merged.append({"number": g["number"], "title": _safe(g["title"], "Pull request #%d" % g["number"]),
                       "branch": _safe(g["headRefName"], "pr-%d" % g["number"]),
                       "created_s": _s(g["createdAt"]), "merged_s": _s(g["mergedAt"])})
    newest = max(m["merged_s"] for m in merged)
    merged = [m for m in merged if m["merged_s"] >= newest - 14 * 86400]
    branches = {p["branch"] for p in prs}
    runs = []
    for r in _gh("api", "repos/dspv/caprock/actions/runs?per_page=100")["workflow_runs"]:
        if r["head_branch"] in branches:
            continue
        minutes = {}
        for j in _gh("api", "repos/dspv/caprock/actions/runs/%d/jobs?per_page=100" % r["id"])["jobs"]:
            if not j.get("started_at") or not j.get("completed_at"):
                continue
            label = " ".join(j.get("labels") or []).lower()
            os_ = "macos" if "macos" in label else "windows" if "windows" in label else "linux"
            secs = _s(j["completed_at"]) - _s(j["started_at"])
            # GitHub bills each job rounded up to the whole minute.
            minutes[os_] = minutes.get(os_, 0) + max(1, -(-secs // 60))
        runs.append({"name": r["name"], "event": r["event"], "status": r["status"],
                     "conclusion": r["conclusion"] or "", "attempt": r["run_attempt"],
                     "branch": "master" if r["head_branch"] == "master" else
                     _safe(r["head_branch"], "run-%d" % (len(runs) + 1)),
                     "started_s": _s(r["run_started_at"]), "updated_s": _s(r["updated_at"]), "minutes": minutes})
    history = {"merged_prs": merged, "runs": runs}

# The plan windows as Claude Code's status line reported them through the
# window: [t, used_percentage, seconds until that window resets].

limits = {}
for w in ("five_hour", "seven_day"):
    limits[w] = [[round((ts - lo) / 1000), pct, resets - ts // 1000]
                 for ts, pct, resets in db.execute(
                     "SELECT ts, used_percentage, resets_at FROM rate_limit_history WHERE window=? AND ts BETWEEN ? AND ? "
                     "ORDER BY ts", (w, lo, hi))]

out = {
    "about": ("A real Caprock work session, sanitised: the orchestrating Claude Code session in the public "
              "dspv/caprock repository and the subagents it ran in that repository's worktrees, over 85 minutes "
              "on 2026-10-13. Times are seconds from the start of the window; turns are [t, model, input, output, "
              "cache_read, cache_write] tokens; calls are [t, tool, target, seconds_taken]. Paths are relative to "
              "the repository root; commands are first lines, cut at 72 characters. daily_cost is the caprock "
              "project's spend at API list prices per day, by day offset from the window. Pull requests are "
              "dspv/caprock's own, public; history is its recent merged pull requests and "
              "workflow runs, each run with its billed minutes per runner OS. Built by scripts/demo-fixture.py; shown on caprock.dev as example figures."),
    "repo": "caprock",
    "window_s": round((hi - lo) / 1000),
    "orchestrator": {"title": "Land the deck, tabs and cockpit batch", "branch": "master",
                     "turns": turns(None), "calls": tool_rows(None)},
    "agents": agents,
    "daily_cost": daily,
    "prs": prs,
    "limits": limits,
    "history": history,
}
with open(OUT, "w") as f:
    # One row per line: a turn or a call is a short array, and a line each
    # keeps the file readable and its diffs small.
    text = json.dumps(out, indent=1, ensure_ascii=False)
    text = re.sub(r"\[\s+([^\[\]{}]*?)\s+\]", lambda m: "[" + re.sub(r",\s+", ", ", m.group(1)) + "]", text)
    f.write(text + "\n")
print(len(agents), "agents;", len(out["orchestrator"]["calls"]), "orchestrator calls;", len(prs), "prs;", len(daily), "days")
