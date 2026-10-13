import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from './mailApi'
import { partURL } from './mailApi'
import { isTauri } from '@/lib/appmode'
import { openExternal } from '@/lib/nudges'

const remoteImg = /<img[^>]+src\s*=\s*["']?\s*https?:/i
const remoteBg = /url\(\s*["']?\s*https?:/i

export function hasRemoteContent(html: string) {
  return remoteImg.test(html) || remoteBg.test(html)
}

// Builds the iframe document: the mail's HTML under a CSP that allows no
// scripts and no network except, when allowed, remote images.
export function buildDoc(m: Message, origin: string, allowRemote: boolean) {
  let html = m.body_html ?? ''
  html = html.replace(/(["'(])cid:([^"')\s]+)/gi, (_, q: string, cid: string) => q + origin + partURL(m.id, 'cid:' + cid))
  const img = allowRemote ? `data: ${origin} https: http:` : `data: ${origin}`
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:; media-src 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#1d1d1f}` +
    `body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:4px 2px;overflow-wrap:anywhere}` +
    `img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#0a66d8}` +
    `blockquote{margin:0 0 0 .5em;padding-left:.8em;border-left:3px solid #ddd;color:#555}</style></head><body>${html}</body></html>`
}

const urlRe = /(https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?])/g

function Linkified({ text, onMailto }: { text: string; onMailto?: (addr: string) => void }) {
  // Quoted lines are dimmed, links clickable; nothing is ever rendered as HTML.
  const lines = text.split('\n')
  return (
    <div className="plain">
      {lines.map((l, i) => {
        const parts = l.split(urlRe)
        return (
          <div key={i} className={l.startsWith('>') ? 'q' : undefined}>
            {parts.map((p, j) => (j % 2 === 1 ? <a key={j} href={p} target="_blank" rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); openMailLink(p, onMailto) }}>{p}</a> : p))}
            {l === '' ? ' ' : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Opens a link from a message: mailto: in Mail's own composer, the web in the
 * system browser (the app's webview would open nothing for a sandboxed frame).
 */
export function openMailLink(href: string, onMailto?: (addr: string) => void) {
  if (/^mailto:/i.test(href)) {
    if (onMailto) onMailto(decodeURIComponent(href.slice(7).split('?')[0] ?? ''))
    return
  }
  if (!/^https?:/i.test(href)) return
  if (isTauri()) openExternal(href)
  else window.open(href, '_blank', 'noopener,noreferrer')
}

export function MailBody({ m, allowRemote, onAllowRemote, onMailto }: { m: Message; allowRemote: boolean; onAllowRemote: () => void; onMailto?: (addr: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)
  const html = m.body_html ?? ''
  const blocked = !allowRemote && html !== '' && hasRemoteContent(html)
  const doc = useMemo(() => (html ? buildDoc(m, location.origin, allowRemote) : ''), [m, html, allowRemote])

  useEffect(() => {
    const f = ref.current
    if (!f) return
    let ro: ResizeObserver | undefined
    const fit = () => {
      const d = f.contentDocument
      if (!d?.documentElement) return
      setHeight(Math.max(40, d.documentElement.scrollHeight + 4))
    }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a')
      const href = a?.getAttribute('href')
      if (!href || href.startsWith('#')) return
      e.preventDefault()
      openMailLink(a!.href || href, onMailto)
    }
    const onLoad = () => {
      fit()
      f.contentDocument?.addEventListener('click', onClick)
      const body = f.contentDocument?.body
      if (body && 'ResizeObserver' in window) {
        ro = new ResizeObserver(fit)
        ro.observe(body)
      }
    }
    f.addEventListener('load', onLoad)
    return () => {
      f.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [doc, onMailto])

  if (m.body_state === 0) return <div className="muted pad">Loading…</div>
  if (!html) return <Linkified text={m.body_text || ''} onMailto={onMailto} />
  return (
    <>
      {blocked && (
        <div className="banner">
          Remote images are blocked so senders cannot see when you open this.
          <button className="link" onClick={onAllowRemote}>Load images</button>
        </div>
      )}
      <iframe
        ref={ref}
        title="message"
        className="mailframe"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
      />
    </>
  )
}
