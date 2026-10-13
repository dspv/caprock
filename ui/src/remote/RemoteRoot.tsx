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

function AddMachine({ first, onCancel }: { first?: boolean; onCancel?: () => void }) {
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  function applyLink(raw: string) {
    const hash = raw.includes('#') ? raw.slice(raw.indexOf('#')) : ''
    if (!parsePairLink(hash)) {
      setError('That is not a Caprock pairing link. Copy it from Settings → Phone on the computer.')
      return
    }
    window.location.replace(window.location.pathname + hash)
    window.location.reload()
  }
  return (
    <div className={first ? 'mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10' : 'px-4 py-4'}>
      {first && <h1 className="text-2xl font-semibold text-fg">Caprock on your phone</h1>}
      <p className={`${first ? 'mt-3' : ''} text-fg-muted`}>
        On the computer Caprock runs on, open <span className="text-fg">Settings → Phone</span>, choose{' '}
        <span className="text-fg">From anywhere</span>, and scan the code with this phone&apos;s camera.
      </p>
      <p className="mt-3 text-sm text-fg-faint">
        Added this page to your home screen? It keeps its own storage, so paste the link instead: tap{' '}
        <span className="text-fg-muted">Copy link</span> under the code.
      </p>
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          applyLink(link.trim())
        }}
      >
        <input
          value={link}
          onChange={(e) => {
            setLink(e.target.value)
            setError('')
          }}
          placeholder="Pairing link"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-12 rounded-lg border border-border-strong bg-panel-2 px-3 font-mono text-sm text-fg"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={!link.trim()} className="min-h-12 flex-1 rounded-lg bg-accent font-semibold text-bg disabled:opacity-50">
            Add
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className="min-h-12 rounded-lg px-4 text-fg-muted">
              Cancel
            </button>
          )}
        </div>
      </form>
      <p className="mt-6 text-sm text-fg-faint">
        Everything between this phone and the computer is encrypted end to end. The relay in between passes it on
        and cannot read it.
      </p>
    </div>
  )
}
