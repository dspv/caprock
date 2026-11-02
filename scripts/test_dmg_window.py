"""Tests for dmg_window.problems (no ds_store needed)."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dmg_window  # noqa: E402

CONF_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "src-tauri", "tauri.conf.json")


def conf():
    with open(CONF_PATH, encoding="utf-8") as fp:
        return json.load(fp)["bundle"]["macOS"]["dmg"]


def good(c):
    """The window dmgbuild writes for the config, as read_window returns it."""
    return {
        "bwsp": {
            "WindowBounds": f"{{{{100, 100}}, {{{c['windowSize']['width']}, {c['windowSize']['height']}}}}}",
            "ShowToolbar": False,
            "ShowStatusBar": False,
        },
        "icvp": {"backgroundType": 2, "iconSize": 128.0},
        "background": ".background.png",
        "iloc": {
            "Caprock.app": (c["appPosition"]["x"], c["appPosition"]["y"]),
            "Applications": (c["applicationFolderPosition"]["x"], c["applicationFolderPosition"]["y"]),
        },
    }


FILES = {"background": "abc", "expected_background": "abc"}


class Problems(unittest.TestCase):
    def test_the_configured_window_passes(self):
        c = conf()
        self.assertEqual(dmg_window.problems(good(c), c, "Caprock.app", FILES), [])

    def test_an_empty_store_fails_on_every_part(self):
        c = conf()
        got = dmg_window.problems({}, c, "Caprock.app", {"background": None})
        self.assertTrue(any("bwsp" in p for p in got), got)
        self.assertTrue(any("icvp" in p for p in got), got)
        self.assertTrue(any("background alias" in p for p in got), got)
        self.assertTrue(any("no position for Caprock.app" in p for p in got), got)
        self.assertTrue(any("no position for Applications" in p for p in got), got)

    def test_a_wrong_size_toolbar_and_position_are_named(self):
        c = conf()
        w = good(c)
        w["bwsp"]["WindowBounds"] = "{{100, 100}, {640, 280}}"
        w["bwsp"]["ShowToolbar"] = True
        w["iloc"]["Applications"] = (1, 2)
        got = dmg_window.problems(w, c, "Caprock.app", FILES)
        self.assertEqual(len(got), 3, got)
        self.assertIn("640x280", got[0])
        self.assertIn("ShowToolbar", got[1])
        self.assertIn("Applications is at (1, 2)", got[2])

    def test_a_different_or_missing_picture_fails(self):
        c = conf()
        w = good(c)
        self.assertIn("is not", dmg_window.problems(w, c, "Caprock.app", {"background": "x", "expected_background": "y"})[0])
        self.assertIn("not on the volume", dmg_window.problems(w, c, "Caprock.app", {"background": None})[0])
        w["icvp"]["backgroundType"] = 1
        self.assertIn("not a picture", dmg_window.problems(w, c, "Caprock.app", FILES)[0])

    def test_parse_bounds(self):
        self.assertEqual(dmg_window.parse_bounds("{{100, 100}, {660, 400}}"), (100, 100, 660, 400))
        self.assertEqual(dmg_window.parse_bounds("{{-5,10},{1,2}}"), (-5, 10, 1, 2))
        self.assertIsNone(dmg_window.parse_bounds("660x400"))
        self.assertIsNone(dmg_window.parse_bounds(None))


if __name__ == "__main__":
    unittest.main()
