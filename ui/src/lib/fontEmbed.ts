/**
 * The page's own font faces as CSS with the files inlined, for html-to-image
 * (`fontEmbedCSS`), read without asking the daemon again.
 *
 * Left to itself, html-to-image embeds every @font-face of the families a
 * node uses — eight files for the two bundled faces, Greek, Cyrillic and
 * Vietnamese included — and fetches each one from the daemon at the moment
 * of drawing. On the preview stand (a copy of the owner's database,
 * 2026-10-31) the share sheet's press put those eight fetches behind the
 * month's count and the dashboard's polls, all on the same loopback host:
 * the fonts came back 17 s later and the press sat on "Drawing…" for all of
 * it. So only the faces this page actually loaded are embedded (the
 * resource timings name them; the screen needed nothing else to show what
 * is drawn), read from the browser's cache (`force-cache`: the bundled
 * files are served immutable), once per page. When nothing can be matched —
 * no timings, a face loaded from elsewhere — the answer is undefined and
 * html-to-image does what it did before.
 */

let pending: Promise<string | undefined> | undefined

/** The loaded faces' CSS with their files inlined; computed once, retried after a failure. */
export function pageFontCSS(): Promise<string | undefined> {
  if (!pending) {
    pending = build().catch(() => undefined)
    void pending.then((v) => { if (v === undefined) pending = undefined })
  }
  return pending
}

/** For tests: forget the computed CSS. */
export function resetPageFontCSS() { pending = undefined }

const URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/g

async function build(): Promise<string | undefined> {
  if (typeof performance?.getEntriesByType !== 'function' || typeof document === 'undefined') return undefined
  const fetched = new Set(performance.getEntriesByType('resource').map((e) => e.name))
  const faces: { css: string; base: string; urls: string[] }[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue /* another origin's sheet */ }
    const base = sheet.href ?? location.href
    for (const rule of Array.from(rules)) {
      if (typeof CSSFontFaceRule === 'undefined' || !(rule instanceof CSSFontFaceRule)) continue
      const css = rule.cssText
      const urls = [...css.matchAll(URL_RE)].map((m) => {
        try { return new URL(m[1]!, base).href } catch { return '' }
      })
      // A face the page never loaded is a face nothing on screen uses.
      const loaded = urls.filter((u) => fetched.has(u))
      if (loaded.length === 0) continue
      faces.push({ css, base, urls: loaded })
    }
  }
  if (faces.length === 0) return undefined
  const inlined = new Map<string, string>()
  await Promise.all([...new Set(faces.flatMap((f) => f.urls))].map(async (u) => { inlined.set(u, await dataURL(u)) }))
  return faces.map(({ css, base }) => css.replace(URL_RE, (whole, raw: string) => {
    try {
      const d = inlined.get(new URL(raw, base).href)
      return d ? `url(${d})` : whole
    } catch { return whole }
  })).join('\n')
}

async function dataURL(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error)
    r.onloadend = () => resolve(String(r.result))
    r.readAsDataURL(blob)
  })
}
