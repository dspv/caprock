"""Tests for dmg_window.problems (no ds_store needed)."""

import json
import os
import sys
import tempfile
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
        "background": ".background.tiff",
        "iloc": {
            "Caprock.app": (c["appPosition"]["x"], c["appPosition"]["y"]),
            "Applications": (c["applicationFolderPosition"]["x"], c["applicationFolderPosition"]["y"]),
        },
    }


FILES = {
    "background": "abc",
    "expected_background": "abc",
    "volume_icon": "icn",
    "expected_volume_icon": "icn",
    "custom_icon": True,
}


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

    def test_a_missing_or_wrong_volume_icon_or_flag_fails(self):
        c = conf()
        w = good(c)
        got = dmg_window.problems(w, c, "Caprock.app", {**FILES, "volume_icon": None})
        self.assertEqual(len(got), 1, got)
        self.assertIn("generic disk", got[0])
        got = dmg_window.problems(w, c, "Caprock.app", {**FILES, "volume_icon": "other"})
        self.assertEqual(got, [".VolumeIcon.icns is not the app's .icns"])
        got = dmg_window.problems(w, c, "Caprock.app", {**FILES, "custom_icon": False})
        self.assertEqual(len(got), 1, got)
        self.assertIn("custom-icon flag", got[0])
        # No .icns in the bundle: nothing to check against.
        got = dmg_window.problems(w, c, "Caprock.app", {**FILES, "expected_volume_icon": None, "custom_icon": False})
        self.assertEqual(got, [])

    def test_the_repository_ships_a_2x_background(self):
        # dmgbuild turns background.png + background@2x.png into one
        # multi-resolution TIFF; without the @2x the window is soft on Retina.
        src_tauri = os.path.dirname(os.path.abspath(CONF_PATH))
        got = dmg_window.scaled_backgrounds(os.path.join(src_tauri, conf()["background"]))
        self.assertEqual([os.path.basename(p) for p in got], ["background.png", "background@2x.png"])

    def test_scaled_backgrounds_orders_by_scale_and_ignores_others(self):
        with tempfile.TemporaryDirectory() as d:
            for n in ("bg@3x.png", "bg.png", "bg@2x.png", "bg@2x.jpg", "other@2x.png"):
                open(os.path.join(d, n), "wb").close()
            got = dmg_window.scaled_backgrounds(os.path.join(d, "bg.png"))
            self.assertEqual([os.path.basename(p) for p in got], ["bg.png", "bg@2x.png", "bg@3x.png"])
            os.remove(os.path.join(d, "bg@2x.png"))
            got = dmg_window.scaled_backgrounds(os.path.join(d, "bg.png"))
            self.assertEqual([os.path.basename(p) for p in got], ["bg.png", "bg@3x.png"])

    def test_parse_bounds(self):
        self.assertEqual(dmg_window.parse_bounds("{{100, 100}, {660, 400}}"), (100, 100, 660, 400))
        self.assertEqual(dmg_window.parse_bounds("{{-5,10},{1,2}}"), (-5, 10, 1, 2))
        self.assertIsNone(dmg_window.parse_bounds("660x400"))
        self.assertIsNone(dmg_window.parse_bounds(None))


if __name__ == "__main__":
    unittest.main()
