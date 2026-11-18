"""The single-pass scrub in shots.py leaves exactly what the old one did.

shots.scrub() used to run every rewrite as its own UPDATE, a full scan of
`events` each; on a 2 GB copy that ran for hours. It now records the rewrites
of the two events columns and applies them in one pass. Privacy is the point
of the scrub, so the fast one is held to the slow one here: both run on the
same synthetic database (the schema is the daemon's own migrations) and every
table must come out byte for byte the same.

One table is left out: session_gen, a counter a trigger bumps for every
events row an UPDATE visits. The old statements visited rows their
case-insensitive LIKE matched even when REPLACE then changed nothing, so the
counts differ; the counter's only job is to change, and the shot daemon starts
from a fresh cache anyway.

All names and paths are made up.
"""

import glob
import importlib.util
import os
import shutil
import sqlite3
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "..", "internal", "store", "migrations")

_spec = importlib.util.spec_from_file_location("shots", os.path.join(HERE, "shots.py"))
shots = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shots)

ME = "11111111-2222-3333-4444-555555555555"

# (session id, cwd, repo_root, project)
SESSIONS = [
    (ME, "/Users/ds/dev/caprock", "/Users/ds/dev/caprock", "caprock"),
    ("s-shop", "/Users/ds/dev/shop", "/Users/ds/dev/shop", "shop"),
    # The same leaf twice: the second is numbered, `shop-2`.
    ("s-shop2", "/Users/ds/work/shop", "/Users/ds/work/shop", "shop"),
    ("s-shop3", "/Users/ds/clients/shop/sub", "/Users/ds/clients/shop", "shop"),
    # A dot-directory worktree under its repository.
    ("s-wt", "/Users/ds/dev/shop/.caprock-worktrees/agent-7", "/Users/ds/dev/shop", "shop"),
    # A checkout outside its repository.
    ("s-orca", "/Users/ds/orca/workspaces/ledger/feat", "/Users/ds/dev/ledger", "ledger"),
    # `repo` must not eat the middle of `reporting`.
    ("s-repo", "/Users/ds/dev/repo", "/Users/ds/dev/repo", "repo"),
    ("s-reporting", "/Users/ds/dev/reporting", "/Users/ds/dev/reporting", "reporting"),
    # Shallow roots, moved by equality.
    ("s-tmp", "/tmp", "", "tmp"),
    ("s-slash", "/", "", "workspace"),
    ("s-private", "/private/tmp", "", "tmp"),
    # No repository: the label comes from cwd.
    ("s-scratch", "/private/tmp/claude-501/-Users-ds-dev-caprock/scratchpad/wt-9", "", "wt-9"),
    # Glob metacharacters and text that is not ASCII.
    ("s-glob", "/Users/ds/dev/we[b]*?app", "/Users/ds/dev/we[b]*?app", "we[b]*?app"),
    ("s-greek", "/Users/ds/dev/καφές-ñ", "/Users/ds/dev/καφές-ñ", "καφές-ñ"),
    # A name inside the placeholder the scrub uses, to keep the chains honest.
    ("s-crub", "/Users/ds/dev/CRUB", "/Users/ds/dev/CRUB", "CRUB"),
    ("s-app", "/Users/ds/dev/app", "/Users/ds/dev/app", "app"),
    ("s-app2", "/Users/ds/side/app", "/Users/ds/side/app", "app"),
]

PAYLOADS = [
    '{"cwd":"/Users/ds/dev/shop","tool_input":{"file_path":"/Users/ds/dev/shop/main.go"}}',
    '{"tool_input":{"command":"cd /Users/ds/work/shop && make"}}',
    '{"path":"/Users/dev/dev/shop-2/x","other":"/Users/dev/dev/shop-23"}',
    '{"cwd":"/Users/ds/dev/repo","note":"the reporting job in /Users/ds/dev/reporting/a"}',
    '{"t":"plain words about shop and ledger and reporting"}',
    '{"t":"/USERS/DS/DEV/SHOP upper case, LIKE visits, REPLACE does not"}',
    '{"t":"wildcards 100%_done in /Users/ds/dev/we[b]*?app/x"}',
    '{"t":"/Users/ds/dev/καφές-ñ/αρχείο and /Users/ds/dev/CRUB/z"}',
    '{"t":"/Users/ds/dev/app/a and /Users/ds/side/app/b and /Users/ds/dev/apps"}',
    '{"t":"~~SCRUB3~~ already in the text"}',
    '{"tool_input":{"url":"https://example.com/shop","query":"ledger"}}',
    '{"x":"-Users-ds-dev-shop and /private/tmp/claude-501/-Users-ds-dev-caprock/scratchpad/wt-9/f"}',
    'not json at all /Users/ds/dev/ledger',
    '{"t":"nothing to see"}',
]

TOUCH = ["/Users/ds/dev/shop", "/Users/ds/dev/shop/.caprock-worktrees/agent-7",
         "/Users/ds/work/shop/pkg", "/tmp", "/Users/dev/dev/shop", None,
         "/Users/ds/dev/reporting", "/Users/ds/dev/we[b]*?app"]


def build(path):
    db = sqlite3.connect(path)
    for f in sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql"))):
        with open(f, encoding="utf-8") as fp:
            db.executescript(fp.read())
    for i, (sid, cwd, root, project) in enumerate(SESSIONS):
        db.execute("INSERT INTO sessions(session_id, cwd, repo_root, repo_path, project, "
                   "transcript_path, git_branch, title, prompt) VALUES (?,?,?,?,?,?,?,?,?)",
                   (sid, cwd, root, root or cwd, project,
                    f"/Users/ds/.claude/projects/-Users-ds-dev-{project}/{sid}.jsonl",
                    "dspv/some-branch" if i % 2 else "main", "a title", "a prompt"))
        db.execute("INSERT OR IGNORE INTO daily_stats VALUES ('2026-11-01', ?, 'm', 1, 0.5, 1)", (project,))
        db.execute("INSERT OR IGNORE INTO daily_sessions VALUES ('2026-11-01', ?, ?)", (project, sid))
        db.execute("INSERT INTO session_files(session_id, path, first_ts, last_ts) VALUES (?,?,1,2)",
                   (sid, (root or cwd) + "/file.go"))
    # A name only the rollups still carry.
    db.execute("INSERT INTO daily_stats VALUES ('2026-10-01', 'gone-project', 'm', 1, 0.5, 1)")
    sids = [r[0] for r in db.execute("SELECT sid FROM sessions ORDER BY sid")]
    n = 0
    for p in PAYLOADS:
        for t in TOUCH:
            n += 1
            db.execute("INSERT INTO events(ts, sid, source, kind, payload, touch_dir) "
                       "VALUES (?,?,?,?,?,?)", (n, sids[n % len(sids)], "hook", "tool.pre", p, t))
    # Compressed payloads: 0xEA, a big-endian length, a frame. The length puts
    # a NUL at byte 2, so no LIKE ever sees past it.
    for frame in (b"/Users/ds/dev/shop" * 3, b"\x28\xb5\x2f\xfd" + bytes(range(7, 250, 3))):
        blob = b"\xea" + len(frame).to_bytes(4, "big") + frame
        db.execute("INSERT INTO events(ts, sid, source, kind, payload) VALUES (?,?,?,?,?)",
                   (n, sids[0], "hook", "tool.post", blob))
    # Rows the single pass hands back to SQL: a BLOB with no early NUL (a
    # LIKE sees it, and REPLACE turns it into TEXT), TEXT that is not UTF-8,
    # and TEXT holding a NUL before a needle.
    db.execute("INSERT INTO events(ts, sid, source, kind, payload) VALUES (?,?,?,?,?)",
               (n, sids[1], "hook", "tool.post", b"blob /Users/ds/dev/shop/x and ~~SCRUB0~~"))
    db.execute("INSERT INTO events(ts, sid, source, kind, payload) VALUES (?,?,?,?,CAST(? AS TEXT))",
               (n, sids[1], "hook", "tool.post", b"\xff\xfe /Users/ds/dev/shop/x"))
    db.execute("INSERT INTO events(ts, sid, source, kind, payload) VALUES (?,?,?,?,?)",
               (n, sids[1], "hook", "tool.post", "head\x00 /Users/ds/dev/shop/x"))
    for url in ("https://github.com/someone/private/pull/1", "https://github.com/dspv/caprock/pull/2"):
        db.execute("INSERT INTO session_prs(session_id, url, number, title, last_at) VALUES (?,?,1,'t',1)",
                   (ME, url))
    db.commit()
    db.close()


def dump(path):
    db = sqlite3.connect(path)
    out = {}
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' "
                              "AND name NOT LIKE 'sqlite_%' AND name != 'session_gen' "
                              "AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name"):
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({name})")]
        sel = ", ".join(f"typeof({c}) || ':' || hex({c})" for c in cols) or "1"
        out[name] = sorted(db.execute(f"SELECT {sel} FROM {name}").fetchall())
    db.close()
    return out


class SinglePassScrub(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.saved = (shots.DB, shots.THIS_SESSION)
        self.addCleanup(self.restore)
        shots.THIS_SESSION = ME

    def restore(self):
        shots.DB, shots.THIS_SESSION = self.saved

    def scrubbed(self, defer):
        path = os.path.join(self.dir, f"defer-{defer}.db")
        build(path)
        shots.DB = path
        ok = shots.scrub(defer=defer)
        return ok, path

    def test_one_pass_matches_statement_by_statement(self):
        ok_old, old = self.scrubbed(False)
        ok_new, new = self.scrubbed(True)
        self.assertTrue(ok_old, "the reference scrub failed on the fixture")
        self.assertEqual(ok_old, ok_new)
        a, b = dump(old), dump(new)
        self.assertEqual(sorted(a), sorted(b))
        for table in a:
            self.assertEqual(a[table], b[table], f"{table} differs")
        # The fixture must exercise the rewrite, or equality proves nothing.
        db = sqlite3.connect(new)
        self.addCleanup(db.close)
        # Only the row with a NUL in front of its path keeps it: LIKE stops
        # at the NUL, so no statement ever visited that row.
        left = db.execute("SELECT payload FROM events WHERE typeof(payload)='text' "
                          "AND instr(payload, '/Users/ds/') > 0").fetchall()
        self.assertEqual(left, [("head\x00 /Users/ds/dev/shop/x",)])
        texts = [r[0].decode("utf-8", "replace") for r in db.execute("SELECT CAST(payload AS BLOB) FROM events WHERE typeof(payload)='text'")]
        self.assertTrue(any(f"/Users/dev/dev/{s}" in t for t in texts for s in shots.STAND_INS))

    def test_apply_matches_sqlite_on_its_own(self):
        """_apply against SQLite's REPLACE, = and GLOB, one statement at a time."""
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE t (v TEXT)")
        ops = [("r", "/a/b", "/X"), ("e", "/X", "/eq"), ("g", "/a/shop", "/T"),
               ("r", "shop", "~~SCRUB1~~"), ("r", "~~SCRUB1~~", "store"), ("g", "/a/we[b]*", "/W")]
        values = ["/a/b/c", "/a/b", "/a/shop-2/x", "/a/shop-x", "/a/shop-", "/a/shop-9",
                  "/A/B/c", "shopshop", "/a/we[b]*-1/z", "/a/we[b]*x-1", "καφές /a/b ñ", ""]
        for v in values:
            db.execute("DELETE FROM t")
            db.execute("INSERT INTO t VALUES (?)", (v,))
            for op in ops:
                db.execute(*shots._sql("t", "v", op))
            want = db.execute("SELECT v FROM t").fetchone()[0]
            self.assertEqual(shots._apply([(None, ops)], v), want, v)


if __name__ == "__main__":
    unittest.main()
