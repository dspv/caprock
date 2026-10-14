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
import { currentChannel, currentMachine, forgetMachine, install, machines, parsePairLink, prepare, selectMachine } from './boot'
import { needsPairing, type ChannelState, type Problem } from './transport'
import { promptInstall, useInstallOffer, type InstallOffer } from './install'

const App = lazy(() => import('../App'))

// Decided once, before anything renders: a pairing link in the address, the
// token the pairing screen left, which machine is current.
const machine = prepare()
if (machine) install(machine)

// A pairing link opened while the page is already up changes only the hash,
// which loads nothing; start over so prepare() reads it.
window.addEventListener('hashchange', () => {
  if (parsePairLink(window.location.hash)) window.location.reload()
})

/** How long the channel may be down before the page says why, in full. */
export const EXPLAIN_AFTER_MS = 5_000

export default function RemoteRoot() {
  const link = useChannel()
  const [pairing, setPairing] = useState(false)
  if (!machine) return <AddMachine first />
  const blocked = needsPairing(link.problem)
  return (
    <div className="flex min-h-dvh flex-col">
      <MachineBar link={link} />
      {!blocked && <InstallStrip />}
      <div className="min-h-0 flex-1">
        {pairing ? (
          <AddMachine onCancel={() => setPairing(false)} />
        ) : blocked || (link.state !== 'open' && link.downFor >= EXPLAIN_AFTER_MS) ? (
          <ConnectionProblem link={link} onPair={() => setPairing(true)} />
        ) : !link.everOpen ? (
          // The dashboard decides once, at start, whether this phone is
          // paired; it asks over an open channel, never a half-made one.
          <p className="px-6 pt-10 text-center text-[15px] text-fg-muted">Reaching {currentMachine()?.name ?? 'your computer'}…</p>
        ) : null}
        {link.everOpen && !blocked && !pairing && (
          <Suspense fallback={null}>
            <App />
          </Suspense>
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
    update()
    return () => {
      off()
      clearInterval(tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one channel per page
  }, [ch])
  return link
}

/** A few words for the bar; the full story is ConnectionProblem's. */
export function barLabel(state: ChannelState, problem: Problem): string {
  if (problem === 'removed') return 'Removed: pair again'
  if (state === 'open') return ''
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

/** What went wrong and what to do, for each problem. */
export function explain(problem: Problem, name: string, relay: string): { title: string; body: string } {
  let host = relay
  try {
    host = new URL(relay).host
  } catch { /* the address as given */ }
  switch (problem) {
    case 'machine-offline':
      return {
        title: 'Your computer is offline or Caprock isn’t running',
        body: `${name} is not connected to the relay. Wake it up, check it is on the internet, and open Caprock on it. This page keeps trying by itself.`,
      }
    case 'no-answer':
      return {
        title: 'Your computer isn’t answering',
        body: `The relay reached ${name}, but it did not reply. It may be asleep, or Caprock on it is restarting. This page keeps trying by itself.`,
      }
    case 'relay-unreachable':
      return {
        title: 'Can’t reach the relay: check the internet',
        body: `This phone cannot reach ${host}. Check Wi-Fi or mobile data. This page keeps trying by itself.`,
      }
    case 'no-internet':
      return { title: 'This phone is offline', body: 'Check Wi-Fi or mobile data. This page reconnects as soon as the network is back.' }
    case 'wrong-machine':
      return {
        title: 'This isn’t the computer this phone paired with',
        body: `The computer answering as ${name} has different keys, so nothing it sends is trusted. If its keys were reset, pair again: on the computer, Settings → Use on your phone → Show a code.`,
      }
    case 'removed':
      return {
        title: 'This phone was removed: pair again',
        body: `${name} no longer lets this phone in. On the computer, open Caprock: Settings → Use on your phone → Show a code, and scan it.`,
      }
    case 'lost':
      return { title: 'Connection lost', body: `Reconnecting to ${name}.` }
    default:
      return { title: 'Still connecting…', body: `Reaching ${name} through the relay at ${host}.` }
  }
}

/**
 * Shown when the channel has been down for EXPLAIN_AFTER_MS, or at once when
 * only pairing again can help: never a "Connecting…" with nothing after it.
 */
function ConnectionProblem({ link, onPair }: { link: Link; onPair: () => void }) {
  const cur = currentMachine()
  const { title, body } = explain(link.problem, cur?.name ?? 'Your computer', cur?.relay ?? '')
  const pairOnly = needsPairing(link.problem)
  const wait = link.nextAt ? Math.max(1, Math.ceil((link.nextAt - Date.now()) / 1000)) : 0
  return (
    <div role="alert" data-testid="connection-problem" className="mx-auto max-w-md px-6 pb-10 pt-8">
      <h1 className="text-[22px] font-semibold leading-tight text-fg">{title}</h1>
      <p className="mt-2 text-[16px] leading-snug text-fg-muted">{body}</p>
      {!pairOnly && (
        <p className="mt-3 text-[14px] text-fg-faint">{link.state === 'connecting' ? 'Trying now…' : wait ? `Next try in ${wait} s` : ''}</p>
      )}
      <div className="mt-6 flex gap-3">
        {!pairOnly && (
          <button
            type="button"
            onClick={() => void currentChannel()?.retryNow().catch(() => { /* the card says why */ })}
            disabled={link.state === 'connecting'}
            className="min-h-12 flex-1 rounded-xl bg-accent text-[17px] font-semibold text-bg disabled:opacity-50"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onPair}
          className={`min-h-12 flex-1 rounded-xl text-[17px] ${pairOnly ? 'bg-accent font-semibold text-bg' : 'border border-border-strong text-fg'}`}
        >
          Pair again
        </button>
      </div>
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
  const label = barLabel(state, link.problem)
  return (
    <div className="sticky top-0 z-50 border-b border-border bg-panel pt-[env(safe-area-inset-top)]">
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
          <span className="mt-1 inline-block rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-bg">Show a code</span>
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
          Press <b className="font-semibold text-fg">Show a code</b>. It turns on access from anywhere
        </Step>
        <Step n={3}>
          Scan the code with this phone&apos;s camera
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
            <a href={HOW_IT_WORKS} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-4">
              How it works
            </a>
            <a href={RELAY_SOURCE} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-4">
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
