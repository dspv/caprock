/**
 * The phone's page around the dashboard (ADR-058): which machine it is
 * reading, whether that machine is reachable, and the way to add another.
 *
 * Phone first. One strip along the top — the machine's name, a dot for the
 * channel, a tap to switch — and the dashboard beneath it unchanged. With no
 * machine yet, the whole screen says how to get one: scan the QR on the
 * computer, or paste its link (a home-screen app on iOS has storage of its
 * own, and the camera opens links in Safari).
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { abandonPairing, currentChannel, currentMachine, forgetMachine, install, keepStorage, machines, notPairedHere, parsePairLink, prepare, selectMachine } from './boot'
import { PAIR_FAILED_EVENT } from '@/screens/Pair'
import { needsPairing, type Channel, type ChannelState, type Problem } from './transport'
import { promptInstall, useInstallOffer, type InstallOffer } from './install'
import { useRoute } from '@/lib/router'
import { useNarrowScreen } from '@/lib/phone'
import { provideMachineSwitch } from '@/lib/machineswitch'
import { ReadyGate } from './ReadyCard'
import { agoText, classify, offersPairing, retryLine, type Cause } from './linkcause'
import { extTitle } from '@/lib/externalLinks'

const App = lazy(() => import('../App'))

// Decided once, before anything renders: a pairing link in the address, the
// token the pairing screen left, which machine is current.
const machine = prepare()
if (machine) install(machine)
// The token is the pairing: ask the browser to keep it (boot.keepStorage).
if (machine?.token) keepStorage()

// A pairing link opened while the page is already up changes only the hash,
// which loads nothing; start over so prepare() reads it.
window.addEventListener('hashchange', () => {
  if (parsePairLink(window.location.hash)) window.location.reload()
})

// A scanned code that did not work (spent by the camera's tab, expired)
// must not cost a pairing that did: back to it, rather than a code form.
window.addEventListener(PAIR_FAILED_EVENT, () => {
  if (!abandonPairing()) return
  window.location.replace(window.location.pathname + '#/')
  window.location.reload()
})

/** How long the channel may be down before the page says why, in full. */
export const EXPLAIN_AFTER_MS = 5_000

/** How long a dropped channel may be back to connecting before the bar shows:
 *  a reconnect that takes a second is not news, and the bar would push the
 *  page down and back. */
export const BAR_GRACE_MS = 2_000

/**
 * Whether the machine bar is drawn (owner, 2026-10-14, translated: "the
 * 'DimaS-MBP' info isn't really needed either — I don't see the point of it
 * for now"). Connected with one machine it says nothing worth a row, so it
 * is not drawn. It shows while something is wrong — never connected yet,
 * down past the grace, removed — and with several machines paired, except
 * on a phone's session screen, whose title sheet lists them instead
 * (components/PhoneSessionBar).
 */
export function machineBarShown(link: Pick<Link, 'state' | 'problem' | 'everOpen' | 'downFor'>, several: boolean, inSession: boolean): boolean {
  if (link.problem === 'removed' || needsPairing(link.problem)) return true
  if (link.state !== 'open' && (!link.everOpen || link.downFor >= BAR_GRACE_MS)) return true
  return several && !inSession
}

export default function RemoteRoot() {
  const link = useChannel()
  const [pairing, setPairing] = useState(false)
  const route = useRoute()
  const narrow = useNarrowScreen()
  const several = machines().length > 1
  useEffect(() => {
    if (!several) return
    provideMachineSwitch({
      list: () => {
        const cur = currentMachine()
        return machines().map((m) => ({ id: m.id, name: m.name, current: m.id === cur?.id, paired: !!m.token }))
      },
      select: (id) => {
        selectMachine(id)
        window.location.replace(window.location.pathname + '#/')
        window.location.reload()
      },
    })
    return () => provideMachineSwitch(null)
  }, [several])
  if (!machine) return <AddMachine first />
  // On the list, but no token here and no pairing under way: say exactly
  // that, not a pairing form or a connection error (Vova, 2026-10-15).
  if (notPairedHere(machine) && !pairing) return <NotPairedHere name={machine.name} onPair={() => setPairing(true)} />
  if (pairing && notPairedHere(machine)) return <AddMachine onCancel={() => setPairing(false)} />
  const blocked = needsPairing(link.problem)
  const cause = classify(link.problem, link.online)
  const down = link.state !== 'open'
  // No internet is said at once — the browser knows; the computer and the
  // relay get EXPLAIN_AFTER_MS, since a reconnect inside it is not news.
  const notice = blocked || (down && (cause === 'offline' || link.downFor >= EXPLAIN_AFTER_MS))
  // The last screen stays, dimmed and untouchable, under the notice: what
  // this phone had is more use than a blank error page.
  const stale = notice && down && link.everOpen
  return (
    <div className="flex min-h-dvh flex-col">
      {machineBarShown(link, several, narrow && route.name === 'session') && <MachineBar link={link} />}
      {!blocked && !link.everOpen && <InstallStrip />}
      <div className="min-h-0 flex-1">
        {pairing ? (
          <AddMachine onCancel={() => setPairing(false)} />
        ) : notice ? (
          <ConnectionNotice link={link} cause={cause} stale={stale} onPair={() => setPairing(true)} />
        ) : !link.everOpen ? (
          // The dashboard decides once, at start, whether this phone is
          // paired; it asks over an open channel, never a half-made one.
          <p className="px-6 pt-10 text-center text-[15px] text-fg-muted">Reaching {currentMachine()?.name ?? 'your computer'}…</p>
        ) : null}
        {link.everOpen && !blocked && !pairing && (
          // Once after pairing, and while this phone cannot type: what is
          // done and what is left, before the dashboard (owner, 2026-10-14).
          <div data-testid="remote-dashboard" data-stale={stale ? '' : undefined} inert={stale} className={stale ? 'select-none opacity-45 grayscale transition-opacity' : undefined}>
            <ReadyGate machineId={machine.id} machineName={machine.name}>
              <InstallStrip />
              <Suspense fallback={null}>
                <App />
              </Suspense>
            </ReadyGate>
          </div>
        )}
      </div>
    </div>
  )
}

const DOT: Record<ChannelState, string> = {
  open: 'bg-ok',
  connecting: 'bg-warn animate-pulse',
  offline: 'bg-danger',
  closed: 'bg-danger',
}

export interface Link {
  state: ChannelState
  problem: Problem
  /** When the next automatic try runs, or null. */
  nextAt: number | null
  /** Whether the channel has been open since the page loaded. */
  everOpen: boolean
  /** How long the channel has not been open, in ms; 0 while open. */
  downFor: number
  /** Whether the browser says it has a network (`navigator.onLine`). */
  online: boolean
  /** Automatic tries since the channel was last open. */
  attempt: number
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/** The channel's state, re-read every second while it is down. */
function useChannel(): Link {
  const ch = currentChannel()
  const read = (since: number): Link => ({
    state: ch?.state ?? 'closed',
    problem: ch?.problem ?? '',
    nextAt: ch?.nextAt ?? null,
    everOpen: ch?.everOpen ?? false,
    downFor: ch?.state === 'open' ? 0 : Date.now() - since,
    online: browserOnline(),
    attempt: ch?.attempt ?? 0,
  })
  const [downSince, setDownSince] = useState(() => Date.now())
  const [link, setLink] = useState<Link>(() => read(downSince))
  useEffect(() => {
    if (!ch) return
    let since = ch.state === 'open' ? 0 : downSince
    const update = () => {
      if (ch.state === 'open') since = 0
      else if (!since) {
        since = Date.now()
        setDownSince(since)
      }
      setLink(read(since))
    }
    const off = ch.onState(update)
    const tick = setInterval(() => {
      if (ch.state !== 'open') update()
    }, 1000)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    update()
    return () => {
      off()
      clearInterval(tick)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one channel per page
  }, [ch])
  return link
}

/** A few words for the bar; the full story is ConnectionNotice's. */
export function barLabel(state: ChannelState, problem: Problem, online = true): string {
  if (problem === 'removed') return 'Removed: pair again'
  if (state === 'open') return ''
  if (!online) return 'No internet'
  if (state === 'connecting') return 'Connecting…'
  switch (problem) {
    case 'machine-offline':
      return 'Computer offline'
    case 'no-answer':
      return 'Computer not answering'
    case 'relay-unreachable':
      return 'Relay unreachable'
    case 'no-internet':
      return 'No internet'
    case 'wrong-machine':
      return 'Pair again'
    default:
      return 'Reconnecting…'
  }
}

/**
 * The headline and the sentence under it, for each cause (linkcause.ts). Each
 * has a different fix (Vova, 2026-10-15, translated: "the link doesn't load;
 * maybe it's some restrictions, my VPN isn't working well right now"), and
 * only a pairing the computer refused asks to pair again (owner, 2026-10-21).
 */
export function explain(cause: Cause, problem: Problem, name: string, relay: string, page = typeof window === 'undefined' ? '' : window.location.host): { title: string; body: string } {
  let host = relay
  try {
    host = new URL(relay).host
  } catch { /* the address as given */ }
  const hosts = page && page !== host ? `${host} / ${page}` : host
  switch (cause) {
    case 'offline':
      return { title: 'No internet on this phone', body: 'Reconnects by itself when the network is back.' }
    case 'relay':
      return {
        title: 'Can’t reach the relay',
        body: `This phone has a network but cannot reach ${hosts}. A VPN, or a network that blocks it, is the usual cause. Reconnects by itself.`,
      }
    case 'computer':
      return problem === 'no-answer'
        ? {
            title: 'Your computer isn’t answering',
            body: `The relay reached ${name}, but it did not reply: asleep, or Caprock on it is restarting. Reconnects by itself once it is back.`,
          }
        : {
            title: 'Your computer isn’t answering',
            body: `The relay is reachable, but ${name} is not connected to it: asleep, off the internet, or Caprock isn’t running on it. Wake it and open Caprock; this page reconnects by itself.`,
          }
    case 'unpaired':
      return problem === 'wrong-machine'
        ? {
            title: 'Pair this phone again',
            body: `${name} turned this phone away three times in a row: its keys are not the ones this phone paired with, so they were reset.`,
          }
        : {
            title: 'This phone was removed',
            body: `${name} no longer lets this phone in: it was removed on the computer, in Settings → Use on your phone.`,
          }
    default:
      return { title: `Reconnecting to ${name}`, body: 'The connection dropped. This page reconnects by itself.' }
  }
}

const TONE: Record<Cause, string> = {
  offline: 'bg-fg-faint',
  relay: 'bg-warn',
  computer: 'bg-warn',
  reconnecting: 'bg-warn',
  unpaired: 'bg-danger',
}

/**
 * What is wrong, large and full width, readable at arm's length: shown at
 * once for no internet and for a refused pairing, after EXPLAIN_AFTER_MS for
 * the rest — never a "Connecting…" with nothing after it. Every cause but a
 * refused pairing says when the next try is and keeps Retry small: the page
 * reconnects by itself. Only a refused pairing offers Pair again.
 */
function ConnectionNotice({ link, cause, stale, onPair }: { link: Link; cause: Cause; stale: boolean; onPair: () => void }) {
  const cur = currentMachine()
  const { title, body } = explain(cause, link.problem, cur?.name ?? 'Your computer', cur?.relay ?? '')
  const pairing = offersPairing(cause)
  const connecting = link.state === 'connecting'
  return (
    <section role="alert" data-testid="connection-problem" data-cause={cause} className="w-full border-b border-border bg-panel-2 px-5 pb-7 pt-7">
      <div className="mx-auto max-w-xl">
        <div className="flex items-start gap-3">
          <span aria-hidden className={`mt-[9px] h-3.5 w-3.5 shrink-0 rounded-full ${TONE[cause]} ${!pairing && connecting ? 'animate-pulse' : ''}`} />
          <h1 className="min-w-0 text-[26px] font-semibold leading-tight text-fg">{title}</h1>
        </div>
        <p className="mt-3 text-[18px] leading-snug text-fg-muted">{body}</p>
        {!pairing && (
          <p data-testid="retry-line" className="num mt-4 text-[18px] font-medium text-fg">
            {retryLine(connecting, link.nextAt, link.attempt, Date.now())}
          </p>
        )}
        {stale && (
          <p data-testid="stale-line" className="mt-2 text-[18px] leading-snug text-fg-muted">
            Below: what this phone last had, updated {agoText(link.downFor)}.
          </p>
        )}
        {pairing ? (
          <button type="button" onClick={onPair} className="mt-6 min-h-14 w-full rounded-xl bg-accent text-[18px] font-semibold text-bg">
            Pair again
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void currentChannel()?.retryNow().catch(() => { /* the notice says why */ })}
            disabled={connecting}
            className="mt-5 min-h-11 rounded-xl border border-border-strong px-5 text-[18px] text-fg disabled:opacity-50"
          >
            Retry now
          </button>
        )}
        <Details ch={currentChannel()} relay={cur?.relay ?? ''} />
      </div>
    </section>
  )
}

/** A clock time, or a dash. */
function at(t: number | null | undefined): string {
  if (!t) return '—'
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The page loaded at… — the start of everything Details reports. */
const LOADED_AT = Date.now()

/**
 * The facts behind the headline, folded: what the relay last said and when,
 * when this page last tried and was last connected. For the owner reading it
 * out, or a screenshot sent to whoever helps (Vova, 2026-10-15).
 */
export function detailRows(ch: Pick<Channel, 'lastError' | 'lastAttemptAt' | 'lastOpenAt' | 'attempt'> | null, relay: string, page: string, loadedAt: number): [string, string][] {
  const e = ch?.lastError
  return [
    ['Page', page || '—'],
    ['Relay', relay || '—'],
    ['Last error', e ? `${e.problem}: ${e.reason}${e.code ? ` (code ${e.code})` : ''}` : '—'],
    ['Error at', at(e?.at)],
    ['Last try', at(ch?.lastAttemptAt)],
    ['Last connected', ch?.lastOpenAt ? at(ch.lastOpenAt) : 'not since the page loaded'],
    ['Page loaded', at(loadedAt)],
    ['Tries since', String(ch?.attempt ?? 0)],
  ]
}

function Details({ ch, relay }: { ch: Channel | null; relay: string }) {
  const rows = detailRows(ch, relay, window.location.host, LOADED_AT)
  return (
    <details data-testid="connection-details" className="mt-5 text-[15px] text-fg-muted">
      <summary className="flex min-h-11 cursor-pointer select-none items-center text-[16px] text-fg-faint">Details</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-faint">{k}</dt>
            <dd className="mono min-w-0 break-words text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/**
 * This browser has the machine on its list and no token for it: storage
 * cleared, or a pairing that never finished. Said in so many words, with the
 * way back (Vova, 2026-10-15).
 */
function NotPairedHere({ name, onPair }: { name: string; onPair: () => void }) {
  return (
    <div role="alert" data-testid="not-paired-here" className="mx-auto max-w-md px-6 pb-10 pt-[max(2rem,env(safe-area-inset-top))]">
      <h1 className="text-[22px] font-semibold leading-tight text-fg">This browser isn’t paired</h1>
      <p className="mt-2 text-[16px] leading-snug text-fg-muted">
        It knows {name}, but holds no pairing for it: its storage was cleared, or pairing did not finish. On your computer:{' '}
        <b className="font-semibold text-fg">Caprock → Settings → Use on your phone → Connect a phone</b>, and scan it with this phone.
      </p>
      <button type="button" onClick={onPair} className="mt-6 min-h-12 w-full rounded-xl bg-accent text-[17px] font-semibold text-bg">
        Pair this browser
      </button>
    </div>
  )
}

const STRIP_KEY = 'caprock.remote.installStrip'

/**
 * One line under the bar in a phone's browser tab: install the app (Android,
 * when Chrome says it can), it is already on the home screen, or how to add
 * it (iPhone). Gone once dismissed, per offer; never in the app itself.
 */
function InstallStrip() {
  const offer = useInstallOffer()
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STRIP_KEY) ?? ''
    } catch {
      return ''
    }
  })
  if (!offer || hidden === offer) return null
  const hide = () => {
    try {
      localStorage.setItem(STRIP_KEY, offer)
    } catch { /* it comes back next time */ }
    setHidden(offer)
  }
  return (
    <div className="flex items-center gap-3 border-b border-border bg-panel-2 px-4 py-2 text-[14px] text-fg-muted" data-testid="install-strip">
      <span className="min-w-0 flex-1">{INSTALL_WORDS[offer]}</span>
      {offer === 'button' && <InstallButton small />}
      <button type="button" onClick={hide} aria-label="Hide" className="min-h-9 shrink-0 px-1 text-fg-faint">
        ×
      </button>
    </div>
  )
}

const INSTALL_WORDS: Record<Exclude<InstallOffer, null>, string> = {
  button: 'Caprock as an app: full screen, from your home screen.',
  installed: 'Caprock is on your home screen. Open it from there; it is paired too.',
  ios: 'To keep Caprock on your Home Screen: Share, then Add to Home Screen.',
}

function InstallButton({ small }: { small?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      className={small ? 'min-h-9 shrink-0 rounded-lg bg-accent px-3 text-[14px] font-semibold text-bg' : 'min-h-14 w-full rounded-xl border border-border-strong text-[17px] font-semibold text-fg'}
    >
      {small ? 'Install' : 'Install the Caprock app'}
    </button>
  )
}

function MachineBar({ link }: { link: Link }) {
  const { state } = link
  const [open, setOpen] = useState(false)
  const cur = currentMachine()
  const label = barLabel(state, link.problem, link.online)
  return (
    <div data-machine-bar className="sticky top-0 z-50 border-b border-border bg-panel pt-[env(safe-area-inset-top)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 px-4 text-left"
        aria-expanded={open}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${link.problem === 'removed' ? 'bg-danger' : DOT[state]}`} aria-hidden />
        <span className="truncate font-medium text-fg">{cur?.name ?? 'Caprock'}</span>
        {label && <span className="truncate text-sm text-fg-muted">{label}</span>}
        <span className="ml-auto text-fg-faint" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && <MachineMenu onClose={() => setOpen(false)} />}
    </div>
  )
}

function MachineMenu({ onClose }: { onClose: () => void }) {
  const ms = machines()
  const cur = currentMachine()
  const [adding, setAdding] = useState(false)
  if (adding) return <AddMachine onCancel={() => setAdding(false)} />
  return (
    <div className="border-t border-border pb-2">
      <ul>
        {ms.map((m) => (
          <li key={m.id} className="flex items-center">
            <button
              type="button"
              className={`min-h-12 flex-1 px-4 text-left ${m.id === cur?.id ? 'font-semibold text-fg' : 'text-fg-muted'}`}
              onClick={() => {
                if (m.id === cur?.id) return onClose()
                selectMachine(m.id)
                window.location.replace(window.location.pathname + '#/')
                window.location.reload()
              }}
            >
              {m.name}
              {!m.token && <span className="ml-2 text-sm text-warn">not paired</span>}
            </button>
            <button
              type="button"
              className="min-h-12 px-4 text-sm text-fg-faint"
              onClick={() => {
                forgetMachine(m.id)
                window.location.reload()
              }}
              aria-label={`Forget ${m.name} on this phone`}
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="min-h-12 w-full px-4 text-left text-accent" onClick={() => setAdding(true)}>
        + Add a machine
      </button>
    </div>
  )
}

const HOW_IT_WORKS = 'https://github.com/dspv/caprock#from-anywhere-through-an-encrypted-relay'
const RELAY_SOURCE = 'https://github.com/dspv/caprock/tree/master/relay'

/**
 * What step 1 looks like on the computer, drawn small: the Settings section
 * and its button, so the words have a picture to match.
 */
function SettingsSketch() {
  return (
    <div aria-hidden className="mt-3 overflow-hidden rounded-lg border border-border bg-bg text-[12px]">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-fg-faint">
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]" /><span className="h-2 w-2 rounded-full bg-[#febc2e]" /><span className="h-2 w-2 rounded-full bg-[#28c840]" />
        <span className="ml-2">Caprock · Settings</span>
      </div>
      <div className="flex items-center gap-3 px-3 py-3">
        <div className="grid h-12 w-12 shrink-0 grid-cols-4 gap-[2px] rounded bg-white p-1.5" >
          {Array.from({ length: 16 }, (_, i) => <span key={i} className={(i * 7) % 3 ? 'bg-black' : 'bg-white'} />)}
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-fg">Use on your phone</p>
          <span className="mt-1 inline-block rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-bg">Connect a phone</span>
        </div>
      </div>
    </div>
  )
}

/** Opened from the home screen: an iPhone gives it storage apart from Safari's. */
function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * Adding a machine: three big steps, the link box for a home-screen app, and
 * the questions a careful person asks before pointing a phone at their
 * computer, answered short, with where to read more.
 */
function AddMachine({ first, onCancel }: { first?: boolean; onCancel?: () => void }) {
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [pasting, setPasting] = useState(() => !first || standalone())
  const offer = useInstallOffer()
  function applyLink(raw: string) {
    const hash = raw.includes('#') ? raw.slice(raw.indexOf('#')) : ''
    if (!parsePairLink(hash)) {
      setError('That is not a Caprock pairing link. Tap Copy link under the code on your computer.')
      return
    }
    window.location.replace(window.location.pathname + hash)
    window.location.reload()
  }
  return (
    <div className={first ? 'mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-12 pt-[max(3rem,env(safe-area-inset-top))]' : 'px-4 py-4'}>
      {first && (
        <>
          {/* Where you are (owner, 2026-10-14, translated: "on m.caprock.dev
            * from the phone I don't understand where I am"): the name beside
            * the mark, and what this page is the other half of. */}
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="h-11 w-11" />
            <div className="leading-tight">
              <p className="text-[22px] font-semibold text-fg">Caprock</p>
              <p className="text-[14px] text-fg-muted">caprock.dev · on your phone</p>
            </div>
          </div>
          {/* Opened with nothing stored: a newcomer, or a phone whose storage
            * was cleared, or another browser (Vova, 2026-10-15). Say which
            * is which before the steps. */}
          <div role="note" data-testid="not-paired-here" className="mt-6 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[15px] leading-snug text-fg">
            <b className="font-semibold">This browser isn’t paired.</b> Paired this phone before? Its storage was cleared, or this is another
            browser{standalone() ? ' — a Home Screen app keeps storage of its own' : ''}. On your computer:{' '}
            <b className="font-semibold">Caprock → Settings → Use on your phone → Connect a phone</b>.
          </div>
          <h1 className="mt-8 text-[32px] font-semibold leading-tight text-fg">Your computer, on your phone</h1>
          <p className="mt-2 text-[17px] text-fg-muted">Every session of the Caprock app on your computer, from anywhere. No app store needed.</p>
          <div className="mt-6 rounded-xl border border-border bg-panel-2 px-4 py-3.5 text-[15px] leading-snug text-fg-muted">
            <b className="font-semibold text-fg">First, the Caprock app on your computer.</b> It is free, for Mac, Windows and Linux, and this page connects to it.
            {' '}No app yet? Get it at{' '}
            <a href="https://caprock.dev" className="text-accent underline underline-offset-4">caprock.dev</a>, on the computer.
          </div>
          {offer === 'button' && (
            <div className="mt-6">
              <InstallButton />
            </div>
          )}
          {offer === 'installed' && (
            <p className="mt-4 text-[15px] text-fg-muted">Caprock is already on your home screen. Pair here or there: they share it.</p>
          )}
        </>
      )}

      <ol className={`${first ? 'mt-8' : ''} flex flex-col gap-5`}>
        <Step n={1}>
          Open the Caprock app on your computer: <b className="font-semibold text-fg">Settings → Use on your phone</b>
          {first && <SettingsSketch />}
        </Step>
        <Step n={2}>
          Leave <b className="font-semibold text-fg">This phone can type and start agents</b> ticked, and press{' '}
          <b className="font-semibold text-fg">Connect a phone</b>
        </Step>
        <Step n={3}>
          Scan the code with this phone&apos;s camera and open the link; the phone pairs
        </Step>
        <Step n={4}>
          Optional: install the app when this page offers it
        </Step>
      </ol>

      {pasting ? (
        <form
          className="mt-8 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            applyLink(link.trim())
          }}
        >
          <label className="text-[15px] text-fg-muted" htmlFor="pair-link">
            Opened from the home screen? Tap <b className="font-semibold text-fg">Copy link</b> under the code and paste it here.
          </label>
          <input
            id="pair-link"
            value={link}
            onChange={(e) => {
              setLink(e.target.value)
              setError('')
            }}
            placeholder="Paste the link"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-14 rounded-xl border border-border-strong bg-panel-2 px-4 text-[16px] text-fg"
          />
          {error && <p className="text-[15px] text-danger">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={!link.trim()} className="min-h-14 flex-1 rounded-xl bg-accent text-[17px] font-semibold text-bg disabled:opacity-40">
              Add
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} className="min-h-14 rounded-xl px-5 text-[17px] text-fg-muted">
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setPasting(true)} className="mt-8 self-start text-[15px] text-accent underline underline-offset-4">
          Have a link instead? Paste it
        </button>
      )}

      {first && (
        <>
          <p className="mt-10 flex items-start gap-2.5 text-[15px] leading-snug text-fg-muted">
            <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-ok" aria-hidden />
            Encrypted end to end, between this phone and your computer. The relay in the middle cannot read it.
          </p>
          <div className="mt-8 flex flex-col divide-y divide-border border-y border-border">
            <Question q="Is it safe?">
              Only a phone that scanned your code gets in, and only with the role you gave it. The phone checks your
              computer&apos;s key from the code, so nobody in between can pose as it. Off until you turn it on.
            </Question>
            <Question q="What does the relay see?">
              Which computer a phone connects to, when, from which IP address, and how many bytes. Never what they are:
              no sessions, no code, no tokens. It stores nothing.
            </Question>
            <Question q="Why not an app?">
              This page is the app. Install it once and it opens full screen, like any other: on Android,{' '}
              <b className="font-semibold text-fg">Install the Caprock app</b> on this page; on an iPhone, Share →{' '}
              <b className="font-semibold text-fg">Add to Home Screen</b>. A new version of the page updates it in
              place; it never installs a second one.
            </Question>
            <Question q="Lost your phone?">
              Open the Caprock app on your computer: Settings → Use on your phone, and remove it from the list. It can no longer get in.
            </Question>
            <Question q="Can I run my own relay?">
              Yes. <span className="font-mono text-[14px]">caprock remote relay</span> is the same relay in one binary;
              point your computer at it with <span className="font-mono text-[14px]">caprock remote on --relay wss://…</span>.
            </Question>
          </div>
          <p className="mt-6 flex gap-5 text-[15px]">
            <a href={HOW_IT_WORKS} target="_blank" title={extTitle()} rel="noreferrer" className="text-accent underline underline-offset-4">
              How it works
            </a>
            <a href={RELAY_SOURCE} target="_blank" title={extTitle()} rel="noreferrer" className="text-accent underline underline-offset-4">
              The relay&apos;s source
            </a>
          </p>
        </>
      )}
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-4">
      <span className="num flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[19px] font-semibold text-fg" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-1.5 text-[19px] leading-snug text-fg-muted">{children}</div>
    </li>
  )
}

function Question({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[17px] font-medium text-fg">
        {q}
        <span className="text-fg-faint transition-transform group-open:rotate-45" aria-hidden>
          +
        </span>
      </summary>
      <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{children}</p>
    </details>
  )
}
