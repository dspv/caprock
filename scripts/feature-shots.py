"""Photograph one feature at a time, for the pages that sell them.

The premium page described each paid feature in a paragraph. Nobody reads a
paragraph to decide whether to buy something — they look. This captures the
element that IS the feature, cropped to it, so the page can show the thing
instead of describing it.

Distinct from shots.py, which photographs whole screens for the README and the
landing page. Same daemon, same anonymised database, different framing: there
the subject is a screen, here it is a single panel.

Usage:  python3 scripts/feature-shots.py http://127.0.0.1:4297 out/
"""
import base64, json, os, subprocess, sys, time, urllib.request, pathlib

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9223
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4297"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
# Narrow on purpose. At 1600px the dashboard lays panels out three to a row,
# so a single panel is a third of the width and photographs as a tall thin
# column — technically correct and useless on a marketing page. At 900px the
# same panels go full width and the crop is a wide card, which is the shape a
# feature wants to be shown in.
WIDTH, HEIGHT = 900, 1400

# name → (route, selector, why it is the feature)
#
# Selectors are matched by visible text rather than by class, because a class
# is a styling decision that will change and a panel title is a product one
# that will not.
SHOTS = [
    ("feat-limits", "cost", "Plan limits",
     "the windows, with the reset clock — what 'know before it stops you' looks like"),
    ("feat-cap", "cost", "Daily spend cap",
     "the locked panel, in its real place on the screen"),
    ("feat-breakdown", "now", "MOST-USED TOOLS",
     "where the money went, by tool and by model"),
    ("feat-projects", "now", "PROJECTS",
     "cost per repository, the question an invoice cannot answer"),
]


def rpc(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise SystemExit(f"{method}: {msg['error']}")
            return msg.get("result", {})


def evaluate(ws, expr):
    r = rpc(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")


def main():
    try:
        import websocket
    except ImportError:
        raise SystemExit("need websocket-client: pip install websocket-client")

    OUT.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--window-size={WIDTH},{HEIGHT}", "--hide-scrollbars",
         "--force-device-scale-factor=2", "--no-first-run", "--remote-allow-origins=*", "--user-data-dir=/tmp/fshot-profile",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            time.sleep(0.25)
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                if tabs:
                    break
            except Exception:
                continue
        else:
            raise SystemExit("chrome did not start")

        ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=30)
        rpc(ws, "Page.enable")
        rpc(ws, "Runtime.enable")

        for theme in ("dark", "light"):
            for name, route, needle, _why in SHOTS:
                rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{route}"})
                time.sleep(3.5)
                evaluate(ws, f"localStorage.setItem('caprock-theme','{theme}');location.reload()")
                time.sleep(3.5)

                # Find the panel whose heading matches, and take its box. The
                # walk goes up to the panel container so the border and title
                # come with it — a cropped body floating without its frame
                # looks like a mistake rather than a component.
                box = evaluate(ws, f"""
                  (() => {{
                    const want = {json.dumps(needle)}.toLowerCase();
                    const all = [...document.querySelectorAll('div,section')];
                    const hit = all.find(el => {{
                      const t = (el.textContent || '').trim().toLowerCase();
                      return t.startsWith(want) && el.getBoundingClientRect().height > 110
                             && el.getBoundingClientRect().height < 900;
                    }});
                    if (!hit) return null;
                    const r = hit.getBoundingClientRect();
                    return {{x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height}};
                  }})()
                """)
                if not box:
                    print(f"  !! {name}: no element matching {needle!r} on /{route}")
                    continue

                pad = 12
                shot = rpc(ws, "Page.captureScreenshot", {
                    "format": "png",
                    "captureBeyondViewport": True,
                    "clip": {
                        "x": max(0, box["x"] - pad),
                        "y": max(0, box["y"] - pad),
                        "width": min(WIDTH, box["w"] + pad * 2),
                        "height": box["h"] + pad * 2,
                        "scale": 2,
                    },
                })
                suffix = "" if theme == "dark" else "-light"
                path = OUT / f"{name}{suffix}.png"
                path.write_bytes(base64.b64decode(shot["data"]))
                print(f"  {path.name:26} {int(box['w'])}x{int(box['h'])}  {path.stat().st_size:>7} bytes")
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
