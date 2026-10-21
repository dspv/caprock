/**
 * Bare web addresses in an agent's reply, found so they can be tapped.
 *
 * Agents write a link as a bare `https://…` far more often than as
 * `[text](url)`, and a bare one stayed plain text: on a phone it could be
 * neither tapped nor, in practice, selected and copied (owner, 2026-10-21,
 * translated: "I can't open the links from my phone").
 *
 * Only http and https: a `javascript:`, `file:` or `data:` address stays
 * text whatever it says. The address ends where prose punctuation begins —
 * a sentence's full stop, a comma, a closing quote or guillemet, a colon —
 * and a closing bracket ends it unless the address opened one itself
 * (`https://en.wikipedia.org/wiki/Go_(game)`), while a `#fragment` and a
 * query string stay part of it.
 */

/** One run of text: a link when `href` is set. */
export interface LinkPiece { text: string; href?: string }

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi
const TRAILING = /[.,;:!?'"»«’”“…*_~]$/
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** The href an address may open: http(s) with a host, or null. */
export function safeHref(raw: string): string | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  return u.href
}

const count = (s: string, ch: string) => s.split(ch).length - 1

/** Trims what a sentence put after an address, not what belongs to it. */
export function trimUrl(url: string): string {
  let u = url
  for (;;) {
    if (TRAILING.test(u)) { u = u.slice(0, -1); continue }
    const last = u.slice(-1)
    const open = CLOSE[last]
    if (open && count(u, last) > count(u, open)) { u = u.slice(0, -1); continue }
    return u
  }
}

/** `text` split into plain runs and http(s) links. */
export function splitLinks(text: string): LinkPiece[] {
  if (!/https?:\/\//i.test(text)) return [{ text }]
  const out: LinkPiece[] = []
  const re = new RegExp(URL_RE.source, 'gi')
  let at = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const url = trimUrl(m[0])
    const href = safeHref(url)
    if (!href) continue
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ text: url, href })
    at = m.index + url.length
    re.lastIndex = at
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out.length ? out : [{ text }]
}
