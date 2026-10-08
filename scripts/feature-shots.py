"""Photograph one feature at a time, for the pages that sell them.

The premium page described each paid feature in a paragraph. Nobody reads a
paragraph to decide whether to buy something — they look. This captures the
element that IS the feature, cropped to it, so the page can show the thing
instead of describing it.

Distinct from shots.py, which photographs whole screens for the README and the
landing page. Same daemon, same anonymised database, different framing: there
the subject is a screen, here it is a single panel or a dialog.

No session page: its timeline prints raw tool output — paths with the
username in them, file contents — which no scrub of named fields reaches.

Usage:  python3 scripts/feature-shots.py http://127.0.0.1:4290 out/ [name ...]

Naming names shoots only those. Run it against the daemon refresh-shots.sh
starts — a scrubbed copy — never against the one you are using.
"""
import base64, json, shutil, subprocess, sys, time, urllib.request, pathlib

def _find_chrome():
    """$CAPROCK_SHOT_CHROME, else Playwright's headless shell, else the
    installed Chrome — whose updater, started from a Caprock session, makes
    macOS warn that "caprock was prevented from modifying apps" (see
    scripts/shots.py)."""
    import os, pathlib
    if os.environ.get("CAPROCK_SHOT_CHROME"):
        return os.environ["CAPROCK_SHOT_CHROME"]
    cache = pathlib.Path.home() / "Library/Caches/ms-playwright"
    for shell in sorted(cache.glob("chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"), reverse=True):
        return str(shell)
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CHROME = _find_chrome()
PORT = 9223
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4290"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
ONLY = set(sys.argv[3:])
# Narrow on purpose. At 1600px the dashboard lays panels out three to a row,
# so a single panel is a third of the width and photographs as a tall thin
# column — technically correct and useless on a marketing page. At 900px the
# same panels go full width and the crop is a wide card, which is the shape a
# feature wants to be shown in. A shot that needs the wide layout (the donut
# row, the week card) says so with its own width.
WIDTH, HEIGHT = 900, 1400

# Pairing is shown with an example address and code. Pressing the real
# "Show a code" turns on a listener on the local network and draws a QR code
# of this machine's address with a code that lets a device in — neither is a
# thing to publish, and the listener is not a thing to open for a photograph.
# The state the panel reads is answered here instead, before the app loads:
# a documentation address from the private range and a code that was never
# issued. The site captions it as an example.
PAIR_STUB = r"""
(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/v1/pair/state')) {
      return new Response(JSON.stringify({
        enabled: true, url: 'http://192.168.1.20:22776', code: '482913',
        expires_in_sec: 287, tunnelled: false, devices: [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return real(input, init);
  };
})();
"""

# What to click before the capture. Each returns true when it found its target.
CLICK = """
((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find(
    (x) => !text || (x.textContent || '').trim().startsWith(text));
  if (!el) return false;
  el.scrollIntoView({block: 'center'});
  el.click();
  return true;
})(%s, %s)
"""


def click(sel, text=""):
    return CLICK % (json.dumps(sel), json.dumps(text))


# The first row of the Live pulse, opened: who is working, on what.
OPEN_PULSE_ROW = """
(() => {
  const b = document.querySelector('button[aria-expanded][aria-label*="what is running"]');
  if (!b) return false;
  if (b.getAttribute('aria-expanded') !== 'true') b.click();
  return true;
})()
"""

# At a glance is collapsible and remembers it; make sure it is open.
OPEN_GLANCE = """
(() => {
  const b = [...document.querySelectorAll('button[aria-expanded]')].find(
    (x) => x.textContent.trim().endsWith('At a glance'));
  if (!b) return false;
  if (b.getAttribute('aria-expanded') !== 'true') b.click();
  return true;
})()
"""

# Lifetime's tool table: open the most-used tool's row into its drill-down.
OPEN_TOOL = """
(() => {
  const rows = [...document.querySelectorAll('li > button[aria-expanded]')];
  const r = rows[0];
  if (!r) return false;
  if (r.getAttribute('aria-expanded') !== 'true') r.click();
  return true;
})()
"""

# name → what to photograph. Keys:
#   route   the hash route
#   needle  visible panel heading to crop to (matched by text, not by class:
#           a class is a styling decision that will change, a panel title is a
#           product one that will not)
#   dialog  crop to the open [role=dialog] (or the element matching this CSS)
#   page    crop the top `page` pixels of the whole page instead
#   smallest crop to the smallest element under the needle, not the first
#   width   viewport width for this shot
#   steps   JS run in order after the page settles, each must return true
#   wait    text that must be on the page before the capture
#   stub    JS injected before the app loads
#   why     what the picture is for
SHOTS = [
    dict(name="feat-limits", route="cost", needle="Plan limits",
         why="the windows in plain words, with the reset clock"),
    dict(name="feat-cap", route="cost", needle="Daily spend cap",
         why="the locked panel, in its real place on the screen"),
    dict(name="feat-breakdown", route="now", needle="Most-used tools",
         why="where the money went, by tool and by model"),
    dict(name="feat-projects", route="now", needle="Projects",
         why="cost per repository, with Terminal and Open repo on the row"),
    dict(name="feat-glance", route="now", needle="At a glance", width=1400,
         steps=[OPEN_GLANCE], wait="re-reading context",
         why="donuts for money, token type and tools; agents with their share of spend"),
    dict(name="feat-pulse", route="now", needle="Live pulse", width=1200,
         steps=[OPEN_PULSE_ROW],
         why="one bar per minute per session, a row opened into what it is doing"),
    dict(name="feat-week", route="week", needle="Your agents, one week", width=1400,
         steps=[click('[aria-label="Card size"] button', "Landscape")],
         why="the shareable week card, landscape"),
    dict(name="feat-week-portrait", route="week", needle="Your agents, one week", width=1400,
         steps=[click('[aria-label="Card size"] button', "Portrait")],
         why="the same card, portrait, for a story"),
    dict(name="feat-share", route="now", dialog='[role="dialog"][aria-label="Share your figures"]',
         width=1400, steps=[click('button[title="Draw a shareable picture of your figures"]')],
         wait="Figures",
         why="the share sheet: Figures or Story, any period"),
    dict(name="feat-tools", route="history", needle="Tool usage", smallest=True,
         steps=[OPEN_TOOL], wait="calls · by",
         why="one tool opened: what it was called on, what it returned, where it failed"),
    dict(name="feat-spawn", route="now", dialog="NEW SESSION", width=1400,
         steps=[click("button", "+ New session")],
         why="start Claude Code, Codex, OpenCode or Gemini from the dashboard"),
    dict(name="feat-pairing", route="settings", needle="Open Caprock on your phone", stub=PAIR_STUB,
         wait="Point your phone",
         why="pairing a phone by QR code — example address and code"),
    dict(name="feat-premium", route="now", dialog='[role="dialog"]', width=1400,
         steps=[click('button[title="What Premium includes"]')],
         why="what Premium gives you"),
    dict(name="feat-teams", route="now", dialog='[role="dialog"]', width=1400,
         steps=[click("button", "Want this for your team?")],
         why="what the team version gives you"),
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


BANNERS = """
  try {
    localStorage.setItem('caprock.update.dismissed', 'offer');
    const t = Date.now();
    localStorage.setItem('caprock-prompts', JSON.stringify({
      'premium-banner': t, 'premium-hint': t, 'share-month': t,
    }));
  } catch (e) {}
"""

# A panel is the smallest element whose text starts with the heading and that
# is big enough to be a panel rather than the heading itself.
FIND_PANEL = """
  ((want, smallest) => {
    want = want.toLowerCase();
    const all = [...document.querySelectorAll('div,section')];
    const hits = all.filter(el => {
      // Leading glyphs are not part of the heading: At a glance opens with
      // its disclosure chevron, "›At a glance".
      const t = (el.textContent || '').trim().toLowerCase().replace(/^[^a-z0-9]+/, '');
      const r = el.getBoundingClientRect();
      return t.startsWith(want) && r.height > 110 && r.height < 1300;
    });
    // `smallest` for a panel whose first match is the grid holding it and
    // its neighbours (Tool usage came out beside Model mix and Weekly
    // report). Not the default: for most panels the smallest match is a
    // piece of the panel without its frame.
    if (smallest) hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const hit = hits[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return {x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height};
  })(%s, %s)
"""

FIND_DIALOG = """
  ((sel) => {
    let el = null;
    if (/^[A-Z ]+$/.test(sel)) {
      // A dialog with no role: find it by its heading, then its frame.
      const h = [...document.querySelectorAll('h2')].find(
        (x) => x.textContent.trim().toUpperCase() === sel);
      el = h && h.closest('[class*="rounded"]');
    } else {
      el = document.querySelector(sel);
    }
    if (!el) return null;
    // The dialog's frame, not the dimmed backdrop around it.
    const inner = el.firstElementChild && el.getBoundingClientRect().width >= window.innerWidth - 4
      ? el.firstElementChild : el;
    const r = inner.getBoundingClientRect();
    return {x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height};
  })(%s)
"""


def dismiss_interrupted():
    """The copy's daemon reads the owner's last stop as its own; put that banner away."""
    global BANNERS
    try:
        info = json.load(urllib.request.urlopen(f"{BASE}/v1/status")).get("interrupted") or {}
    except Exception:
        return
    if info.get("stopped_at"):
        BANNERS += ("try { localStorage.setItem('caprock.interrupted.dismissed', '%d') } catch (e) {}"
                    % int(info["stopped_at"]))


def shoot(ws, spec, theme):
    width = spec.get("width", WIDTH)
    rpc(ws, "Emulation.setDeviceMetricsOverride",
        {"width": width, "height": HEIGHT, "deviceScaleFactor": 2, "mobile": False})
    route = spec["route"]
    stub_id = None
    if spec.get("stub"):
        stub_id = rpc(ws, "Page.addScriptToEvaluateOnNewDocument",
                      {"source": spec["stub"]})["identifier"]
    try:
        rpc(ws, "Page.navigate", {"url": "about:blank"})
        time.sleep(0.3)
        rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{route}"})
        time.sleep(0.8)
        evaluate(ws, BANNERS)
        evaluate(ws, "localStorage.setItem('caprock-theme','%s');"
                     "localStorage.setItem('caprock-glance-open','1');"
                     "localStorage.setItem('caprock-glance-view','charts');"
                     "location.reload()" % theme)
        # Wait for real content: no skeletons, no "reading", the needle there.
        needle = spec.get("needle") or ""
        for _ in range(240):
            time.sleep(0.5)
            ok = evaluate(ws, """
              ((n) => {
                const t = document.body.innerText;
                if (document.querySelector('.skeleton-pulse')) return false;
                if (t.includes('reading your figures') || t.includes('reading…')) return false;
                return !n || t.toLowerCase().includes(n.toLowerCase());
              })(%s)
            """ % json.dumps(needle))
            if ok:
                break
        else:
            print(f"  !! {spec['name']} ({theme}): page never settled on /{route}")
            return
        time.sleep(1.5)
        for step in spec.get("steps", []):
            if not evaluate(ws, step):
                print(f"  !! {spec['name']} ({theme}): a step found nothing to act on")
                return
            time.sleep(1.2)
        if spec.get("wait"):
            for _ in range(120):
                time.sleep(0.5)
                if evaluate(ws, f"document.body.innerText.includes({json.dumps(spec['wait'])})"):
                    break
            else:
                print(f"  !! {spec['name']} ({theme}): {spec['wait']!r} never appeared")
                return
        time.sleep(2.5)   # let the bars, donuts and canvases paint
        if evaluate(ws, "document.documentElement.getAttribute('data-theme')") != theme:
            raise SystemExit(f"{spec['name']}: asked for {theme}, page rendered another theme")

        pad, pad_top = 12, 2
        if spec.get("page"):
            evaluate(ws, "window.scrollTo(0,0)")
            clip = {"x": 0, "y": 0, "width": width, "height": spec["page"], "scale": 1}
        else:
            evaluate(ws, "window.scrollTo(0,0)")
            time.sleep(0.3)
            if spec.get("dialog"):
                box = evaluate(ws, FIND_DIALOG % json.dumps(spec["dialog"]))
                pad = pad_top = 0
            else:
                box = evaluate(ws, FIND_PANEL % (json.dumps(needle),
                                                 json.dumps(bool(spec.get("smallest")))))
            if not box:
                print(f"  !! {spec['name']}: nothing matching {spec.get('dialog') or needle!r} on /{route}")
                return
            # Asymmetric padding: 12px is right on three sides, but at the
            # top it reached into the panel above and clipped a button in
            # half, which reads as a broken screenshot rather than a crop.
            clip = {"x": max(0, box["x"] - pad), "y": max(0, box["y"] - pad_top),
                    "width": min(width, box["w"] + pad * 2),
                    "height": box["h"] + pad + pad_top, "scale": 1}
        shot = rpc(ws, "Page.captureScreenshot",
                   {"format": "png", "captureBeyondViewport": True, "clip": clip})
        suffix = "" if theme == "dark" else "-light"
        path = OUT / f"{spec['name']}{suffix}.png"
        path.write_bytes(base64.b64decode(shot["data"]))
        print(f"  {path.name:30} {int(clip['width'])}x{int(clip['height'])}  {path.stat().st_size:>8} bytes")
    finally:
        if stub_id:
            rpc(ws, "Page.removeScriptToEvaluateOnNewDocument", {"identifier": stub_id})


def main():
    try:
        import websocket
    except ImportError:
        raise SystemExit("need websocket-client: pip install websocket-client")

    OUT.mkdir(parents=True, exist_ok=True)
    dismiss_interrupted()
    # A fresh profile every run, as in shots.py: a kept one replays the last
    # run's localStorage — the dashboard's cached figures among it.
    shutil.rmtree("/tmp/fshot-profile", ignore_errors=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--window-size={WIDTH},{HEIGHT}", "--hide-scrollbars",
         "--force-device-scale-factor=2", "--no-first-run", "--remote-allow-origins=*",
         "--user-data-dir=/tmp/fshot-profile", "about:blank"],
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

        ws = websocket.create_connection(
            next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page"), timeout=60)
        rpc(ws, "Page.enable")
        rpc(ws, "Runtime.enable")
        for theme in ("dark", "light"):
            for spec in SHOTS:
                if ONLY and spec["name"] not in ONLY:
                    continue
                shoot(ws, spec, theme)
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
