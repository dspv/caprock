/**
 * "MacBook wants to control this computer" — Allow / Deny (ADR-067).
 *
 * Another computer's Caprock that redeemed a code *for a computer* waits
 * until the owner allows it here, by its name; until then its token reaches
 * nothing but where it stands. This card is the screen's half of that
 * decision; `caprock pair --computer` asks in the terminal, and
 * `caprock machines allow <name>` answers over SSH.
 *
 * Shown on the machine itself only (the pairing state is loopback-only), and
 * re-read when the daemon says the paired devices changed (the `devices`
 * live frame, which carries no name). It never takes focus: a terminal tab
 * keeps the keyboard.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, errText, isPairedDevice, type PairedDevice } from '@/lib/api'
import { live } from '@/lib/live'

export function ComputerAsks() {
  const [waiting, setWaiting] = useState<PairedDevice[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const read = useCallback(() => {
    api.pairState().then(
      (st) => setWaiting((st.devices ?? []).filter((d) => d.kind === 'machine' && d.pending)),
      () => { /* the daemon is away; the next frame asks again */ },
    )
  }, [])

  useEffect(() => {
    if (isPairedDevice()) return
    read()
    return live.onFrame((f) => {
      if (f.type === 'devices' || f.type === 'reset') read()
    })
  }, [read])

  const first = waiting[0]
  if (!first || isPairedDevice()) return null

  const decide = (allow: boolean) => {
    setBusy(first.id)
    setErr('')
    ;(allow ? api.pairAllow(first.id) : api.pairRevoke(first.id)).then(
      () => { setBusy(''); read() },
      (e) => { setBusy(''); setErr(errText(e)) },
    )
  }

  return (
    <div
      role="alertdialog"
      aria-label="A computer asks to control this one"
      data-testid="computer-asks"
      className="app-fade-in pointer-events-auto fixed left-1/2 top-3 z-50 grid w-[420px] max-w-[calc(100vw-24px)] -translate-x-1/2 gap-2.5 rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-4 text-[13.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      <p className="text-[15px] font-semibold">
        <span data-computer-name>{first.name}</span> wants to control this computer
      </p>
      <p className="text-fg-muted">
        It could start, type into and stop sessions here, open shells and run tasks. It could not change
        settings or pairing. Remove it any time in Settings → Use on your phone.
      </p>
      {waiting.length > 1 && <p className="text-[12.5px] text-fg-faint">{waiting.length - 1} more waiting after this one.</p>}
      {err && <p role="alert" className="text-[12.5px] text-danger">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" disabled={busy !== ''} onClick={() => decide(false)} className="rounded-[7px] px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg disabled:opacity-50">
          Deny
        </button>
        <button type="button" disabled={busy !== ''} onClick={() => decide(true)} className="rounded-[7px] bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:brightness-110 disabled:opacity-50">
          Allow
        </button>
      </div>
    </div>
  )
}
