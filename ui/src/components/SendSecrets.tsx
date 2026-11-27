/**
 * *Send secrets* on a linked computer's page (ADR-107, issue #1095): tick
 * the credentials this computer keeps — the GitHub token Caprock holds, the
 * DeepSeek and Kimi keys — and press **Send**. They go to that computer
 * inside the end-to-end encrypted link and are kept in its secret store, as
 * if entered in its Settings. Nothing is ticked to begin with and nothing
 * is sent but on the click; the page only ever handles names
 * (lib/secretshare.ts).
 */
import { useState } from 'react'
import type { Machine } from '@/lib/machines'
import { useApi } from '@/lib/useApi'
import { secretNames, secretsApi, sendError, type SecretReceipt } from '@/lib/secretshare'

const BUTTON = 'shrink-0 rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-semibold text-panel hover:brightness-110 disabled:opacity-50'

export function SendSecrets({ m }: { m: Pick<Machine, 'id' | 'name'> }) {
  const here = useApi(() => secretsApi.here(), [], { live: false })
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<SecretReceipt | null>(null)
  const items = here.data
  if (!items || items.length === 0) return null
  const sendable = items.filter((i) => i.set)
  const toggle = (name: string) => {
    setDone(null)
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]))
  }
  const send = async () => {
    setBusy(true)
    setError('')
    setDone(null)
    try {
      const r = await secretsApi.send(m.id, picked)
      setDone(r)
      setPicked((p) => p.filter((n) => !r.stored.includes(n)))
    } catch (e) {
      setError(sendError(e, m.name))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Send secrets" data-send-secrets className="grid min-w-0 gap-2.5 rounded-[10px] border border-border bg-panel px-5 py-4">
      <div className="grid gap-0.5">
        <h2 className="text-[15px] font-semibold text-fg">Send secrets</h2>
        <p className="text-[12.5px] text-fg-muted">
          Copies the keys you tick from this computer to {m.name}, end-to-end encrypted through the link, into its secret store. Nothing is sent until you press Send.
        </p>
      </div>
      {sendable.length === 0 && (
        <p className="text-[12.5px] text-fg-faint" data-send-secrets-none>Nothing to send: this computer keeps no GitHub token, DeepSeek or Kimi key.</p>
      )}
      <ul className="grid min-w-0 gap-1">
        {items.map((i) => (
          <li key={i.name} className="min-w-0">
            <label className={`flex min-w-0 items-center gap-2 text-[13.5px] ${i.set ? 'cursor-pointer text-fg' : 'text-fg-faint'}`} title={i.note}>
              <input type="checkbox" disabled={!i.set || busy} checked={picked.includes(i.name)} onChange={() => toggle(i.name)} data-secret={i.name} />
              <span>{i.label}</span>
              {!i.set && <span className="truncate text-[12px]">· {i.note ?? 'not set here'}</span>}
            </label>
          </li>
        ))}
      </ul>
      {sendable.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className={BUTTON} disabled={busy || picked.length === 0} onClick={() => void send()} data-send-secrets-go>
            {busy ? 'Sending…' : picked.length > 0 ? `Send ${picked.length} to ${m.name}` : 'Send'}
          </button>
          {done && done.stored.length > 0 && (
            <span role="status" className="text-[12.5px] text-ok" data-send-secrets-sent>✓ {m.name} keeps the {secretNames(done.stored, items)} now.</span>
          )}
        </div>
      )}
      {done && done.failed.length > 0 && (
        <ul role="alert" className="grid gap-0.5 text-[12.5px] text-danger" data-send-secrets-failed>
          {done.failed.map((f) => <li key={f.name}>{secretNames([f.name], items)}: {f.error}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
    </section>
  )
}
