/**
 * A private module's page on a paired phone (ADR-076, amended 2026-10-21).
 *
 * On the machine the module is a same-origin frame on /x/<id>/ and needs
 * nothing from here. On a phone it cannot be: over the network a request needs
 * the device token, which a frame's own loads (its scripts, styles, images)
 * never carry, and through the relay (ADR-058) /x/<id>/ on the page's origin
 * is the relay page's server, not the machine. So the dashboard fetches the
 * module's files itself, with its own fetch (the token, and the relay channel
 * where there is one), and hands the page to a sandboxed frame:
 *
 * - **The page** is built here (buildModulePage): its index.html with every
 *   stylesheet and script inlined as a data: URL, ES module imports resolved
 *   through an import map, the app's theme on its <html>, and a small
 *   bootstrap script (BOOTSTRAP) put first in its <head>.
 * - **The frame** is `sandbox="allow-scripts …"` without allow-same-origin, so
 *   its origin is opaque: it cannot read the dashboard's storage (the device
 *   token) or reach into the dashboard's page.
 * - **The bridge**: the bootstrap replaces the page's fetch() and fills its
 *   <img> sources by asking the dashboard with postMessage; the dashboard
 *   forwards a request only when it is this module's own (bridgePath): a GET
 *   of a file under /x/<id>/, its store under /v1/x/<id>/docs/, or a POST
 *   of /v1/x/<id>/telegram or /v1/x/<id>/notify, or a PATCH of
 *   /v1/x/<id>/telegram/<message_id>. Anything
 *   else, other API routes included, is answered 403 without being sent.
 *
 * Why not something smaller: a frame cannot add a header to its loads, a
 * service worker cannot run in an opaque origin, a frame on the dashboard's
 * own origin could read the token, and through the relay there is no URL on
 * any origin that reaches the machine without the dashboard's fetch.
 */
import { deviceToken } from './api'
import type { ModuleTheme } from './modules'

/**
 * The scheme a module's page sees its own files under on a phone. The page's
 * <base> is `caprock-module:/x/<id>/`, so a relative URL keeps meaning the
 * module's file, and nothing under it ever reaches the network by itself.
 */
export const MODULE_SCHEME = 'caprock-module:'

/** A module's id, as internal/modules has it. */
const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/

/** At most this many files and bytes are fetched to build one page. */
export const PAGE_MAX_FILES = 500
export const PAGE_MAX_BYTES = 64 << 20

/**
 * The path a module's page may ask the bridge for, or null when it may not.
 *
 * Only the module's own: a GET (or HEAD) of a file under /x/<id>/, and its
 * document store, /v1/x/<id>/docs/<collection>[/<doc>], read or written. A
 * path that is not plainly one of those — a dot segment, an empty segment, an
 * encoded slash, dot or backslash, a fragment — is refused rather than
 * cleaned, so what is checked is what is sent.
 */
export function bridgePath(id: string, method: string, raw: string): string | null {
  if (!MODULE_ID.test(id) || typeof raw !== 'string' || typeof method !== 'string') return null
  const m = method.toUpperCase()
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\s\\#\u0000-\u001f\u007f]/.test(raw)) return null
  const q = raw.indexOf('?')
  const path = q < 0 ? raw : raw.slice(0, q)
  if (/%(2e|2f|5c)/i.test(path)) return null
  const segs = path.slice(1).split('/')
  // Only the last segment may be empty (a folder's index: /x/<id>/).
  if (segs.some((s, i) => s === '.' || s === '..' || (s === '' && i !== segs.length - 1))) return null
  const page = `/x/${id}/`
  if (path.startsWith(page)) return m === 'GET' || m === 'HEAD' ? raw : null
  const docs = `/v1/x/${id}/docs/`
  if (path.startsWith(docs) && path.length > docs.length && !path.endsWith('/')) {
    // A collection, or one document in it; never deeper.
    if (segs.length > 6) return null
    return ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(m) ? raw : null
  }
  // What the module says to the owner: a message to the paired Telegram chat
  // and a desktop notification (ADR-076, amended 2026-10-22). Exactly these.
  if (m === 'POST' && raw === `/v1/x/${id}/telegram`) return raw
  if (m === 'POST' && raw === `/v1/x/${id}/notify`) return raw
  // And an edit of a message it sent, by Telegram's numeric message id; the
  // daemon answers 404 for any message that is not the module's.
  if (m === 'PATCH' && raw.startsWith(`/v1/x/${id}/telegram/`) && /^\d{1,19}$/.test(raw.slice(`/v1/x/${id}/telegram/`.length))) return raw
  return null
}

/** A file of the module, as the page's build reads it. */
export interface PageFiles {
  text(path: string): Promise<string>
  dataURL(path: string): Promise<string>
}

/** What the bootstrap needs: the scheme, a secret it signs every request with, and the dashboard's origin. */
interface BootConfig {
  scheme: string
  secret: string
  origin: string
}

/**
 * The script that runs first in a module's page on a phone. Plain ES2017 in a
 * string, so it is exactly what runs, whatever the dashboard's build does.
 *
 * - fetch(): a URL under the page (relative, or a path) goes to the
 *   dashboard as a `caprock:bridge` message signed with the frame's secret;
 *   the answer comes back as a Response. Any other URL is the browser's.
 * - <img src>: a source under the page is fetched the same way and set as a
 *   data: URL, for the page's markup and for images it adds later.
 * - `<a href="#…">` changes the page's hash, as on the machine; a link to
 *   one of the module's files does nothing (it cannot open as a page here).
 * - The theme: `caprock:theme` messages are applied to <html> as the
 *   dashboard does on the machine, where it can reach into the frame.
 */
const BOOTSTRAP = String.raw`(function (cfg) {
  'use strict';
  var host = window.parent, seq = 0, waiting = {}, images = {};
  function own(u) {
    try { var url = new URL(String(u), document.baseURI); return url.protocol === cfg.scheme ? url.pathname + url.search : null; } catch (e) { return null; }
  }
  function call(method, path, headers, body) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      host.postMessage({ type: 'caprock:bridge', secret: cfg.secret, id: id, method: method, path: path, headers: headers, body: body }, cfg.origin);
    });
  }
  function applyTheme(t) {
    var el = document.documentElement;
    if (t.theme === 'light' || t.theme === 'dark') { el.setAttribute('data-theme', t.theme); el.style.colorScheme = t.theme; }
    var v = t.vars || {};
    for (var k in v) if (/^--(color|font)-/.test(k) && typeof v[k] === 'string') el.style.setProperty(k, v[k]);
  }
  addEventListener('message', function (e) {
    if (e.source !== host || !e.data || typeof e.data !== 'object') return;
    var d = e.data;
    if (d.type === 'caprock:bridge-reply' && d.secret === cfg.secret && waiting[d.id]) { var w = waiting[d.id]; delete waiting[d.id]; w(d); }
    else if (d.type === 'caprock:theme') applyTheme(d);
  });
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    var path = own(req ? req.url : input);
    if (path === null) return nativeFetch.apply(this, arguments);
    var method = String(init.method || (req && req.method) || 'GET').toUpperCase();
    var headers = {};
    new Headers(init.headers || (req && req.headers) || {}).forEach(function (v, k) { headers[k] = v; });
    var body = init.body != null ? new Response(init.body).arrayBuffer()
      : req && method !== 'GET' && method !== 'HEAD' ? req.arrayBuffer() : Promise.resolve(null);
    return body.then(function (b) { return call(method, path, headers, b); }).then(function (r) {
      if (r.error) throw new TypeError(r.error);
      var empty = r.status === 204 || r.status === 304 || method === 'HEAD';
      return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText || '', headers: r.headers || {} });
    });
  };
  function fixImage(img) {
    var raw = img.getAttribute('src');
    var path = raw ? own(raw) : null;
    if (path === null) return;
    if (!images[path]) images[path] = call('GET', path, {}, null).then(function (r) {
      if (r.error || r.status !== 200) throw new Error('not found');
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = rej;
        fr.readAsDataURL(new Blob([r.body], { type: (r.headers && r.headers['content-type']) || '' }));
      });
    });
    images[path].then(function (url) { if (img.getAttribute('src') === raw) img.setAttribute('src', url); }, function () { delete images[path]; });
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') fixImage(node);
    var list = node.querySelectorAll('img[src]');
    for (var i = 0; i < list.length; i++) fixImage(list[i]);
  }
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      if (m.type === 'attributes') { if (m.target.tagName === 'IMG') fixImage(m.target); }
      else for (var i = 0; i < m.addedNodes.length; i++) scan(m.addedNodes[i]);
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('DOMContentLoaded', function () { scan(document.documentElement); });
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || !e.target || !e.target.closest) return;
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') { e.preventDefault(); if (location.hash !== href) location.hash = href; }
    else if (own(href) !== null) e.preventDefault();
  });
})`

/** Text safe inside a <script> element: no "</script" and no "<!--" can appear. */
function scriptSafe(s: string): string {
  return s.replace(/</g, '\\u003c')
}

/** A JavaScript or CSS text as a data: URL. */
function textURL(type: string, text: string): string {
  return `data:${type};charset=utf-8,${encodeURIComponent(text)}`
}

/**
 * The module-own path a reference in a file at `from` names, or null for one
 * that is not the module's (another site, a bare specifier, data:).
 */
function ownPath(id: string, ref: string, from: string): string | null {
  if (!/^(\.\.?\/|\/(?!\/))/.test(ref) && !/^[\w.-][^:]*$/.test(ref)) return null
  try {
    const u = new URL(ref, MODULE_SCHEME + from)
    if (u.protocol !== MODULE_SCHEME) return null
    const p = u.pathname
    return p.startsWith(`/x/${id}/`) && bridgePath(id, 'GET', p) ? p : null
  } catch {
    return null
  }
}

/**
 * Rewrites a script's relative import specifiers (`from './a.js'`, `import
 * './a.js'`, `import('./a.js')` with a literal) to the module's own URL under
 * MODULE_SCHEME, which the page's import map turns into the file. A module
 * reached from a data: URL has no folder to resolve './a.js' against, so the
 * specifier has to be whole before it runs. Returns the files it names.
 */
export function rewriteImports(id: string, code: string, from: string): { code: string; deps: string[] } {
  const deps: string[] = []
  const out = code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])((?:\.\.?\/|\/)[^'"\n]*)\2/g, (whole, lead: string, q: string, spec: string) => {
    const p = ownPath(id, spec, from)
    if (!p) return whole
    deps.push(p)
    return `${lead}${q}${MODULE_SCHEME}${p}${q}`
  })
  return { code: out, deps }
}

/** CSS url(...) references to the module's own files, as data: URLs. */
async function inlineCSS(id: string, css: string, from: string, files: PageFiles, budget: Budget): Promise<string> {
  const refs = new Map<string, string>()
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const p = ownPath(id, m[2]!.trim(), from)
    if (p && !refs.has(p)) {
      budget.take(p)
      refs.set(p, await files.dataURL(p))
    }
  }
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _q: string, ref: string) => {
    const p = ownPath(id, ref.trim(), from)
    const d = p ? refs.get(p) : undefined
    return d ? `url("${d}")` : whole
  })
}

class Budget {
  files = 0
  bytes = 0
  take(path: string, size = 0) {
    this.files++
    this.bytes += size
    if (this.files > PAGE_MAX_FILES || this.bytes > PAGE_MAX_BYTES) throw new Error(`the module is too large to open on a phone (at ${path})`)
  }
}

/**
 * The module's page as one document for a sandboxed frame's srcdoc: its
 * index.html with stylesheets and scripts inlined, an import map for its ES
 * modules, the theme on <html>, and the bootstrap first in <head>.
 */
export async function buildModulePage(
  id: string,
  files: PageFiles,
  opts: { secret: string; origin: string; theme: ModuleTheme },
): Promise<string> {
  if (!MODULE_ID.test(id)) throw new Error('not a module id')
  const base = `/x/${id}/`
  const budget = new Budget()
  const html = await files.text(base)
  budget.take(base, html.length)
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Every ES module the page reaches, rewritten, by path.
  const modules = new Map<string, string>()
  const load = async (path: string): Promise<void> => {
    if (modules.has(path)) return
    modules.set(path, '')
    const src = await files.text(path)
    budget.take(path, src.length)
    const { code, deps } = rewriteImports(id, src, path)
    modules.set(path, textURL('text/javascript', code))
    for (const d of deps) await load(d)
  }

  for (const s of Array.from(doc.querySelectorAll('script'))) {
    const isModule = (s.getAttribute('type') ?? '').trim().toLowerCase() === 'module'
    const src = s.getAttribute('src')
    if (src === null) {
      if (!isModule) continue
      const { code, deps } = rewriteImports(id, s.textContent ?? '', base)
      s.textContent = code
      for (const d of deps) await load(d)
      continue
    }
    const p = ownPath(id, src, base)
    if (!p) continue
    if (isModule) {
      await load(p)
      s.setAttribute('src', modules.get(p)!)
    } else {
      const text = await files.text(p)
      budget.take(p, text.length)
      s.setAttribute('src', textURL('text/javascript', text))
    }
  }

  for (const l of Array.from(doc.querySelectorAll('link[href]'))) {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    const p = ownPath(id, l.getAttribute('href')!, base)
    if (!p) continue
    if (rel.includes('stylesheet')) {
      const css = await files.text(p)
      budget.take(p, css.length)
      l.setAttribute('href', textURL('text/css', await inlineCSS(id, css, p, files, budget)))
    } else {
      // An icon, a preload or a manifest: nothing the page needs to run.
      l.remove()
    }
  }
  for (const st of Array.from(doc.querySelectorAll('style'))) {
    st.textContent = await inlineCSS(id, st.textContent ?? '', base, files, budget)
  }

  // The page's own <base> would take its files off the scheme.
  doc.querySelectorAll('base').forEach((b) => b.remove())

  // The theme for the first paint, as the machine's frame gets it on load.
  const root = doc.documentElement
  root.setAttribute('data-theme', opts.theme.theme)
  root.style.colorScheme = opts.theme.theme
  for (const [k, v] of Object.entries(opts.theme.vars)) root.style.setProperty(k, v)

  const head = doc.head
  const baseEl = doc.createElement('base')
  baseEl.setAttribute('href', `${MODULE_SCHEME}${base}`)
  const map = doc.createElement('script')
  map.setAttribute('type', 'importmap')
  const imports: Record<string, string> = {}
  for (const [p, url] of modules) imports[MODULE_SCHEME + p] = url
  map.textContent = scriptSafe(JSON.stringify({ imports }))
  const boot = doc.createElement('script')
  const cfg: BootConfig = { scheme: MODULE_SCHEME, secret: opts.secret, origin: opts.origin }
  boot.textContent = `${BOOTSTRAP}(${scriptSafe(JSON.stringify(cfg))});`
  head.prepend(baseEl, map, boot)
  return `<!doctype html>\n${root.outerHTML}`
}

/** A request from a module's page, as the bootstrap sends it. */
interface BridgeRequest {
  type: 'caprock:bridge'
  secret: string
  id: number
  method: string
  path: string
  headers?: Record<string, string>
  body?: ArrayBuffer | null
}

/** The answer the bootstrap turns back into a Response. */
export interface BridgeReply {
  type: 'caprock:bridge-reply'
  secret: string
  id: number
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: ArrayBuffer | null
  error?: string
}

function isBridgeRequest(d: unknown): d is BridgeRequest {
  const r = d as BridgeRequest
  return !!r && typeof r === 'object' && r.type === 'caprock:bridge' && typeof r.secret === 'string' &&
    typeof r.id === 'number' && typeof r.method === 'string' && typeof r.path === 'string'
}

/** Only these of a page's request headers are passed on. */
const PASSED_HEADERS = ['content-type', 'accept']

/**
 * Answers one message from a module's frame: null when it is not a bridge
 * request signed with this frame's secret; 403 without sending anything when
 * the path is not the module's own (bridgePath); otherwise the daemon's
 * answer, fetched with the dashboard's fetch and the device token.
 */
export async function answerBridge(
  data: unknown,
  id: string,
  secret: string,
  doFetch: (path: string, init: RequestInit) => Promise<Response> = (p, i) => fetch(p, i),
): Promise<BridgeReply | null> {
  if (!isBridgeRequest(data) || data.secret !== secret || !secret) return null
  const reply = { type: 'caprock:bridge-reply' as const, secret, id: data.id }
  const method = data.method.toUpperCase()
  const path = bridgePath(id, method, data.path)
  if (!path) {
    const body = new TextEncoder().encode(JSON.stringify({ error: 'a module on a phone reaches only its own files and store' })).buffer as ArrayBuffer
    return { ...reply, status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' }, body }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(data.headers ?? {})) {
    if (PASSED_HEADERS.includes(k.toLowerCase()) && typeof v === 'string') headers[k.toLowerCase()] = v
  }
  const writes = method !== 'GET' && method !== 'HEAD'
  // A write must say JSON for the daemon's forgery guard (csrf.go); the store takes nothing else.
  if (writes && !headers['content-type']) headers['content-type'] = 'application/json'
  const token = deviceToken()
  if (token) headers['X-Caprock-Device'] = token
  try {
    const res = await doFetch(path, { method, headers, body: writes && data.body ? data.body : undefined })
    const out: Record<string, string> = {}
    const ct = res.headers.get('content-type')
    if (ct) out['content-type'] = ct
    const body = method === 'HEAD' || res.status === 204 || res.status === 304 ? null : await res.arrayBuffer()
    return { ...reply, status: res.status, statusText: res.statusText, headers: out, body }
  } catch (e) {
    return { ...reply, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The files of a module, read with the dashboard's fetch and the device token. */
export function moduleFiles(id: string, doFetch: (path: string, init: RequestInit) => Promise<Response> = (p, i) => fetch(p, i)): PageFiles {
  const get = async (path: string) => {
    if (!path.startsWith(`/x/${id}/`) || !bridgePath(id, 'GET', path)) throw new Error(`not the module's own file: ${path}`)
    const token = deviceToken()
    const res = await doFetch(path, { headers: token ? { 'X-Caprock-Device': token } : {} })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    return res
  }
  return {
    text: async (p) => (await get(p)).text(),
    dataURL: async (p) => {
      const blob = await (await get(p)).blob()
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
    },
  }
}

/** A fresh secret for one frame: what tells its requests from any other page's. */
export function frameSecret(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
