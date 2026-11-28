/**
 * A session on another computer in a tab of its own (ADR-067, issue #1085):
 * the tab strip and the sidebar's Open list hold it as they hold one of this
 * machine's, tagged with the computer's name.
 *
 * What it shows is the machine page in tab mode (components/MachineTab.tsx,
 * lib/machinepage machineTabURL): this app's own tab — the live terminal
 * first, the chat over it, the agent cockpit beside it — in a frame whose
 * every `/v1/…` request and socket goes to that computer through this
 * daemon's `/v1/m/<id>/…` proxy. Nothing is drawn twice, and nothing reads
 * as a phone: it is the same component tree as a tab here (owner,
 * 2026-11-28).
 *
 * The strip's Chat/Terminal switch and ⌘I are this window's: their state is
 * sent into the frame (MachineTabState) whenever it changes and when the
 * frame loads; what the frame asks — the view, the inspector, Close,
 * opening another session there, one of the app's keys — comes back as a
 * MachineTabAsk from that frame alone. The frame's address is set once:
 * reloading it would cut the terminal it holds. Hidden, it stays mounted,
 * as a terminal tab does.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { machineLook, type Machine } from '@/lib/machines'
import { machineTabURL, type MachineTabAsk, type MachineTabState } from '@/lib/machinepage'

export const RemoteSessionPane = memo(function RemoteSessionPane({ machine, machineName, session, visible, m, view, inspector, onAsk }: {
  machine: string
  machineName: string
  session: string
  visible: boolean
  /** The computer as `GET /v1/machines` has it; absent until that answers, or when it was forgotten here. */
  m?: Pick<Machine, 'name' | 'status' | 'error' | 'kind' | 'role'>
  /** The tab's Chat/Terminal switch, as the strip has it. */
  view: 'chat' | 'terminal'
  /** The inspector is open in this window. */
  inspector: boolean
  /** What the tab in the frame asks of this window. */
  onAsk?: (ask: MachineTabAsk) => void
}) {
  const [src] = useState(() => machineTabURL(machine, session, view, inspector))
  const frame = useRef<HTMLIFrameElement>(null)
  // A computer that cannot be reached says why, in its state's words, as
  // its own page does; the frame stays, and picks up when it is back.
  const look = m ? machineLook(m) : undefined
  const why = look && !look.reachable ? look.detail : undefined
  const tell = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const msg: MachineTabState = { type: 'caprock:machine-tab', view, inspector, visible }
    try { w.postMessage(msg, location.origin) } catch { /* not loaded yet: the load tells it */ }
  }, [view, inspector, visible])
  useEffect(() => { tell() }, [tell])
  const tellRef = useRef(tell)
  tellRef.current = tell
  // Shown again, the terminal in the frame takes the keyboard as a tab here does.
  useEffect(() => { if (visible) frame.current?.focus() }, [visible])
  const askRef = useRef(onAsk)
  askRef.current = onAsk
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || !frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data as MachineTabAsk | undefined
      if (d?.type !== 'caprock:machine-tab-ask') return
      if (d.ask === 'ready') tellRef.current()
      else askRef.current?.(d)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return (
    <div data-remote-pane={session} data-machine={machine} className="absolute inset-0 flex flex-col bg-[var(--app-chrome-bg)]" hidden={!visible}>
      {why && <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-[13px] text-danger">{why}</p>}
      <iframe
        ref={frame}
        title={`${machineName}: session`}
        src={src}
        onLoad={tell}
        data-machine-frame
        className="block min-h-0 w-full flex-1 border-0 bg-[var(--app-chrome-bg)]"
      />
    </div>
  )
})
