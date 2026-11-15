"""Tests for scripts/mcp-bundle.py and the launcher it packs (run: make test-scripts)."""

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("mcp_bundle", os.path.join(HERE, "mcp-bundle.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

LAUNCHER = os.path.join(ROOT, "mcpb", "server", "index.js")
NODE = shutil.which("node")


class Bundle(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_bundle_carries_the_release_version_and_server_json_its_url_and_hash(self):
        bundle, sha = mod.build("v1.2.3", self.dir.name)
        with zipfile.ZipFile(bundle) as z:
            self.assertEqual(sorted(z.namelist()), ["icon.png", "manifest.json", "server/index.js"])
            manifest = json.loads(z.read("manifest.json"))
        self.assertEqual(manifest["version"], "1.2.3")
        self.assertEqual(manifest["server"]["entry_point"], "server/index.js")
        self.assertEqual(sha, hashlib.sha256(mod.read(bundle)).hexdigest())
        with open(os.path.join(self.dir.name, "server.json")) as f:
            server = json.load(f)
        self.assertEqual(server["name"], "io.github.dspv/caprock")
        self.assertEqual(server["version"], "1.2.3")
        (pkg,) = server["packages"]
        self.assertEqual(pkg["registryType"], "mcpb")
        self.assertEqual(pkg["identifier"], "https://github.com/dspv/caprock/releases/download/v1.2.3/caprock.mcpb")
        self.assertIn("mcp", pkg["identifier"])  # the registry refuses an MCPB URL without it
        self.assertEqual(pkg["fileSha256"], sha)
        self.assertLessEqual(len(server["description"]), 100)  # the registry schema's limit

    def test_same_commit_same_hash(self):
        _, a = mod.build("v1.2.3", os.path.join(self.dir.name, "a"))
        _, b = mod.build("v1.2.3", os.path.join(self.dir.name, "b"))
        self.assertEqual(a, b)

    def test_refuses_a_prerelease_or_bare_version(self):
        for tag in ("v1.2.3-rc.1", "1.2.3", "v1.2"):
            with self.assertRaises(SystemExit):
                mod.build(tag, self.dir.name)


@unittest.skipIf(NODE is None, "node not installed")
@unittest.skipIf(sys.platform == "win32", "the launcher's POSIX search is tested here")
class Launcher(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = os.path.join(self.dir.name, "home")
        os.makedirs(self.home)

    def run_launcher(self, path_dirs, extra=()):
        env = {"PATH": os.pathsep.join(path_dirs), "HOME": self.home, "GOPATH": os.path.join(self.dir.name, "nogo")}
        return subprocess.run([NODE, LAUNCHER, *extra], env=env, capture_output=True, text=True, timeout=30)

    def fake_caprock(self, where):
        os.makedirs(where, exist_ok=True)
        p = os.path.join(where, "caprock")
        with open(p, "w") as f:
            f.write('#!/bin/sh\necho "ran $*"\nexit 7\n')
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    def test_runs_caprock_mcp_from_path_and_passes_its_exit_code(self):
        bindir = os.path.join(self.dir.name, "bin")
        self.fake_caprock(bindir)
        r = self.run_launcher([bindir, "/bin", "/usr/bin"], ["--x"])
        self.assertEqual(r.stdout.strip(), "ran mcp --x")
        self.assertEqual(r.returncode, 7)

    def test_finds_the_apps_copy_in_the_data_dir_when_path_has_none(self):
        config = "Library/Application Support" if sys.platform == "darwin" else ".config"
        self.fake_caprock(os.path.join(self.home, config, "caprock", "bin"))
        r = self.run_launcher(["/bin", "/usr/bin"])
        self.assertEqual(r.stdout.strip(), "ran mcp")

    def test_without_caprock_says_where_to_get_it_and_exits_1(self):
        if any(os.path.exists(p) for p in ("/opt/homebrew/bin/caprock", "/usr/local/bin/caprock",
                                           "/Applications/Caprock.app/Contents/MacOS/caprock")):
            self.skipTest("a real caprock is installed in a fixed place on this machine")
        r = self.run_launcher(["/bin", "/usr/bin"])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, "")
        self.assertIn("https://caprock.dev/install", r.stderr)


if __name__ == "__main__":
    unittest.main()
