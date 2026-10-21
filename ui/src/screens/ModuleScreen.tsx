/**
 * A private module's screen (ADR-076): its page, served by the daemon at
 * /x/<id>/, in a frame that fills the screen and wears the app's theme.
 *
 * On the machine the frame is the dashboard's own origin, so the module
 * reaches its store (/v1/x/<id>/docs) and the API the app uses with no token
 * of its own. The theme goes in on load and again whenever the palette
 * changes (lib/modules.ts). A module the key does not open draws nothing.
 *
 * On a paired phone the owner made a controller (ADR-076 amended 2026-10-21)
 * the page is built by the dashboard from the module's files and runs in a
 * sandboxed frame of its own origin, reaching only its own files and store
 * through the dashboard (lib/modulebridge.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { isPairedDevice, type ModuleInfo } from '@/lib/api'
import { applyModuleTheme, moduleTheme, useAdmin } from '@/lib/modules'
import { answerBridge, buildModulePage, frameSecret, moduleFiles } from '@/lib/modulebridge'

const frameStyle = { height: 'calc(100dvh - 6rem)', minHeight: 420 }

/** Re-applies the theme to the frame whenever the app's palette changes. */
function useThemeFollow(frame: React.RefObject<HTMLIFrameElement | null>, on: boolean, sandboxed: boolean) {
  useEffect(() => {
    if (!on) return
    const obs = new MutationObserver(() => { if (frame.current) applyModuleTheme(frame.current, moduleTheme(), sandboxed) })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-dark', 'data-tone', 'data-glow', 'style'] })
    return () => obs.disconnect()
  }, [frame, on, sandboxed])
}

export function ModuleScreen({ id }: { id: string }) {
  const admin = useAdmin()
  const mod = admin?.installed?.find((m) => m.id === id)
  if (!mod) return null
  return isPairedDevice() ? <PhoneModule mod={mod} /> : <MachineModule mod={mod} />
}

function MachineModule({ mod }: { mod: ModuleInfo }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useThemeFollow(frame, true, false)
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  return (
    <iframe
      ref={frame}
      data-module={mod.id}
      title={mod.name}
      src={`${mod.url}?theme=${theme}`}
      onLoad={(e) => applyModuleTheme(e.currentTarget)}
      className="block w-full rounded-md border border-border bg-bg"
      style={frameStyle}
    />
  )
}

/**
 * The module on a phone: built from its files, in a frame with an opaque
 * origin (no allow-same-origin, so it cannot read the device token or the
 * dashboard's page), its requests answered only for its own paths.
 */
function PhoneModule({ mod }: { mod: ModuleInfo }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const secret = useMemo(() => frameSecret(), [])
  const [page, setPage] = useState<string>()
  const [failed, setFailed] = useState('')
  useThemeFollow(frame, !!page, true)

  useEffect(() => {
    let live = true
    buildModulePage(mod.id, moduleFiles(mod.id), { secret, origin: window.location.origin, theme: moduleTheme() })
      .then((p) => { if (live) setPage(p) })
      .catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [mod.id, secret])

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win) return
      void answerBridge(e.data, mod.id, secret).then((reply) => {
        if (!reply) return
        // The frame's origin is opaque ("null"), so it cannot be named; the
        // reply goes to the window that asked, carrying the frame's secret.
        win.postMessage(reply, '*', reply.body ? [reply.body] : [])
      })
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [mod.id, secret])

  if (failed) return <p data-module-error className="p-3 text-[13px] text-danger">{mod.name} could not open here: {failed}</p>
  if (!page) return <p className="p-3 text-[13px] text-fg-muted">Opening {mod.name}…</p>
  return (
    <iframe
      ref={frame}
      data-module={mod.id}
      title={mod.name}
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
      allow="clipboard-write"
      srcDoc={page}
      className="block w-full rounded-md border border-border bg-bg"
      style={frameStyle}
    />
  )
}
