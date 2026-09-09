"""Record a dashboard GIF for the README, frame by frame through CDP.

The pulse GIF was captured by hand, which means it cannot be re-made when the
UI moves. This does the same job reproducibly: drive a headless Chrome against
the RECORDING STAND (never the live daemon on 4173 -- that one has real
repository names on it and a GIF cannot be replaced after it is posted), take a
frame at a fixed interval, and let ffmpeg build the palette.

Usage:
    scripts/record-stand.sh &          # serves a scrubbed copy on :4291
    python3 scripts/record-gif.py context-tax

The scene list is at the bottom. Each scene is a sequence of steps, and a step
either navigates, scrolls to something, or simply holds still for N frames --
holding is what makes a GIF readable, because a viewer needs time on each
figure and the eye cannot follow a scroll that never rests.
"""
import base64, json, os, pathlib, shutil, subprocess, sys, time, urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = int(os.environ.get("CAPROCK_GIF_CDP_PORT", "9444"))
BASE = os.environ.get("CAPROCK_GIF_BASE", "http://127.0.0.1:4291")
OUT_DIR = pathlib.Path(os.environ.get("CAPROCK_GIF_OUT", "docs"))
FPS = 10

# 1200x750 at 2x: wide enough for the four-column stat row on a session card to
# stay on one line, short enough that GitHub renders it without a scrollbar.
WIDTH, HEIGHT, SCALE = 1200, 750, 2
OUT_WIDTH = 900  # what the GIF is scaled to; the capture stays retina-sharp


def rpc(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            if "error" in m:
                raise RuntimeError(f"{method}: {m['error']}")
            return m.get("result", {})


def evaluate(ws, expr):
    r = rpc(ws, "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")


def scroll_to(ws, text, offset=-120):
    """Scroll so the element containing `text` sits near the top of the frame.

    By text rather than by selector: a class name is a refactor away from
    silently scrolling to the wrong place, and a GIF that scrolls to the wrong
    place still records perfectly.
    """
    found = evaluate(ws, f"""
      (() => {{
        const want = {json.dumps(text)};
        const el = Array.from(document.querySelectorAll('*'))
          .filter(e => e.children.length === 0 && (e.textContent||'').includes(want))
          .pop();
        if (!el) return false;
        const y = el.getBoundingClientRect().top + window.scrollY + ({offset});
        window.scrollTo({{ top: Math.max(0, y), behavior: 'smooth' }});
        return true;
      }})()
    """)
    if not found:
        raise SystemExit(f"nothing on the page contains {text!r} -- the scene is stale")


def main():
    scene_name = sys.argv[1] if len(sys.argv) > 1 else "context-tax"
    scene = SCENES.get(scene_name)
    if scene is None:
        raise SystemExit(f"unknown scene {scene_name!r}; have {', '.join(SCENES)}")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found")
    try:
        urllib.request.urlopen(f"{BASE}/v1/history?range=today", timeout=5)
    except Exception:
        raise SystemExit(f"no recording stand at {BASE} -- run scripts/record-stand.sh first")

    from websocket import create_connection

    work = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / f"caprock-gif-{scene_name}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--window-size={WIDTH},{HEIGHT}", "--disable-gpu", "--hide-scrollbars",
         "--no-first-run", "--remote-allow-origins=*",
         f"--force-device-scale-factor={SCALE}",
         f"--user-data-dir={work}/profile", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                if tabs:
                    break
            except Exception:
                time.sleep(0.25)
        else:
            raise SystemExit("chrome did not come up")

        ws = create_connection(
            next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page"), timeout=30)
        rpc(ws, "Page.enable")
        rpc(ws, "Runtime.enable")

        # Dismiss the first-run strips before the first frame, not after: they
        # are answered from localStorage at mount, and hash navigations never
        # re-read the document, so setting them later changes nothing.
        rpc(ws, "Page.navigate", {"url": f"{BASE}/#/now"})
        time.sleep(2)
        evaluate(ws, """
          try {
            localStorage.setItem('caprock.update.dismissed', 'offer');
            const t = Date.now();
            localStorage.setItem('caprock-prompts', JSON.stringify({
              'premium-banner': t, 'premium-hint': t, 'share-month': t }));
          } catch (e) {}
        """)
        rpc(ws, "Emulation.setDeviceMetricsOverride",
            {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": SCALE, "mobile": False})

        # Two things the scrubber has no reason to know about, because they are
        # not data: the branch name beside a session (a working branch is as
        # identifying as a repository name, and "feat/context-tax-meter" tells a
        # reader what was being built rather than what the product does), and
        # the "dev build" badge, which is true of the recording binary and
        # false of what a viewer installs. Hidden in the page rather than
        # cropped, so they cannot reappear at a different scroll position.
        evaluate(ws, """
          (() => {
            const kill = (pred) => Array.from(document.querySelectorAll('span,div,a'))
              .filter(e => e.children.length === 0 && pred((e.textContent||'').trim()))
              .forEach(e => { e.style.visibility = 'hidden' });
            kill(t => /^(feat|fix|docs|chore|spike|test|refactor)\//.test(t));
            // The badge is not a leaf: it wraps its own text nodes. Matched on
            // the exact string over every element, then the smallest match is
            // hidden, so a wrapper does not take half the header with it.
            const devs = Array.from(document.querySelectorAll('*'))
              .filter(e => (e.textContent||'').trim() === 'dev build');
            if (devs.length) devs[devs.length - 1].style.visibility = 'hidden';
            return true;
          })()
        """)

        n = 0
        for step in scene:
            if "goto" in step:
                rpc(ws, "Page.navigate", {"url": f"{BASE}/#/{step['goto']}"})
                time.sleep(step.get("settle", 3))
            if "scroll_to" in step:
                scroll_to(ws, step["scroll_to"], step.get("offset", -120))
            if "check" in step:
                # A scene asserts what it is about to film. A GIF of a missing
                # figure records the absence just as faithfully.
                if not evaluate(ws, f"""
                  Array.from(document.querySelectorAll('*'))
                    .some(e => e.children.length === 0 &&
                          (e.textContent||'').includes({json.dumps(step['check'])}))
                """):
                    raise SystemExit(f"expected {step['check']!r} on screen and it is not there")
            for _ in range(step.get("frames", 1)):
                img = rpc(ws, "Page.captureScreenshot", {"format": "png"})
                (work / f"f{n:04d}.png").write_bytes(base64.b64decode(img["data"]))
                n += 1
                time.sleep(1 / FPS)

        out = OUT_DIR / f"{scene_name}.gif"
        palette = work / "palette.png"
        # Two passes: a palette built from the whole clip, then the clip mapped
        # onto it. One pass per-frame gives visible colour churn on the dark
        # panels, which reads as compression artefacts on a screen recording.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
                        "-i", str(work / "f%04d.png"),
                        "-vf", f"scale={OUT_WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff",
                        str(palette)], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
                        "-i", str(work / "f%04d.png"), "-i", str(palette),
                        "-lavfi", f"scale={OUT_WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
                        "-loop", "0", str(out)], check=True)
        print(f"{out}  {n} frames  {out.stat().st_size // 1024} KB")
    finally:
        proc.terminate()
        if not os.environ.get("CAPROCK_GIF_KEEP"):
            shutil.rmtree(work, ignore_errors=True)


# Each scene holds still on the figures it is about. The hold counts are the
# whole craft here: a viewer needs roughly two seconds on a number to read it,
# and a scroll that does not come to rest cannot be read at all.
SCENES = {
    "context-tax": [
        {"goto": "now", "settle": 4, "frames": 6},
        # The session card: a real context, and what the next call costs at it.
        # Anchored on the figure itself rather than on a group heading -- the
        # stand's sessions are idle or ended depending on the snapshot, and a
        # heading that moves would silently film the wrong panel.
        {"scroll_to": "/call", "offset": -260, "frames": 4},
        {"check": "/call", "frames": 22},
        # Then the lifetime figure the per-call number adds up to.
        {"scroll_to": "Context tax", "offset": -220, "frames": 4},
        {"check": "Context tax", "frames": 30},
    ],
}

if __name__ == "__main__":
    main()
