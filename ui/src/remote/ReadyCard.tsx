/**
 * "Ready" on the phone, right after it pairs (ADR-034, amended 2026-10-14).
 *
 * The owner (translated): "I see the QR code, scan it with the phone, install
 * the app, go in — and I can't do anything, and say I've already left the
 * house. So the steps must be spelled out clearly, plus integration statuses
 * and what's left." The phone opened onto a dashboard that answered every tap
 * with "view only", and nothing said so until he tried.
 *
 * So, once after pairing and whenever the phone cannot type, a short card:
 * connected to which computer, whether this phone can type (and, when it
 * cannot, the exact place on the computer that fixes it), installing the app,
 * and **Open sessions**. Dismissed, it stays away until the answer changes.
 *
 * It also tells the computer whether this phone runs as the installed app
 * (`GET /v1/pair/me?app=`), so the checklist there can tick it.
 */
import { useEffect, useState } from 'react'
import { api, isPairedDevice, type PairMe } from '@/lib/api'
import { JUST_PAIRED_KEY } from '@/screens/Pair'
import { phoneKind, promptInstall, useInstallOffer, type InstallOffer } from './install'
/** "<machine id>:<role>" the card was last closed for. */
const DISMISSED_KEY = 'caprock.remote.readyDismissed'

function get(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function put(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch { /* shown again next time */ }
}

/** Whether to show the card: once after pairing, and while the phone cannot type, until closed for that answer. */
export function readyCardDue(o: { justPaired: boolean; role: PairMe['role'] | ''; dismissed: string; machine: string }): boolean {
  if (o.justPaired) return true
  if (!o.role || o.role === 'controller' || o.role === 'owner') return false
  return o.dismissed !== `${o.machine}:${o.role}`
}

/** What this phone reports about the installed app: true, false, or nothing known. */
export function appReport(offer: InstallOffer, standalone: boolean): boolean | undefined {
  if (standalone || offer === 'installed') return true
  if (offer === 'button') return false
  return undefined
}

function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch { /* an old browser */ }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** How often the card asks again while the phone cannot type: the owner may be fixing it now. */
const RECHECK_MS = 4000

/**
 * The card's state: null while it is not shown. `onDone` hides it for good
 * (for this answer); `children` is the dashboard, drawn when the card is not.
 */
export function ReadyGate({ machineId, machineName, children }: { machineId: string; machineName: string; children: React.ReactNode }) {
  const offer = useInstallOffer()
  const [justPaired] = useState(() => get(JUST_PAIRED_KEY) === '1')
  const [unanswered, setUnanswered] = useState(false)
  const [me, setMe] = useState<PairMe | null>(null)
  const [closed, setClosed] = useState(false)
  const report = appReport(offer, isStandalone())

  useEffect(() => {
    let live = true
    let timer = 0
    const ask = () => {
      api.pairMe(report).then(
        (m) => {
          if (!live) return
          setMe(m)
          if (m.role === 'viewer') timer = window.setTimeout(ask, RECHECK_MS)
        },
        () => {
          if (!live) return
          setUnanswered(true)
          timer = window.setTimeout(ask, RECHECK_MS)
        },
      )
    }
    ask()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [report])

  const due = !closed && readyCardDue({ justPaired, role: me?.role ?? '', dismissed: get(DISMISSED_KEY), machine: machineId })
  // Never in the way: not while this phone is redeeming a code (it holds no
  // token, and the dashboard beneath is the pairing screen), and not when the
  // machine does not answer — an older Caprock, or a moment's hiccup. The
  // card is a welcome, not a gate (2026-10-14: a spent code left the phone
  // on "Checking what this phone can do…" for good).
  if (!due || !isPairedDevice() || (!me && unanswered)) return <>{children}</>
  if (!me) {
    // Just paired, the answer on its way: a moment, not a dashboard that
    // then gives way to the card.
    return <p className="px-6 pt-10 text-center text-[15px] text-fg-muted">Checking what this phone can do…</p>
  }
  const close = () => {
    put(JUST_PAIRED_KEY, null)
    put(DISMISSED_KEY, `${machineId}:${me.role}`)
    setClosed(true)
  }
  return <ReadyCard name={machineName} me={me} offer={offer} onOpen={() => { close(); window.location.hash = '#/' }} onClose={close} />
}

/**
 * The words for keeping the page as an app when Chrome has not offered its
 * own install (or on an iPhone, which never does): Safari's Share, Chrome's
 * ⋮ menu. "Install app" in Chrome's menu, never "Add to Home screen", which
 * makes a second, plain shortcut beside an app already installed.
 */
export function homeScreenSteps(offer: InstallOffer, kind: 'ios' | 'android' | null): string {
  if (offer === 'ios' || kind === 'ios') return 'In Safari: Share → Add to Home Screen.'
  if (kind === 'android') return 'In Chrome: ⋮ → Install app. If the menu says Open in app, it is already installed.'
  return 'Install the app when the browser offers it.'
}

export function ReadyCard({ name, me, offer, onOpen, onClose, page = typeof window === 'undefined' ? '' : window.location.host, kind = typeof navigator === 'undefined' ? null : phoneKind(navigator.userAgent, navigator.maxTouchPoints ?? 0) }: { name: string; me: PairMe; offer: InstallOffer; onOpen: () => void; onClose: () => void; page?: string; kind?: 'ios' | 'android' | null }) {
  const canType = me.role === 'controller'
  const installed = offer === null ? isStandalone() || Boolean(me.installed) : offer === 'installed'
  return (
    <div data-testid="ready-card" className="mx-auto max-w-md px-6 pb-10 pt-8">
      <div className="flex items-start gap-3">
        <h1 className="flex-1 text-[26px] font-semibold leading-tight text-fg">{canType ? 'Ready' : 'Connected, view only'}</h1>
        <button type="button" onClick={onClose} aria-label="Close" className="min-h-10 px-2 text-[22px] leading-none text-fg-faint">
          ×
        </button>
      </div>
      <ul className="mt-5 flex flex-col gap-4">
        <Row ok testid="ready-connected">
          Connected to <b className="font-semibold text-fg">{name}</b>
        </Row>
        <Row ok={canType} testid="ready-type">
          {canType ? (
            <>This phone can type, start agents, approve and stop</>
          ) : (
            <>
              <b className="font-semibold text-fg">View only.</b> To type, on the computer: Caprock app → Settings → Use on your phone →{' '}
              <b className="font-semibold text-fg">Allow control</b> next to this phone. This page notices by itself.
            </>
          )}
        </Row>
        <Row ok={installed} optional={!installed} testid="ready-app">
          {installed ? (
            <>The Caprock app is on this phone</>
          ) : offer === 'button' ? (
            <div className="flex flex-col gap-3">
              <span>Optional: install the app, full screen from your home screen</span>
              <button type="button" onClick={() => void promptInstall()} className="min-h-12 rounded-xl border border-border-strong text-[17px] font-semibold text-fg">
                Install the Caprock app
              </button>
            </div>
          ) : offer === 'ios' ? (
            <>Optional: Share → <b className="font-semibold text-fg">Add to Home Screen</b></>
          ) : (
            <>Optional: {homeScreenSteps(offer, kind)}</>
          )}
        </Row>
        {/* Vova, 2026-10-15 (translated): "I opened the phone app, then
          * closed the tab … today I want to open it again but I don't
          * remember the link". The address is the way back; this phone keeps
          * its pairing. */}
        {!installed && page && (
          <Row ok={false} optional testid="ready-return">
            Next time, just open <b className="font-semibold text-fg select-all">{page}</b> on this phone: it stays paired.
          </Row>
        )}
      </ul>
      <button type="button" onClick={onOpen} className="mt-8 min-h-14 w-full rounded-xl bg-accent text-[17px] font-semibold text-bg">
        Open sessions
      </button>
    </div>
  )
}

function Row({ ok, optional, testid, children }: { ok: boolean; optional?: boolean; testid: string; children: React.ReactNode }) {
  const mark = ok ? { m: '✓', c: 'bg-ok/15 text-ok' } : optional ? { m: '○', c: 'bg-panel-2 text-fg-faint' } : { m: '✗', c: 'bg-danger/15 text-danger' }
  return (
    <li data-testid={testid} data-ok={ok ? '1' : '0'} className="flex items-start gap-3 text-[16px] leading-snug text-fg-muted">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold ${mark.c}`} aria-hidden>
        {mark.m}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}
