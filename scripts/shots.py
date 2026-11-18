"""Screenshot every documented screen, cropped to its actual content.

The previous set was captured in a fixed 1600x913 window regardless of how
much the screen actually drew, so History and Tasks were two-thirds empty
background. Here the page is measured after it settles and the capture is
clipped to that height, which is why each screen gets its own aspect ratio.

THE RULES FOR A PRODUCT CAPTURE
(owner, 2026-10-14, after the site's captures were called "a session about
nothing": one idle tab, an empty spend chart, no CI. These hold for this
script, feature-shots.py and the site's stand in caprock-web scripts/demo.)

1. Busy and current. The session on screen is visibly at work: subagents
   running with real work phrases, a command running now, the spend chart
   with a filled history and its burn/usual line, the context meter and the
   plan limits, the deck with pull requests and CI circles (green, running
   and one red), a cost figure, and more than one project or worktree. One
   idle tab and an empty chart is not a picture of the product.
2. From a real session, not from made-up copy. The site's stand replays
   testdata/demo/caprock-session.json, which scripts/demo-fixture.py derives
   read-only from a real Caprock work session in this public repository and
   sanitises (no prompts, no home paths, no other projects, no secrets).
3. Text that reads on the page. Capture at device scale 2 and crop to the
   region the copy talks about, instead of shrinking the whole window into
   a slot: the app's body text must still be about 12 CSS px where the page
   shows it. A menu bar popover or tray capture is shown large, beside its
   copy, never as a postage stamp.
4. No empty states, unless the copy is about the empty state.
5. Every figure is an example and is labelled so ("Example figures." under
   the capture, CLAUDE.md rule 6). The release on screen is whatever ran.
6. Nothing private: the scrub below for copies of a real database, the
   fixture's allow-list for the stand. Open every PNG before it is
   committed; a green run has published real names twice.
"""
import base64, functools, json, os, pathlib, re, shutil, sqlite3, subprocess, sys, time, urllib.request

# Overridable so the fixture can live outside the repository — it is a copy of
# a real database and has no business sitting in a working tree.
DB = pathlib.Path(os.environ.get("CAPROCK_SHOT_DB",
                                 pathlib.Path(__file__).parent / "shotdata" / "caprock.db"))
# The session running the capture, when it runs inside one.
THIS_SESSION = os.environ.get("CLAUDE_CODE_SESSION_ID") or "8e968de8-d2a4-428f-a7d9-2658b3e6937f"

# Repository names are as identifying as paths, and rewriting the paths alone
# left them on screen: an employer's name, a person's surname, a client's
# project. Anything not on this allow-list is renamed to a neutral stand-in,
# so a name that has never been seen before is anonymised by default rather
# than published because nobody thought to add it to a block-list.
KEEP_PROJECTS = {"caprock"}

# The activity feed's phrases are built from a fixed, small set of tool-input
# fields (see internal/narrate: file_path, command, pattern, url, query). That
# is what makes this fixable — the rest of a payload is free text nobody can
# sanitise by substitution, but nothing else reaches the screen. Each field is
# replaced with something plausible for a generic web service, so the feed
# still reads like real work rather than a row of blanks.
FEED_FIELDS = {
    "file_path": ["src/api/handlers.go", "internal/store/queries.go", "src/app/page.tsx",
                  "cmd/server/main.go", "pkg/auth/token.go", "web/src/lib/client.ts",
                  "migrations/0007_orders.sql", "internal/queue/worker.go"],
    "command": ["go test ./internal/...", "npm run build", "git status --short",
                "make check", "go build ./cmd/server", "npx tsc --noEmit",
                "grep -rn TODO internal/", "docker compose up -d"],
    "pattern": ["func New", "TODO", "handler", "ErrNotFound", "useEffect"],
    "url": ["https://pkg.go.dev/net/http", "https://react.dev/reference/react",
            "https://docs.docker.com/engine/", "https://sqlite.org/lang_select.html"],
    "query": ["go context cancellation", "react suspense streaming",
              "sqlite wal mode", "http retry backoff"],
}
# Session cards lead with the agent's title for the session, or else a prompt
# typed in it (FB-035) — the user's own words, which the path scrub never
# sees. Every session gets one of these instead, and no prompt, so a card can
# never fall back to reading one out of the events.
TITLES = [
    "Add retry with backoff to the webhook sender", "Fix flaky checkout test",
    "Paginate the orders endpoint", "Migrate sessions table to UUID keys",
    "Profile the search indexer", "Tighten auth token expiry",
    "Split the billing worker into two queues", "Review the rate limiter",
    "Dark mode for the admin panel", "Upgrade to React 19",
]
BRANCHES = [
    "feat/webhook-retry", "fix/flaky-checkout", "feat/orders-pagination",
    "chore/react-19", "fix/token-expiry", "feat/admin-dark-mode",
]
STAND_INS = [
    "acme-api", "acme-web", "payments-core", "billing", "checkout",
    "inventory", "notify-svc", "search-index", "data-pipeline", "auth-gateway",
    "scheduler", "reporting", "admin-panel", "mobile-bff", "worker-pool",
    "ingest", "catalog", "pricing-svc", "risk-engine", "web-client",
]


# The columns of `events` the scrub rewrites. Every rewrite below used to be
# one UPDATE ... WHERE col LIKE '%needle%', and on events each is a full scan
# of the biggest table: on a 2 GB copy (1.09M events, 155 roots, 136 names)
# that was thousands of scans and the scrub had not finished after two hours.
# So for these two columns the rewrites are recorded in order instead, and
# applied in ONE pass over the table (_Rewrites.flush). Every other table is
# small and keeps its SQL.
DEFERRED = (("events", "touch_dir"), ("events", "payload"))


@functools.lru_cache(maxsize=None)
def _bounded_rx(a, as_bytes):
    """`a` where no path-name character follows it: `/x/caprock` in
    `/x/caprock/y` and `/x/caprock"`, never in `/x/caprock-web`."""
    if as_bytes:
        return re.compile(re.escape(a.encode()) + rb"(?![A-Za-z0-9._-])")
    return re.compile(re.escape(a) + r"(?![A-Za-z0-9._-])")


def _bounded(v, a, b):
    """The SQL function `scrub_bounded`, on bytes (the statement casts)."""
    if v is None:
        return None
    nb = b.encode()
    return _bounded_rx(a, True).sub(lambda m: nb, v)


def _sql(t, col, op):
    """The statement one rewrite is, exactly as it has always run."""
    kind, a, b = op
    if kind == "r":     # substring, everywhere in the value
        return (f"UPDATE {t} SET {col}=REPLACE({col},?,?) WHERE {col} LIKE ?",
                (a, b, f"%{a}%"))
    if kind == "b":     # substring at a path-name boundary; TEXT, as REPLACE gives
        return (f"UPDATE {t} SET {col}=CAST(scrub_bounded(CAST({col} AS BLOB),?,?) AS TEXT) "
                f"WHERE {col} LIKE ?", (a, b, f"%{a}%"))
    if kind == "e":     # the whole value
        return f"UPDATE {t} SET {col}=? WHERE {col}=?", (b, a)
    # A numbered leaf: `<a>-<digit>...` becomes `<b>-<digit>...`.
    glob = "".join(f"[{ch}]" if ch in "*?[" else ch for ch in a)
    return (f"UPDATE {t} SET {col}=? || substr({col}, ?) WHERE {col} GLOB ?",
            (b, len(a) + 1, glob + "-[0-9]*"))


def _apply(groups, v):
    """The value the recorded rewrites leave, in Python, for a TEXT value.

    The same result as running each statement of _sql in turn: REPLACE is
    case-sensitive and replaces every occurrence left to right, `=` is exact,
    and the GLOB is a literal prefix, a dash and a digit. The LIKE in front of
    each REPLACE only decides which rows a statement visits — it is
    case-insensitive, so it visits a superset, and REPLACE changes nothing in
    a row that does not hold the needle. A group carries a key every needle
    in it contains, so when the key is absent no rewrite in the group can
    fire and the group is skipped with one search instead of five.
    """
    for key, ops in groups:
        if key is not None and key not in v:
            continue
        for kind, a, b in ops:
            if kind == "r":
                if a in v:
                    v = v.replace(a, b)
            elif kind == "b":
                if a in v:
                    v = _bounded_rx(a, False).sub(lambda m: b, v)
            elif kind == "e":
                if v == a:
                    v = b
            else:
                n = len(a)
                if len(v) > n + 1 and v.startswith(a) and v[n] == "-" and "0" <= v[n + 1] <= "9":
                    v = b + v[n:]
    return v


class _Rewrites:
    """Runs a rewrite now, or records it for one pass over `events` later.

    defer=False runs every statement as it is asked for — the scrub as it was
    before the single pass, kept as the reference the equivalence test
    (scripts/test_shots_scrub.py) holds the single pass to.
    """

    def __init__(self, c, defer=True):
        self.c, self.defer = c, defer
        self.groups = {tc: [] for tc in DEFERRED}

    def run(self, t, col, op, key=None):
        if not (self.defer and (t, col) in self.groups):
            self.c.execute(*_sql(t, col, op))
            return
        # The key is only a shortcut if every needle holds it; a wrong one
        # would silently skip a rewrite, so it is checked, not trusted.
        assert key is None or key in op[1], (key, op)
        groups = self.groups[(t, col)]
        if groups and key is not None and groups[-1][0] == key:
            groups[-1][1].append(op)
        else:
            groups.append((key, [op]))

    def replace(self, t, col, a, b, key=None):
        self.run(t, col, ("r", a, b), key)

    def bounded(self, t, col, a, b, key=None):
        self.run(t, col, ("b", a, b), key)

    def equal(self, t, col, a, b, key=None):
        self.run(t, col, ("e", a, b), key)

    def numbered(self, t, col, a, b, key=None):
        self.run(t, col, ("g", a, b), key)

    def flush(self):
        """Apply everything recorded, one read of `events`, writing only rows
        that change. Rows Python cannot prove it handles exactly as SQLite
        would go through the recorded statements themselves, one row each."""
        if not self.defer or not any(self.groups.values()):
            return
        c = self.c
        cols = [col for _, col in DEFERRED]
        # A compressed payload is a BLOB (ADR-093): 0xEA, a four-byte length,
        # a zstd frame. LIKE and GLOB read a BLOB as a C string, up to its
        # first NUL — which the length puts at byte 2 of every frame under
        # 16 MB — and `=` never matches a BLOB against TEXT. So a BLOB whose
        # text before the first NUL is shorter than every needle is one no
        # statement ever visited; any other goes through SQL.
        least = {}
        for col in cols:
            sizes = [len(a.replace("%", "")) if k in ("r", "b") else len(a) + 2
                     for _, ops in self.groups[("events", col)] for k, a, _ in ops if k != "e"]
            least[col] = min(sizes) if sizes else 1 << 62
        sel = ", ".join(
            f"typeof({col}), CASE WHEN typeof({col})='text' THEN CAST({col} AS BLOB) END, "
            f"CASE WHEN typeof({col})='blob' THEN coalesce(nullif(instr({col}, x'00'), 0) - 1, length({col})) END"
            for col in cols)
        slow, last, changed = [], 0, 0
        while True:
            rows = c.execute(f"SELECT id, {sel} FROM events WHERE id > ? ORDER BY id LIMIT 20000",
                             (last,)).fetchall()
            if not rows:
                break
            last = rows[-1][0]
            updates = {col: [] for col in cols}
            for row in rows:
                rid, go_slow, new = row[0], False, {}
                for i, col in enumerate(cols):
                    kind, raw, cstr = row[1 + 3 * i: 4 + 3 * i]
                    groups = self.groups[("events", col)]
                    if kind == "null" or not groups:
                        continue
                    if kind == "blob":
                        if cstr >= least[col]:
                            go_slow = True
                        continue
                    if kind != "text":
                        go_slow = True
                        continue
                    try:
                        v = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        go_slow = True
                        continue
                    # GLOB and LIKE stop at a NUL; REPLACE does not.
                    if "\x00" in v:
                        go_slow = True
                        continue
                    out = _apply(groups, v)
                    if out != v:
                        new[col] = out
                if go_slow:
                    slow.append(rid)
                    continue
                for col, out in new.items():
                    updates[col].append((out, rid))
            for col in cols:
                if updates[col]:
                    c.executemany(f"UPDATE events SET {col}=? WHERE id=?", updates[col])
                    changed += len(updates[col])
        for rid in slow:
            for t, col in DEFERRED:
                for _, ops in self.groups[(t, col)]:
                    for op in ops:
                        q, args = _sql(t, col, op)
                        c.execute(q + " AND id=?", (*args, rid))
        print(f"  rewrote {changed} event column(s) in one pass; {len(slow)} row(s) by statement")
        self.groups = {tc: [] for tc in DEFERRED}


def scrub(defer=True):
    """Hide the capturing session and any real path it reintroduced.

    Deleting it outright leaves Live activity empty, which reads as a broken
    dashboard; rewriting its identity keeps the feed populated while showing
    nothing about this machine.
    """
    try:
        db = sqlite3.connect(DB, timeout=5)
        # A throwaway copy: nothing to lose to a crash mid-write.
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA cache_size=-262144")
        db.create_function("scrub_bounded", 3, _bounded, deterministic=True)
        c = db.cursor()
        w = _Rewrites(c, defer)
        c.execute("UPDATE sessions SET cwd='/Users/dev/dev/acme-api', "
                  "project='acme-api', repo_root='/Users/dev/dev/acme-api', "
                  "repo_path='/Users/dev/dev/acme-api' WHERE session_id=?",
                  (THIS_SESSION,))
        for t, col in (("sessions", "cwd"), ("sessions", "project"),
                       ("sessions", "repo_root"), ("sessions", "repo_path"),
                       ("sessions", "transcript_path"), ("events", "touch_dir"),
                       ("events", "payload"), ("session_files", "path")):
            for old_s, new_s in (("/private/tmp/claude-501/-Users-ds-dev-caprock",
                                  "/Users/dev/dev/acme-api"),
                                 ("/Users/ds/", "/Users/dev/"),
                                 ("-Users-ds-", "-Users-dev-")):
                w.replace(t, col, old_s, new_s)
        # A session can run in a checkout that lives OUTSIDE its repository —
        # a worktree manager that keeps its workspaces in a directory of its
        # own (`~/orca/workspaces/<repo>/<name>`). Flattening below rewrites
        # paths under the repository root, so such a cwd kept the real
        # repository name and the v0.70.1 capture refused to run. Put the
        # session at its repository root first; that is the label the screens
        # derive from it anyway.
        c.execute("UPDATE sessions SET cwd=repo_root, repo_path=repo_root "
                  "WHERE repo_root IS NOT NULL AND repo_root != '' "
                  "AND cwd IS NOT NULL AND cwd != repo_root "
                  "AND substr(cwd, 1, length(repo_root) + 1) != repo_root || '/'")
        # Flatten every repository onto /Users/dev/dev/<name> before renaming
        # anything. Renaming only the project label leaves the directories ABOVE
        # the checkout intact, and those reach the screen: when two checkouts
        # share a basename the Cost screen disambiguates them by prefixing
        # parent segments, so a scrubbed capture published
        # `demo2/notify-svc-2/.caprock-worktrees/inventory-2` — the leaf renamed,
        # the machine's own layout printed above it. Re-rooting removes the
        # parents entirely, so there is nothing left to disambiguate with.
        # Both columns, because a session OUTSIDE any repository has no
        # repo_root at all and its label is derived from cwd instead — which is
        # most of the capture, since the orchestrator runs agents in worktrees
        # under a scratchpad. Re-rooting only repo_root left exactly those rows
        # printing the machine's layout.
        c.execute("SELECT DISTINCT repo_root FROM sessions "
                  "WHERE repo_root IS NOT NULL AND repo_root != '' "
                  "UNION SELECT DISTINCT cwd FROM sessions "
                  "WHERE (repo_root IS NULL OR repo_root = '') "
                  "AND cwd IS NOT NULL AND cwd != ''")
        roots = sorted((r[0] for r in c.fetchall()), key=lambda r: (-len(r), r))
        # Flattening can collide, and a collision reintroduces exactly what
        # this function exists to remove. Two different paths ending in the
        # same leaf both become /Users/dev/dev/<leaf>, and the dashboard's
        # DisambiguateLabels then prints parent segments to tell them
        # apart — printing the machine's own layout, e.g. `ds/dev/caprock`,
        # with the username in it. So a leaf that is already taken gets a
        # number rather than a shared root.
        taken: dict[str, int] = {}
        for root in roots:
            leaf = root.rstrip("/").rsplit("/", 1)[-1]
            # A root this shallow ("/", "/tmp", "/private/tmp") is a prefix of
            # every path on the machine. Substituting it rewrote every slash:
            # the v0.59.0 capture printed a project called
            # "data-pipeline-3Usersdata-pipeline-3devdata-…" at 72% of the
            # month. Such a session is moved onto its own root, by equality.
            # So is a root the flattened paths themselves live under: a
            # session started in ~/dev becomes `/Users/dev/dev` after the
            # username swap, and substituting THAT (it is the shortest root,
            # so it runs last) moved every repository flattened before it
            # down to `/Users/dev/dev/dev/<name>`, where the bounded renames
            # below no longer reach it — the 0.183 capture stopped on a real
            # project name surviving in a Codex session's cwd.
            if (root.strip("/").count("/") < 2 or not leaf
                    or "/Users/dev/dev/".startswith(root.rstrip("/") + "/")):
                leaf = leaf or "workspace"
                n = taken.get(leaf, 0)
                taken[leaf] = n + 1
                flat = f"/Users/dev/dev/{leaf}" if n == 0 else f"/Users/dev/dev/{leaf}-{n + 1}"
                c.execute("UPDATE sessions SET cwd=?, repo_path=? WHERE cwd=? AND (repo_root IS NULL OR repo_root='')",
                          (flat, flat, root))
                c.execute("UPDATE sessions SET repo_root=? WHERE repo_root=?", (flat, root))
                continue
            n = taken.get(leaf, 0)
            taken[leaf] = n + 1
            flat = f"/Users/dev/dev/{leaf}" if n == 0 else f"/Users/dev/dev/{leaf}-{n + 1}"
            if root == flat:
                continue
            for t, col in (("sessions", "cwd"), ("sessions", "repo_root"),
                           ("sessions", "repo_path"), ("sessions", "transcript_path"),
                           ("events", "touch_dir"), ("events", "payload"),
                           ("session_files", "path")):
                # At a path-name boundary: substituting the bare root turned
                # its siblings `caprock-ops` and `caprock-web-37` into
                # `caprock-2-ops` and `caprock-2-web-37` when `caprock` was
                # numbered, and the 0.183 capture printed both on Home.
                w.bounded(t, col, root, flat)

        # A session can sit in a hidden directory UNDER its repository — the
        # orchestrator puts each agent in `<repo>/.caprock-worktrees/<name>` —
        # and re-rooting the repository leaves that suffix intact. The Cost
        # screen prints the segment below the root, so the capture advertised
        # Caprock's own worktree layout. Collapse any session whose path
        # descends through a dot-directory back onto its repository root.
        c.execute("SELECT session_id, cwd, repo_root FROM sessions "
                  "WHERE cwd LIKE '%/.%/%'")
        for sid, cwd, root in c.fetchall():
            head = cwd.split("/.", 1)[0]
            dest = root if root else head
            c.execute("UPDATE sessions SET cwd=?, repo_path=? WHERE session_id=?",
                      (dest, dest, sid))

        # Rename every project that is not explicitly kept. Done after the
        # path rewrites so a name reintroduced through a path is caught too.
        # The daily rollups carry the label too, and the Week screen and the
        # wide Cost ranges read them; a name that only survives there (its
        # sessions long gone) is still a name on screen.
        c.execute("SELECT project FROM sessions WHERE project IS NOT NULL AND project != '' "
                  "UNION SELECT project FROM daily_stats WHERE project IS NOT NULL AND project != '' "
                  "UNION SELECT project FROM daily_sessions WHERE project IS NOT NULL AND project != ''")
        # Longest first. These are substring replacements, so renaming `repo`
        # before `reporting` turns the latter into `<stand-in>rting` — which is
        # both wrong and a giveaway that something was rewritten.
        names = sorted((r[0] for r in c.fetchall() if r[0] not in KEEP_PROJECTS),
                       key=lambda n: (-len(n), n))
        c.execute("SELECT DISTINCT project FROM sessions")
        session_names = {r[0] for r in c.fetchall()}
        # Two passes through a placeholder no repository name contains. A single
        # pass rewrites into names that later iterations then rewrite again —
        # `reporting` became `<stand-in>rting` because an earlier round had
        # already replaced the `repo` inside it.
        cols = (("sessions", "project"), ("sessions", "cwd"),
                ("sessions", "repo_root"), ("sessions", "repo_path"),
                ("sessions", "transcript_path"), ("events", "touch_dir"),
                ("events", "payload"), ("session_files", "path"))
        mapping = []
        for i, real in enumerate(names):
            fake = STAND_INS[i % len(STAND_INS)]
            if i >= len(STAND_INS):
                fake = f"{fake}-{i // len(STAND_INS) + 1}"
            mapping.append((real, f"~~SCRUB{i}~~", fake))
        # `payload` is JSON holding the text the feed renders — a command line,
        # a file path, a fetched URL. A name reaches the screen through those
        # as readily as through the project column, so the whole blob is
        # rewritten rather than a chosen field: the alternative is enumerating
        # every key the UI might ever display.
        # Every path was re-rooted above, so inside a path a name only ever
        # appears as `/Users/dev/dev/<name>` — replaced there, bounded, so a
        # project called `tmp` or `repo` cannot rewrite the middle of another
        # name. The label column is replaced whole. Free text in payloads
        # takes a bare substring only for names long enough not to be a word.
        root = "/Users/dev/dev/"
        path_cols = [tc for tc in cols if tc != ("sessions", "project")]
        for real, token, _ in mapping:
            c.execute("UPDATE sessions SET project=? WHERE project=?", (token, real))
            c.execute("UPDATE daily_stats SET project=? WHERE project=?", (token, real))
            c.execute("UPDATE daily_sessions SET project=? WHERE project=?", (token, real))
            for t, col in path_cols:
                for a, b in ((root + real + "/", root + token + "/"), (root + real + '"', root + token + '"')):
                    w.replace(t, col, a, b, key=real)
                w.equal(t, col, root + real, root + token, key=real)
                # A leaf that collided while flattening was numbered —
                # `<name>-2` — and neither bounded form above matches it; the
                # v0.63.0 capture printed a Codex folder name that way.
                w.numbered(t, col, root + real, root + token, key=real)
            if len(real) >= 4:
                for t, col in (("events", "touch_dir"), ("events", "payload"), ("session_files", "path")):
                    w.replace(t, col, real, token, key=real)
        for _, token, fake in mapping:
            c.execute("UPDATE daily_stats SET project=? WHERE project=?", (fake, token))
            c.execute("UPDATE daily_sessions SET project=? WHERE project=?", (fake, token))
            for t, col in cols:
                w.replace(t, col, token, fake, key="~~SCRUB")
        # Everything below reads `events` (the feed rewrite selects on
        # payload), so the recorded rewrites land first.
        w.flush()
        # Branch names are the owner's words too — the v0.70.1 Live pulse
        # printed `dspv/assess-minimum-lovable` beside a scrubbed project.
        # Anything but the generic names becomes a neutral one.
        c.execute("SELECT DISTINCT git_branch FROM sessions WHERE git_branch IS NOT NULL "
                  "AND git_branch NOT IN ('', 'HEAD', 'main', 'master')")
        for i, branch in enumerate(sorted(r[0] for r in c.fetchall())):
            c.execute("UPDATE sessions SET git_branch=? WHERE git_branch=?",
                      (BRANCHES[i % len(BRANCHES)], branch))
        # Every branch a session was on (0084) reaches the same screens.
        # One neutral name; a session that was on two branches keeps one row.
        c.execute("UPDATE OR IGNORE session_branches SET branch=? "
                  "WHERE branch NOT IN ('', 'HEAD', 'main', 'master')", (BRANCHES[0],))
        c.execute("DELETE FROM session_branches WHERE branch NOT IN ('', 'HEAD', 'main', 'master', ?)",
                  (BRANCHES[0],))
        # A session's pull requests are links and titles from whatever
        # repository it worked in — private ones included. Only Caprock's own,
        # public repository may stay; the same for the deck's own list.
        c.execute("DELETE FROM session_prs WHERE url NOT LIKE 'https://github.com/dspv/caprock/%'")
        c.execute("DELETE FROM github_prs WHERE repo != 'dspv/caprock'")
        # The projects list (0041) holds every repository the machine has, by
        # its real path and name, sessions or not, and Home leads with it:
        # the 0.183 capture printed some sixty of them. Nothing else in the
        # scrub reaches these tables, and a scrubbed path has no `.git` on
        # disk, so the copy's daemon does not list them again.
        c.execute("DELETE FROM project_repos")
        c.execute("DELETE FROM projects")
        c.execute("DELETE FROM folder_labels")
        c.execute("SELECT session_id FROM sessions ORDER BY session_id")
        for i, (sid,) in enumerate(c.fetchall()):
            # `name` is a rename the user typed (0052): their words, like the prompt.
            c.execute("UPDATE sessions SET title=?, prompt='', name='' WHERE session_id=?",
                      (TITLES[i % len(TITLES)], sid))
        # The feed's own text. Rewritten per row so the list reads as varied
        # work rather than one command repeated eighty times.
        c.execute("SELECT rowid, payload FROM events WHERE payload LIKE '%tool_input%'")
        rows = c.fetchall()
        touched = 0
        for i, (rid, blob) in enumerate(rows):
            try:
                d = json.loads(blob)
            except Exception:
                continue
            ti = d.get("tool_input")
            if not isinstance(ti, dict):
                continue
            changed = False
            for field, pool in FEED_FIELDS.items():
                if field in ti and isinstance(ti[field], str) and ti[field]:
                    ti[field] = pool[(i + len(field)) % len(pool)]
                    changed = True
            if changed:
                c.execute("UPDATE events SET payload=? WHERE rowid=?",
                          (json.dumps(d, separators=(",", ":")), rid))
                touched += 1
        # The last word: no real project name may survive in a column the
        # screens print. A miss here has shipped twice, each time found by a
        # reader of the published PNG rather than by this script.
        for real in names:
            # The capturing session was renamed to a stand-in at the top, so
            # a stand-in can be among the names; it is not a real one.
            if re.sub(r"-\d+$", "", real) in STAND_INS:
                continue
            c.execute("SELECT (SELECT COUNT(*) FROM daily_stats WHERE project=?) + "
                      "(SELECT COUNT(*) FROM daily_sessions WHERE project=?)", (real, real))
            if c.fetchone()[0]:
                raise RuntimeError(f"a real project name survived in the daily rollups: {real!r}")
            # A name only the rollups carried (its sessions are gone) is
            # checked there alone: as a path segment it is often a generic
            # directory — `app` — inside some other repository.
            if real not in session_names:
                continue
            # Bounded like the rewrite: `repo` must not match `reporting`.
            # Past the stand-in root, which is not a name: it holds `/dev/`, so
            # a project called `dev` matched every flattened path and the
            # check could never pass.
            seg = "/" + real
            c.execute("WITH sessions AS (SELECT project, "
                      "CASE WHEN cwd LIKE '/Users/dev/dev/%' THEN substr(cwd, 15) ELSE cwd END AS cwd, "
                      "CASE WHEN repo_root LIKE '/Users/dev/dev/%' THEN substr(repo_root, 15) "
                      "ELSE repo_root END AS repo_root FROM main.sessions) "
                      "SELECT COUNT(*) FROM sessions WHERE project=? "
                      "OR cwd LIKE ? OR cwd LIKE ? OR repo_root LIKE ? OR repo_root LIKE ? "
                      "OR cwd GLOB ? OR repo_root GLOB ?",
                      (real, f"%{seg}", f"%{seg}/%", f"%{seg}", f"%{seg}/%",
                       "*" + "".join(f"[{ch}]" if ch in "*?[" else ch for ch in seg) + "-[0-9]*",
                       "*" + "".join(f"[{ch}]" if ch in "*?[" else ch for ch in seg) + "-[0-9]*"))
            if c.fetchone()[0]:
                raise RuntimeError(f"a real project name survived the scrub: {real!r}")
        print(f"  rewrote {touched} feed phrase(s)")
        print(f"  scrubbed {len(names)} project name(s)")
        db.commit(); db.close()
        return True
    except Exception as e:
        print(f"  scrub FAILED: {e}")
        return False

def find_chrome():
    """The browser that takes the shots: $CAPROCK_SHOT_CHROME, else Playwright's
    headless shell, else the installed Chrome.

    The installed Chrome is the last resort on purpose. Started from a
    Caprock session it runs its updater, and macOS then tells the owner that
    "caprock was prevented from modifying apps" (2026-10-07). The headless
    shell has no updater and draws the same pages."""
    if os.environ.get("CAPROCK_SHOT_CHROME"):
        return os.environ["CAPROCK_SHOT_CHROME"]
    cache = pathlib.Path.home() / "Library/Caches/ms-playwright"
    for shell in sorted(cache.glob("chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"), reverse=True):
        return str(shell)
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CHROME = find_chrome()
PORT = 9222
PROFILE = "/tmp/caprock-shots-profile"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4290"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
SHOTS = [("now", "shot-now"), ("cost", "shot-cost"),
         ("history", "shot-history"), ("tasks", "shot-tasks")]
# No Memory shot: its rows are the prose Claude wrote on the machine, which a
# scrub cannot make public (the 0.94.2 capture showed the owner's own chats).
# The site takes Memory from its demo stand (caprock-web scripts/demo).

# What to do on a screen before capturing it. Memory is a search screen, and
# browsing it shows the newest prose on the machine — whatever the last
# session was about, private or not. A search for a neutral technical phrase
# shows what the screen is for and nothing else; read the capture before it
# is published all the same, since the names are scrubbed but prose is prose.
ACTIONS = {
    "notes": """
      (() => {
        const i = document.querySelector('input[aria-label^="Search Claude"]');
        if (!i) return false;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(i, 'the bug');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.form.requestSubmit();
        return true;
      })()
    """,
}
# Screens with no dollar figure to wait for.
NO_MONEY = {"tasks", "notes"}
WIDTH, HEIGHT = 1600, 1400
MIN_H, PAD = 300, 28          # never crop tighter than this; breathing room below
# A screen whose crop ends at a named panel rather than at the viewport. Now
# runs far past 1400px, and the fixed height cut At a glance's donuts in half.
# Cost's donut row runs past the 1400px frame, so the panel snap
# fell back to the Totals edge and left the row's headings as a stray strip
# along the bottom; it ends at the row instead.
CROP_TO = {"now": "at a glance", "cost": "model mix"}


def rpc(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


def evaluate(ws, expr):
    r = rpc(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("value")


def wait_for_burn_window():
    """Wait until Burn now has a rate rather than "measuring".

    The daemon reports a rate only once it has been up for the burn window
    (ten minutes); before that the Now screen and its home-page crop read
    "measuring — needs 10 minutes of running". On a copy nothing new arrives,
    so the rate it settles on is the honest one: none.
    """
    for _ in range(15 * 6):
        try:
            burn = json.load(urllib.request.urlopen(f"{BASE}/v1/stats/summary?range=today")).get("burn") or {}
        except Exception:
            burn = {"filling": True}
        if not burn.get("filling"):
            return
        time.sleep(10)
    print("  Burn now was still measuring after 15 minutes; capturing anyway")


def interrupted_dismissal():
    """JS that dismisses the "still running when Caprock last stopped" banner.

    The copy's daemon reads the owner's last stop as its own, so every capture
    led with a banner about a reboot on someone else's machine. It is
    dismissed per stop, by the stop's timestamp.
    """
    try:
        info = json.load(urllib.request.urlopen(f"{BASE}/v1/status")).get("interrupted") or {}
    except Exception:
        info = {}
    stopped = info.get("stopped_at")
    if not stopped:
        return "void 0"
    return f"try {{ localStorage.setItem('caprock.interrupted.dismissed', '{int(stopped)}') }} catch (e) {{}}"


def main():
    try:
        from websocket import create_connection
    except ImportError:
        print("need websocket-client: pip install websocket-client"); return 1

    # Before anything is captured. `scrub` was defined and never called, so
    # every run relied on whoever ran it having anonymised the database by
    # hand — which happened to be true, and would have stopped being true the
    # first time someone forgot. A failure here is fatal rather than a
    # warning: publishing a screenshot of real repository names is not a thing
    # to discover afterwards.
    if os.environ.get("CAPROCK_SHOT_SCRUBBED") != "1" and not scrub():
        print("refusing to shoot: the database was not scrubbed")
        return 1

    # A fresh profile every run. A profile left from an earlier run kept that
    # run's localStorage (theme, filters, a dismissed banner), and the v0.68.0
    # Now screen sat on "nothing measured" until the profile was deleted.
    shutil.rmtree(PROFILE, ignore_errors=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--window-size={WIDTH},{HEIGHT}", "--disable-gpu", "--hide-scrollbars",
         "--no-first-run", "--remote-allow-origins=*",
         "--force-device-scale-factor=2",          # retina-sharp in a README
         f"--user-data-dir={PROFILE}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                if tabs: break
            except Exception:
                time.sleep(0.25)
        else:
            print("chrome did not come up"); return 1

        ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
        ws = create_connection(ws_url, timeout=30)
        rpc(ws, "Page.enable"); rpc(ws, "Runtime.enable")

        # Put the first-run prompts away before the first render, not after it.
        #
        # Both banners are answered from localStorage at mount, so writing the
        # keys once the screen is up changes nothing that is already on it —
        # and the navigations that follow are hash changes, which do not reload
        # the document and so never re-read the flag. The result was two
        # dismissable strips across the top of every capture, taking a sixth of
        # the frame before a single figure appeared. Set the keys against the
        # origin, then load the document once so they are read.
        wait_for_burn_window()
        rpc(ws, "Page.navigate", {"url": f"{BASE}/#/home"})
        time.sleep(1.5)
        evaluate(ws, interrupted_dismissal())
        evaluate(ws, """
          try {
            localStorage.setItem('caprock.update.dismissed', 'offer');
            const t = Date.now();
            localStorage.setItem('caprock-prompts', JSON.stringify({
              'premium-banner': t, 'premium-hint': t, 'premium-limit': t,
              'premium-cap': t, 'share-week': t, 'share-month': t,
              'teams-banner': t, 'teams-nudge': t, 'star-dismissed': t,
              'setup-later': t,
            }));
            // Repos and CI/CD read the projects list and GitHub, and a copy
            // has neither (the scrub empties the list, the shot daemon has no
            // token): open, each is a panel saying so (rule 4). Folded, as
            // the app folds them, they are one header row. Cost's Cursor
            // panel likewise: its hooks hint prints the shot daemon's
            // throwaway HOME, a /var/folders path, under "No Cursor turns".
            localStorage.setItem('caprock.panel.folds', JSON.stringify(['now.repos', 'now.cicd', 'cost.cursor']));
          } catch (e) {}
        """)

        for theme in ("dark", "light"):
            for route, name in SHOTS:
                # The theme is chosen before the load, in storage, because the
                # load below is a real one and the app reads its palette as it
                # boots. Clicking the header's theme button used to cycle light
                # and dark; since 0.108.0 it opens a seven-palette menu, so the
                # click opened the menu and the light pass never turned light.
                # Dark Pastel, the default dark palette and the one
                # caprock.dev is moving to (owner, 2026-10-13), and Light Cold
                # (owner, 2026-10-12), so the docs and the site match.
                mode = "light-cold" if theme == "light" else "dark-pastel"
                evaluate(ws, "try { localStorage.setItem('caprock-theme-mode', '%s');"
                             " localStorage.setItem('caprock-theme', '%s') } catch (e) {}" % (mode, theme))
                # Navigating to the same document with a different hash does
                # not reload it, and the dismissal flags above are only read as
                # the document boots. Go by way of about:blank so each capture
                # is a real load *of its own route* — Page.reload would reload
                # the document at its default route and lose the hash, which
                # silently made every shot the Now screen.
                rpc(ws, "Page.navigate", {"url": "about:blank"})
                time.sleep(0.3)
                rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{route}"})
                time.sleep(1.5)

                for _ in range(40):
                    time.sleep(0.4)
                    if evaluate(ws, "document.body.innerText.includes('live ·')"):
                        break

                if route in ACTIONS:
                    if not evaluate(ws, ACTIONS[route]):
                        sys.exit(f"{name}: the action before capture found nothing to act on")
                    time.sleep(2.0)

                # A screen that is still fetching shows em-dashes and skeleton
                # bars; capturing then produces the empty-looking dashboard the
                # old screenshots had. Wait for real content to replace them.
                #
                # Every placeholder has to be gone, not just one figure present:
                # the v0.59.0 run passed on the pulse's "$20.90" while the
                # totals still read "reading your figures…" and every table
                # was skeleton bars. The shot daemon reads a fresh copy of the
                # database and re-reads every transcript on start, so a busy
                # machine takes minutes, not seconds — and a timeout is a
                # failure, never a capture of whatever was on screen.
                ready_js = """
                      ((wantMoney) => {
                        // One session's own figures can honestly read $0.00
                        // (a session that has not answered yet); they are
                        // not a total still loading, so they are left out.
                        let t = document.body.innerText;
                        for (const el of document.querySelectorAll('[data-session-figures]')) t = t.replace(el.innerText, '');
                        // The live pulse's rows carry no such mark: a row is
                        // the session's short id and state — now after its
                        // project, "acme-api · 7d492593 · …" — then its
                        // cost on a line of its own, $0.00 for one just
                        // started. Missing the project form held the 0.182.4
                        // Home capture on a live session's $0.00 until it
                        // timed out.
                        t = t.replace(/^(?:.* · )?[0-9a-f]{8}(?: · .*)?\\n\\$0\\.00\\s*$/gm, '');
                        if (document.querySelector('.skeleton-pulse')) return false;
                        if (t.includes('reading your figures')) return false;
                        if (/Reading your projects/i.test(t)) return false;
                        if (t.includes('nothing measured')) return false;
                        // A stat still at zero stands on its own line; a
                        // table row can honestly end in $0.00 (a free model).
                        if (/^\\$0\\.00\\s*$/m.test(t)) return false;
                        // Tasks carries no money; the placeholders are all it has.
                        return !wantMoney || /\\$[0-9][0-9,]*\\.[0-9]{2}/.test(t);
                      })(""" + ("false" if route in NO_MONEY else "true") + ")"
                for _ in range(600):
                    time.sleep(0.5)
                    if evaluate(ws, ready_js):
                        break
                else:
                    # Say which placeholder was still there: "never finished
                    # loading" alone sent the v0.68.0 run into guesswork.
                    why = evaluate(ws, r"""
                      (() => {
                        let t = document.body.innerText;
                        for (const el of document.querySelectorAll('[data-session-figures]')) t = t.replace(el.innerText, '');
                        t = t.replace(/^(?:.* · )?[0-9a-f]{8}(?: · .*)?\n\$0\.00\s*$/gm, '');
                        const z = t.search(/^\$0\.00\s*$/m);
                        return JSON.stringify({
                          skeletons: document.querySelectorAll('.skeleton-pulse').length,
                          reading: t.includes('reading your figures'),
                          nothing_measured: t.includes('nothing measured'),
                          zero_stat: z < 0 ? '' : t.slice(Math.max(0, z - 160), z + 8),
                          any_money: /\$[0-9][0-9,]*\.[0-9]{2}/.test(t),
                        });
                      })()
                    """)
                    sys.exit(f"{name} ({theme}) never finished loading; refusing to capture a half-loaded screen\n  still on screen: {why}")
                time.sleep(2.0)   # let charts and the pulse canvas paint

                # Measure the real drawn height: the lowest bottom edge among
                # visible elements, not the viewport and not scrollHeight
                # (which a full-height flex container inflates back to 1000).
                # Measure the last element that actually carries ink. Taking the
                # lowest bottom edge over every node returns the viewport,
                # because a full-height flex container always reaches it — the
                # exact bug that left two-thirds of the old captures empty.
                h = evaluate(ws, """
                  (() => {
                    let max = 0;
                    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                      if (!n.textContent.trim()) continue;
                      const r = n.parentElement?.getBoundingClientRect();
                      if (r && r.height > 0 && r.height < 900 && r.bottom > max) max = r.bottom;
                    }
                    for (const el of document.querySelectorAll('canvas, svg, table')) {
                      const r = el.getBoundingClientRect();
                      if (r.height > 0 && r.height < 900 && r.bottom > max) max = r.bottom;
                    }
                    return Math.ceil(max);
                  })()
                """) or HEIGHT
                h = max(MIN_H, min(HEIGHT, int(h) + PAD))

                # Cutting a panel in half looks like a broken render. Snap the
                # crop to the nearest panel edge: down to the last panel that
                # fits whole, or up to include one that only just overflows.
                snapped = evaluate(ws, f"""
                  (() => {{
                    const h = {h};
                    let below = 0, above = null;
                    for (const el of document.querySelectorAll('[class*="rounded"], section, article')) {{
                      const r = el.getBoundingClientRect();
                      if (r.height < 40 || r.width < 200) continue;
                      if (r.bottom <= h && r.bottom > below) below = r.bottom;
                      if (r.bottom > h && (above === null || r.bottom < above)) above = r.bottom;
                    }}
                    if (above !== null && above - h < 220) return Math.ceil(above);
                    return below > 200 ? Math.ceil(below) : h;
                  }})()
                """)
                if snapped:
                    h = max(MIN_H, min(HEIGHT, int(snapped) + PAD))
                if route in CROP_TO:
                    bottom = evaluate(ws, """
                      ((want) => {
                        const hit = [...document.querySelectorAll('div,section')].find((el) => {
                          const t = (el.textContent || '').trim().toLowerCase().replace(/^[^a-z0-9]+/, '');
                          const r = el.getBoundingClientRect();
                          return t.startsWith(want) && r.height > 110;
                        });
                        return hit ? Math.ceil(hit.getBoundingClientRect().bottom + window.scrollY) : 0;
                      })(%s)
                    """ % json.dumps(CROP_TO[route]))
                    if not bottom:
                        sys.exit(f"{name}: no panel {CROP_TO[route]!r} to crop to")
                    # Less than the gap to the next panel, or its top edge
                    # shows as a stray line of headings.
                    h = int(bottom) + 10

                # Verify the theme actually took before naming the file after
                # it: a capture saved under the wrong name puts a white
                # dashboard on a dark page, which is what happened once and is
                # invisible until someone looks at the published site.
                # The app records its choice on the root element; body is
                # transparent, so measuring body's background read as dark
                # whatever the theme was.
                for _ in range(20):
                    time.sleep(0.3)
                    cur = evaluate(ws, "document.documentElement.getAttribute('data-theme')")
                    if cur == theme:
                        break
                if cur != theme:
                    raise SystemExit(
                        f"theme mismatch on {route}: asked for {theme}, page rendered {cur}")

                # Ready once is not ready now: a panel that went back to a
                # placeholder in the seconds since (Home's Projects did) is
                # captured as one. Ask again at the last moment.
                for _ in range(120):
                    if evaluate(ws, ready_js):
                        break
                    time.sleep(0.5)
                else:
                    sys.exit(f"{name} ({theme}) went back to a placeholder before the capture; refusing")

                shot = rpc(ws, "Page.captureScreenshot", {
                    "format": "png",
                    "captureBeyondViewport": True,
                    "clip": {"x": 0, "y": 0, "width": WIDTH, "height": h, "scale": 1},
                })
                suffix = "" if theme == "dark" else "-light"
                path = OUT / f"{name}{suffix}.png"
                path.write_bytes(base64.b64decode(shot["data"]))
                print(f"  {path.name:26} {WIDTH}x{h}  {path.stat().st_size:>7} bytes")
        ws.close()
    finally:
        proc.terminate()
    return 0


if __name__ == "__main__":
    # refresh-shots.sh scrubs before the daemon starts: the daemon warms its
    # figure cache on start and serves it stale-while-revalidate, so a scrub
    # under a running daemon left the v0.70.1 Cost screen printing real names.
    if os.environ.get("CAPROCK_SHOT_SCRUB_ONLY") == "1":
        sys.exit(0 if scrub() else 1)
    sys.exit(main())
