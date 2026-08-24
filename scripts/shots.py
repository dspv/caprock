"""Screenshot every documented screen, cropped to its actual content.

The previous set was captured in a fixed 1600x913 window regardless of how
much the screen actually drew, so History and Tasks were two-thirds empty
background. Here the page is measured after it settles and the capture is
clipped to that height, which is why each screen gets its own aspect ratio.
"""
import base64, json, pathlib, sqlite3, subprocess, sys, time, urllib.request

DB = pathlib.Path(__file__).parent / "shotdata" / "caprock.db"
THIS_SESSION = "8e968de8-d2a4-428f-a7d9-2658b3e6937f"


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
        db.commit(); db.close()
    except Exception as e:
        print(f"  scrub skipped: {e}")

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
                rpc(ws, "Page.navigate", {"url": f"{BASE}/"})
                time.sleep(1.5)
                evaluate(ws, f"localStorage.setItem('caprock-theme','{theme}')")
                evaluate(ws, "localStorage.setItem('caprock.update.dismissed','offer')")
                rpc(ws, "Emulation.setEmulatedMedia", {
                    "features": [{"name": "prefers-color-scheme", "value": theme}]})
                rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{route}"})

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
                got = evaluate(ws, """
                  (() => {
                    const bg = getComputedStyle(document.body).backgroundColor;
                    const m = bg.match(/\\d+/g) || [255, 255, 255];
                    const lum = (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000;
                    return lum > 128 ? 'light' : 'dark';
                  })()
                """)
                if got and got != theme:
                    raise SystemExit(
                        f"theme mismatch on {route}: asked for {theme}, page rendered {got}")

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
