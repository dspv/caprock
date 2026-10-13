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
import type { ChannelState } from './transport'

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

export default function RemoteRoot() {
  if (!machine) return <AddMachine first />
  return (
    <div className="flex min-h-dvh flex-col">
      <MachineBar />
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <App />
        </Suspense>
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

function useChannelState(): [ChannelState, string] {
  const ch = currentChannel()
  const [s, setS] = useState<ChannelState>(ch?.state ?? 'closed')
  const [why, setWhy] = useState(ch?.reason ?? '')
  useEffect(() => {
    if (!ch) return
    setS(ch.state)
    return ch.onState((next) => {
      setS(next)
      setWhy(ch.reason)
    })
  }, [ch])
  return [s, why]
}

function MachineBar() {
  const [state, why] = useChannelState()
  const [open, setOpen] = useState(false)
  const cur = currentMachine()
  const label =
    state === 'open'
      ? ''
      : state === 'connecting'
        ? 'Connecting…'
        : why === 'offline'
          ? 'Not reachable: is it on and online?'
          : why || 'Disconnected'
  return (
    <div className="sticky top-0 z-50 border-b border-border bg-panel pt-[env(safe-area-inset-top)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 px-4 text-left"
        aria-expanded={open}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} aria-hidden />
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
          <img src="/favicon.svg" alt="" className="h-14 w-14" />
          <h1 className="mt-6 text-[32px] font-semibold leading-tight text-fg">Your computer, on your phone</h1>
          <p className="mt-2 text-[17px] text-fg-muted">Every session, from anywhere. Nothing to install.</p>
        </>
      )}

      <ol className={`${first ? 'mt-8' : ''} flex flex-col gap-5`}>
        <Step n={1}>
          On your computer, open Caprock: <b className="font-semibold text-fg">Settings → Phone</b>
        </Step>
        <Step n={2}>
          Next to <b className="font-semibold text-fg">From anywhere</b>, press <b className="font-semibold text-fg">Turn on</b>
        </Step>
        <Step n={3}>
          Press <b className="font-semibold text-fg">Show a code</b> and scan it with this phone&apos;s camera
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
              This page is the app. Share → <b className="font-semibold text-fg">Add to Home Screen</b> and it opens
              full screen, like any other.
            </Question>
            <Question q="Lost your phone?">
              On your computer, Settings → Phone: remove it from the list, and it can no longer get in.
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
      <span className="pt-1.5 text-[19px] leading-snug text-fg-muted">{children}</span>
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
