/**
 * A session on another computer in a tab of its own (ADR-067, issue #1085):
 * the tab strip and the sidebar's Open list hold it as they hold one of this
 * machine's, tagged with the computer's name.
 *
 * What it shows is the machine page (screens/MachinePage, lib/machinepage):
 * this dashboard's own Session view in a frame whose every `/v1/…` request
 * and socket goes to that computer through this daemon's `/v1/m/<id>/…`
 * proxy. So the Chat, the Terminal, the timeline and the cost, tokens and
 * turns are the ordinary ones, read from that computer — nothing is drawn
 * twice, and what cannot apply there (opening a terminal window on its
 * screen, the editor) is already left out by the machine page.
 *
 * It opens on Chat. The frame's address is set once: a view picked inside
 * it is its own business, and reloading the frame would cut the terminal
 * it holds. Hidden, it stays mounted, as a terminal tab does.
 */
import { memo, useState } from 'react'
import { machineLook, machinePageURL, type Machine } from '@/lib/machines'

export const RemoteSessionPane = memo(function RemoteSessionPane({ machine, machineName, session, visible, m }: {
  machine: string
  machineName: string
  session: string
  visible: boolean
  /** The computer as `GET /v1/machines` has it; absent until that answers, or when it was forgotten here. */
  m?: Pick<Machine, 'name' | 'status' | 'error' | 'kind' | 'role'>
}) {
  const [src] = useState(() => machinePageURL(machine, session, 'chat'))
  // A computer that cannot be reached says why, in its state's words, as
  // its own page does; the frame stays, and picks up when it is back.
  const look = m ? machineLook(m) : undefined
  const why = look && !look.reachable ? look.detail : undefined
  return (
    <div data-remote-pane={session} data-machine={machine} className="absolute inset-0 flex flex-col bg-bg" hidden={!visible}>
      {why && <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-[13px] text-danger">{why}</p>}
      <iframe
        title={`${machineName}: session`}
        src={src}
        data-machine-frame
        className="block min-h-0 w-full flex-1 border-0 bg-bg"
      />
    </div>
  )
})
