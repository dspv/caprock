# dmgbuild settings for Caprock's .dmg (scripts/app-dmg.sh runs it).
#
# The window's layout is read from bundle.macOS.dmg in
# app/src-tauri/tauri.conf.json, so the config stays its one home. dmgbuild
# writes the window's .DS_Store itself, without Finder: Tauri's bundler lays
# the window out with a Finder AppleScript that it skips when CI=true, which
# shipped every CI-built .dmg as a bare white folder (no .DS_Store at all).
#
# dmgbuild executes this file with `defines` set from its -D flags:
#   app   the built Caprock.app
#   conf  app/src-tauri/tauri.conf.json
# Paths in the config are relative to app/src-tauri, as Tauri reads them.
# Every top-level name here becomes a dmgbuild option, so the helpers start
# with an underscore (a plain `size` would set the image size).
import json
import os

# `defines` is injected by dmgbuild when it runs this file.
_app = defines["app"]  # noqa: F821
_conf_path = defines["conf"]  # noqa: F821
_src_tauri = os.path.dirname(os.path.abspath(_conf_path))

with open(_conf_path, encoding="utf-8") as fp:
    _conf = json.load(fp)
_bundle = _conf["bundle"]
_dmg = _bundle["macOS"]["dmg"]
_app_name = os.path.basename(_app.rstrip("/"))

# Tauri's bundler made the image the same way: compressed, HFS+.
format = "UDZO"
filesystem = "HFS+"

files = [_app]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: it sets Finder info on the bundle root, which
# `codesign --verify --strict` rejects as detritus.

# The volume's icon: the .icns the bundle lists (Tauri copied the same file).
icon = next(
    os.path.join(_src_tauri, p) for p in _bundle["icon"] if p.endswith(".icns")
)
background = os.path.join(_src_tauri, _dmg["background"])

_size = _dmg["windowSize"]
_pos = _dmg.get("windowPosition") or {"x": 100, "y": 100}
window_rect = ((_pos["x"], _pos["y"]), (_size["width"], _size["height"]))
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_pathbar = False
show_sidebar = False
show_tab_view = False
icon_size = 128
text_size = 16
include_list_view_settings = False

icon_locations = {
    _app_name: (_dmg["appPosition"]["x"], _dmg["appPosition"]["y"]),
    "Applications": (
        _dmg["applicationFolderPosition"]["x"],
        _dmg["applicationFolderPosition"]["y"],
    ),
}
