"""Tests for scripts/changelog.py (run: make test-scripts)."""

import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("changelog", os.path.join(HERE, "changelog.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

CHANGELOG = """# Changelog

Intro.

## [Unreleased]

Changes waiting for the next release are in `changes/unreleased/`.

## [0.1.0] - 2026-10-01

### Fixed

- **old:** shipped.
"""


def frag(kind, body):
    return f"---\nkind: {kind}\n---\n{body}\n"


class Repo(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        os.makedirs(os.path.join(self.dir, "changes", "unreleased"))
        self.write("CHANGELOG.md", CHANGELOG)

    def write(self, rel, text):
        with open(os.path.join(self.dir, rel), "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def read(self, rel):
        with open(os.path.join(self.dir, rel), encoding="utf-8", newline="") as f:
            return f.read()

    def fragment(self, name, kind, body):
        self.write(os.path.join("changes", "unreleased", name), frag(kind, body))

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        os.environ["CHANGELOG_ROOT"] = self.dir
        self.addCleanup(os.environ.pop, "CHANGELOG_ROOT", None)
        with redirect_stdout(out), redirect_stderr(err):
            code = mod.main(list(argv))
        return code, out.getvalue(), err.getvalue()


class Parse(unittest.TestCase):
    def test_reads_kind_and_body(self):
        kind, body = mod.parse(frag("Fixed", "- **ui:** a fix.\n  More of it."))
        self.assertEqual(kind, "Fixed")
        self.assertEqual(body, "- **ui:** a fix.\n  More of it.")

    def test_crlf_reads_as_lf(self):
        kind, body = mod.parse("---\r\nkind: Added\r\n---\r\n- **a:** b.\r\n  c.\r\n")
        self.assertEqual((kind, body), ("Added", "- **a:** b.\n  c."))

    def test_rejects(self):
        cases = {
            "no front matter": "- **a:** b.\n",
            "unclosed": "---\nkind: Added\n- **a:** b.\n",
            "no kind": "---\n---\n- **a:** b.\n",
            "unknown kind": frag("Improved", "- **a:** b."),
            "other key": "---\nkind: Added\nscope: a\n---\n- **a:** b.\n",
            "empty": frag("Added", ""),
            "not a scoped bullet": frag("Added", "Some prose."),
            "heading": frag("Added", "- **a:** b.\n### Fixed"),
            "cyrillic": frag("Added", "- **a:** привет."),
        }
        for what, text in cases.items():
            with self.subTest(what):
                with self.assertRaises(mod.FragmentError):
                    mod.parse(text, what)

    def test_greek_is_fine(self):
        mod.parse(frag("Added", "- **a:** αβγ."))


class Commands(Repo):
    def test_check_passes_and_fails(self):
        self.fragment("1-a.md", "Added", "- **a:** one.")
        self.assertEqual(self.run_main("check")[0], 0)
        self.fragment("2-b.md", "Nope", "- **b:** two.")
        code, _, err = self.run_main("check")
        self.assertEqual(code, 1)
        self.assertIn("2-b.md", err)

    def test_check_with_no_directory_passes(self):
        shutil.rmtree(os.path.join(self.dir, "changes"))
        self.assertEqual(self.run_main("check")[0], 0)

    def test_check_rejects_a_non_markdown_file(self):
        self.write(os.path.join("changes", "unreleased", "x.txt"), "x")
        self.assertEqual(self.run_main("check")[0], 1)

    def test_assemble_groups_by_kind_in_keep_a_changelog_order(self):
        self.fragment("b.md", "Fixed", "- **b:** fixed.")
        self.fragment("a.md", "Security", "- **a:** secured.")
        self.fragment("c.md", "Added", "- **c:** added.\n  Second line.")
        self.fragment("d.md", "Added", "- **d:** added too.")
        self.write(os.path.join("changes", "unreleased", ".gitkeep"), "")
        code, _, err = self.run_main("assemble", "v0.2.0", "2026-10-16")
        self.assertEqual(code, 0, err)
        want = CHANGELOG.replace(
            "## [0.1.0]",
            "## [0.2.0] - 2026-10-16\n\n"
            "### Added\n\n- **c:** added.\n  Second line.\n- **d:** added too.\n\n"
            "### Fixed\n\n- **b:** fixed.\n\n"
            "### Security\n\n- **a:** secured.\n\n"
            "## [0.1.0]",
        )
        self.assertEqual(self.read("CHANGELOG.md"), want)
        left = os.listdir(os.path.join(self.dir, "changes", "unreleased"))
        self.assertEqual(left, [".gitkeep"])

    def test_preview_prints_and_changes_nothing(self):
        self.fragment("a.md", "Changed", "- **a:** changed.")
        code, out, _ = self.run_main("preview")
        self.assertEqual(code, 0)
        self.assertIn("### Changed\n\n- **a:** changed.\n", out)
        self.assertEqual(self.read("CHANGELOG.md"), CHANGELOG)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "changes", "unreleased", "a.md")))

    def test_preview_with_nothing(self):
        self.assertIn("no unreleased", self.run_main("preview")[1])

    def test_assemble_refuses(self):
        self.assertEqual(self.run_main("assemble", "0.2.0", "2026-10-16")[0], 1)  # no fragments
        self.fragment("a.md", "Added", "- **a:** x.")
        for args in (("0.1.0", "2026-10-16"), ("1.2", "2026-10-16"), ("0.2.0", "16.10.2026")):
            with self.subTest(args):
                self.assertEqual(self.run_main("assemble", *args)[0], 1)
        self.fragment("b.md", "Bad", "- **b:** y.")
        self.assertEqual(self.run_main("assemble", "0.2.0", "2026-10-16")[0], 1)
        self.assertEqual(self.read("CHANGELOG.md"), CHANGELOG)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "changes", "unreleased", "a.md")))

    def test_usage(self):
        self.assertEqual(self.run_main("nonsense")[0], 2)


@unittest.skipUnless(shutil.which("git"), "git not installed")
class GitOrder(Repo):
    def empty_config(self):
        # os.devnull is NUL on Windows, which git cannot read as a file.
        path = os.path.join(tempfile.mkdtemp(), "config")
        self.addCleanup(shutil.rmtree, os.path.dirname(path), ignore_errors=True)
        open(path, "w").close()
        return path

    def git(self, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com",
                   GIT_CONFIG_GLOBAL=self.empty_config(), GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "-C", self.dir, *args], check=True, capture_output=True, env=env)

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "--no-gpg-sign", "-m", msg)

    def test_order_is_when_git_added_them_then_uncommitted_by_name(self):
        self.git("init", "-q")
        self.fragment("z-first.md", "Added", "- **z:** first.")
        self.commit("one")
        self.fragment("a-second.md", "Added", "- **a:** second.")
        self.commit("two")
        self.fragment("n-uncommitted.md", "Added", "- **n:** third.")
        self.fragment("m-uncommitted.md", "Added", "- **m:** third too.")
        bodies = [b for _, _, b in mod.load(self.dir)]
        self.assertEqual(bodies, ["- **z:** first.", "- **a:** second.",
                                  "- **m:** third too.", "- **n:** third."])

    def test_a_slug_reused_after_a_release_sorts_by_its_newest_addition(self):
        self.git("init", "-q")
        self.fragment("reused.md", "Added", "- **r:** old.")
        self.commit("one")
        os.remove(os.path.join(self.dir, "changes", "unreleased", "reused.md"))
        self.fragment("other.md", "Added", "- **o:** other.")
        self.commit("release")
        self.fragment("reused.md", "Added", "- **r:** new.")
        self.commit("three")
        bodies = [b for _, _, b in mod.load(self.dir)]
        self.assertEqual(bodies, ["- **o:** other.", "- **r:** new."])


if __name__ == "__main__":
    unittest.main()
