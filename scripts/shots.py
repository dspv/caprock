"""Screenshot every documented screen, cropped to its actual content.

The previous set was captured in a fixed 1600x913 window regardless of how
much the screen actually drew, so History and Tasks were two-thirds empty
background. Here the page is measured after it settles and the capture is
clipped to that height, which is why each screen gets its own aspect ratio.
"""
import base64, json, os, pathlib, sqlite3, subprocess, sys, time, urllib.request

# Overridable so the fixture can live outside the repository — it is a copy of
# a real database and has no business sitting in a working tree.
DB = pathlib.Path(os.environ.get("CAPROCK_SHOT_DB",
                                 pathlib.Path(__file__).parent / "shotdata" / "caprock.db"))
THIS_SESSION = "8e968de8-d2a4-428f-a7d9-2658b3e6937f"

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
STAND_INS = [
    "acme-api", "acme-web", "payments-core", "billing", "checkout",
    "inventory", "notify-svc", "search-index", "data-pipeline", "auth-gateway",
    "scheduler", "reporting", "admin-panel", "mobile-bff", "worker-pool",
    "ingest", "catalog", "pricing-svc", "risk-engine", "web-client",
]


def scrub():
    """Hide the capturing session and any real path it reintroduced.

    Deleting it outright leaves Live activity empty, which reads as a broken
    dashboard; rewriting its identity keeps the feed populated while showing
    nothing about this machine.
    """
    try:
        db = sqlite3.connect(DB, timeout=5)
        c = db.cursor()
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
                c.execute(f"UPDATE {t} SET {col}=REPLACE({col},?,?) WHERE {col} LIKE ?",
                          (old_s, new_s, f"%{old_s}%"))
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
            n = taken.get(leaf, 0)
            taken[leaf] = n + 1
            flat = f"/Users/dev/dev/{leaf}" if n == 0 else f"/Users/dev/dev/{leaf}-{n + 1}"
            if root == flat:
                continue
            for t, col in (("sessions", "cwd"), ("sessions", "repo_root"),
                           ("sessions", "repo_path"), ("sessions", "transcript_path"),
                           ("events", "touch_dir"), ("events", "payload"),
                           ("session_files", "path")):
                c.execute(f"UPDATE {t} SET {col}=REPLACE({col},?,?) WHERE {col} LIKE ?",
                          (root, flat, f"%{root}%"))

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
        c.execute("SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND project != ''")
        # Longest first. These are substring replacements, so renaming `repo`
        # before `reporting` turns the latter into `<stand-in>rting` — which is
        # both wrong and a giveaway that something was rewritten.
        names = sorted((r[0] for r in c.fetchall() if r[0] not in KEEP_PROJECTS),
                       key=lambda n: (-len(n), n))
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
        for real, token, _ in mapping:
            for t, col in cols:
                c.execute(f"UPDATE {t} SET {col}=REPLACE({col},?,?) WHERE {col} LIKE ?",
                          (real, token, f"%{real}%"))
        for _, token, fake in mapping:
            for t, col in cols:
                c.execute(f"UPDATE {t} SET {col}=REPLACE({col},?,?) WHERE {col} LIKE ?",
                          (token, fake, f"%{token}%"))
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
        print(f"  rewrote {touched} feed phrase(s)")
        print(f"  scrubbed {len(names)} project name(s)")
        db.commit(); db.close()
        return True
    except Exception as e:
        print(f"  scrub FAILED: {e}")
        return False

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9222
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4290"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
SHOTS = [("now", "shot-now"), ("cost", "shot-cost"),
         ("history", "shot-history"), ("tasks", "shot-tasks")]
WIDTH, HEIGHT = 1600, 1400
MIN_H, PAD = 300, 28          # never crop tighter than this; breathing room below


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
    if not scrub():
        print("refusing to shoot: the database was not scrubbed")
        return 1

    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--window-size={WIDTH},{HEIGHT}", "--disable-gpu", "--hide-scrollbars",
         "--no-first-run", "--remote-allow-origins=*",
         "--force-device-scale-factor=2",          # retina-sharp in a README
         "--user-data-dir=/tmp/caprock-shots-profile", "about:blank"],
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

        for theme in ("dark", "light"):
            for route, name in SHOTS:
                rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{route}"})
                time.sleep(1.5)
                # Dismiss the update banner: a first-run prompt, not a feature,
                # and it pushes the dashboard down in every capture.
                evaluate(ws, "try{localStorage.setItem('caprock.update.dismissed','offer')}catch(e){}")
                # Toggle to the theme we want by clicking the control, which is
                # what a person does. Writing to storage only takes effect on
                # the next document load, and a hash navigation is not one.
                for _ in range(3):
                    cur = evaluate(ws, "document.documentElement.getAttribute('data-theme')")
                    if cur == theme:
                        break
                    evaluate(ws, """
                      (() => {
                        const b = [...document.querySelectorAll('button')].find(
                          (x) => (x.getAttribute('aria-label') || '').includes('theme'));
                        if (b) b.click();
                      })()
                    """)
                    time.sleep(0.8)


                for _ in range(40):
                    time.sleep(0.4)
                    if evaluate(ws, "document.body.innerText.includes('live ·')"):
                        break

                # A screen that is still fetching shows em-dashes and skeleton
                # bars; capturing then produces the empty-looking dashboard the
                # old screenshots had. Wait for real content to replace them.
                for _ in range(50):
                    time.sleep(0.4)
                    ready = evaluate(ws, """
                      (() => {
                        const t = document.body.innerText;
                        if (t.includes('nothing measured yet')) return false;
                        if (/\\$0\\.00\\s*$/m.test(t)) return false;
                        return /\\$[0-9][0-9,]*\\.[0-9]{2}/.test(t);
                      })()
                    """)
                    if ready:
                        break
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

                shot = rpc(ws, "Page.captureScreenshot", {
                    "format": "png",
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
    sys.exit(main())
