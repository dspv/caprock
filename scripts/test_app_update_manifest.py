"""Tests for scripts/app-update-manifest.py (run: make test-scripts)."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "app-update-manifest.py")
spec = importlib.util.spec_from_file_location("manifest", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

DATE = "2026-10-06T12:00:00Z"


class Manifest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def sig(self, name, body="dW50cnVzdGVkIGNvbW1lbnQ6IHNpZw==\n"):
        with open(os.path.join(self.dir.name, name + ".sig"), "w") as f:
            f.write(body)

    def test_every_platform_points_at_its_versioned_bundle(self):
        self.sig("Caprock_0.79.0_universal.app.tar.gz", "mac-sig\n")
        self.sig("Caprock_0.79.0_x64-setup.exe", "win-sig")
        self.sig("Caprock_0.79.0_amd64.AppImage", "linux-sig")
        m = mod.manifest("v0.79.0", self.dir.name, "dspv/caprock", DATE)
        self.assertEqual(m["version"], "0.79.0")
        self.assertEqual(m["pub_date"], DATE)
        self.assertEqual(
            sorted(m["platforms"]),
            ["darwin-aarch64", "darwin-x86_64", "linux-x86_64-appimage", "windows-x86_64"],
        )
        mac = m["platforms"]["darwin-aarch64"]
        self.assertEqual(mac, m["platforms"]["darwin-x86_64"], "one universal bundle for both")
        self.assertEqual(mac["signature"], "mac-sig", "the .sig contents, trimmed")
        self.assertEqual(
            mac["url"],
            "https://github.com/dspv/caprock/releases/download/v0.79.0/Caprock_0.79.0_universal.app.tar.gz",
        )
        self.assertTrue(m["platforms"]["windows-x86_64"]["url"].endswith("/v0.79.0/Caprock_0.79.0_x64-setup.exe"))

    def test_deb_and_rpm_never_match(self):
        self.sig("Caprock_0.79.0_amd64.AppImage")
        m = mod.manifest("v0.79.0", self.dir.name, "dspv/caprock", DATE)
        self.assertNotIn("linux-x86_64", m["platforms"])

    def test_a_missing_platform_is_left_out(self):
        self.sig("Caprock_0.79.0_universal.app.tar.gz")
        m = mod.manifest("v0.79.0", self.dir.name, "dspv/caprock", DATE)
        self.assertEqual(sorted(m["platforms"]), ["darwin-aarch64", "darwin-x86_64"])

    def test_another_versions_signature_is_ignored(self):
        self.sig("Caprock_0.78.1_universal.app.tar.gz")
        self.assertIsNone(mod.manifest("v0.79.0", self.dir.name, "dspv/caprock", DATE))

    def test_bad_input_is_refused(self):
        with self.assertRaises(ValueError):
            mod.manifest("0.79.0", self.dir.name, "dspv/caprock", DATE)
        self.sig("Caprock_0.79.0_x64-setup.exe", "  \n")
        with self.assertRaises(ValueError):
            mod.manifest("v0.79.0", self.dir.name, "dspv/caprock", DATE)

    def test_cli_writes_json_and_says_when_nothing_was_signed(self):
        run = lambda *a: subprocess.run([sys.executable, SCRIPT, *a], capture_output=True, text=True)
        r = run("v0.79.0", self.dir.name)
        self.assertEqual(r.returncode, mod.NO_SIGNATURES, r.stderr)
        self.assertEqual(r.stdout, "")
        self.sig("Caprock_0.79.0_x64-setup.exe", "win")
        out = os.path.join(self.dir.name, "latest.json")
        r = run("v0.79.0", self.dir.name, "--date", DATE, "--out", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(out) as f:
            m = json.load(f)
        self.assertEqual(m["platforms"]["windows-x86_64"]["signature"], "win")
        self.assertEqual(m["notes"], "https://github.com/dspv/caprock/releases/tag/v0.79.0")


if __name__ == "__main__":
    unittest.main()
