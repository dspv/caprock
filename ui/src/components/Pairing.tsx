/**
 * Letting a tablet or a phone in.
 *
 * The daemon binds loopback and nothing else unless it was started with
 * `--lan`, so this panel has two quite different jobs depending on which.
 *
 * **Off** — explain what the switch does and what it costs, and say how to
 * turn it on. It is a restart rather than a toggle here on purpose: loopback
 * only is what the product promises, and a promise that survives a restart
 * silently is one nobody re-consents to. Someone who opens their laptop in a
 * coworking space should not be carrying a decision they made at home.
 *
 * **On** — show the address to type, a code to prove it is you, and every
 * device that has been let in, each with a way to throw it out. The code
 * counts down because a code with no visible expiry looks like a password,
 * and people treat passwords as things to write down.
 */
import { useEffect, useState } from 'react'
import { api, errText, type PairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'

export function Pairing() {
  const state = useApi(() => api.pairState(), [], { intervalMs: 5000 })
  const now = useNow(1000)
  const [code, setCode] = useState('')
  const [codeUntil, setCodeUntil] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const s = state.data

  // A code issued in another tab, or one still live from before this panel was
  // opened, is the same code — read it from the daemon rather than keeping two
  // ideas of what is outstanding.
  useEffect(() => {
    if (!s?.code || code) return
    setCode(s.code)
    setCodeUntil(Date.now() + (s.expires_in_sec ?? 0) * 1000)
  }, [s?.code, s?.expires_in_sec, code])

  const secondsLeft = codeUntil ? Math.max(0, Math.ceil((codeUntil - now) / 1000)) : 0
  useEffect(() => {
    if (code && codeUntil && secondsLeft === 0) setCode('')
  }, [code, codeUntil, secondsLeft])

  async function newCode() {
    setBusy(true)
    setError('')
    try {
      const r = await api.pairCode()
      setCode(r.code)
      setCodeUntil(Date.now() + r.expires_in_sec * 1000)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    setError('')
    try {
      await api.pairRevoke(id)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    }
  }

  if (!s) {
    return (
      <Panel title="Another device">
        <div className="text-[12px] text-fg-faint">reading…</div>
      </Panel>
    )
  }

  if (!s.enabled) {
    return (
      <Panel title="Another device">
        <div className="grid gap-2 text-[12px] leading-relaxed text-fg-muted">
          <p>
            Caprock answers only this machine. To read it from a tablet or a phone on the
            same network, restart it with <code className="mono text-fg">caprock up --lan</code>.
          </p>
          <p className="text-fg-faint">
            It is a restart rather than a switch because loopback-only is the promise, and
            one that survived a restart quietly would be one you never agreed to twice.
            Turn it on where you trust the network; it is off again next time.
          </p>
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="Another device">
      <div className="grid gap-3">
        <div className="grid gap-1">
          <div className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">
            open this on the other device
          </div>
          <div className="mono text-[15px] text-fg select-all">{s.url}</div>
        </div>

        <div className="grid gap-1.5">
          <div className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">
            then enter this code
          </div>
          {code ? (
            <div className="flex items-baseline gap-3">
              <span className="mono text-[28px] tracking-[0.2em] text-accent select-all">{code}</span>
              <span className="text-[11px] text-fg-faint">
                {secondsLeft > 60
                  ? `${Math.ceil(secondsLeft / 60)} min left`
                  : `${secondsLeft}s left`}
              </span>
            </div>
          ) : (
            <div>
              <button
                onClick={newCode}
                disabled={busy}
                className="rounded-sm border border-accent px-2 py-1 text-[12px] text-accent hover:bg-accent/10 disabled:opacity-50"
              >
                {busy ? 'asking…' : 'Show a code'}
              </button>
            </div>
          )}
          <p className="text-[11px] text-fg-faint">
            One device, once. It stops working after it is used or after five minutes,
            whichever comes first.
          </p>
        </div>

        {error && <div className="text-[12px] text-danger">{error}</div>}

        <Devices devices={s.devices} now={now} onRevoke={revoke} />
      </div>
    </Panel>
  )
}

function Devices({
  devices,
  now,
  onRevoke,
}: {
  devices: PairedDevice[]
  now: number
  onRevoke: (id: string) => void
}) {
  if (devices.length === 0) {
    return (
      <div className="border-t border-border pt-2.5 text-[12px] text-fg-faint">
        Nothing is paired. Only this machine can read your figures.
      </div>
    )
  }
  return (
    <div className="border-t border-border pt-2.5">
      <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-fg-faint">
        paired · {devices.length}
      </div>
      <div className="grid gap-1">
        {devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 text-[12px]">
            <span className="text-fg">{d.name}</span>
            <span className="text-fg-faint">
              {d.last_seen ? `last seen ${fmtAgo(d.last_seen, now)}` : 'not seen yet'}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => onRevoke(d.id)}
              title="This device stops working on its next request"
              className="text-[11px] text-fg-faint hover:text-danger"
            >
              revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
