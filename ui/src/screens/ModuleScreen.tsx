/**
 * A private module's screen (ADR-075): its page, served by the daemon at
 * /x/<id>/, in a frame that fills the screen and wears the app's theme.
 *
 * The frame is the dashboard's own origin, so the module reaches its store
 * (/v1/x/<id>/docs) and the API the app uses with no token of its own. The
 * theme goes in on load and again whenever the palette changes
 * (lib/modules.ts). A module the key does not open draws nothing.
 */
import { useEffect, useRef } from 'react'
import { applyModuleTheme, useAdmin } from '@/lib/modules'

export function ModuleScreen({ id }: { id: string }) {
  const admin = useAdmin()
  const frame = useRef<HTMLIFrameElement>(null)
  const mod = admin?.installed?.find((m) => m.id === id)

  useEffect(() => {
    if (!mod) return
    const obs = new MutationObserver(() => { if (frame.current) applyModuleTheme(frame.current) })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-dark', 'data-tone', 'data-glow', 'style'] })
    return () => obs.disconnect()
  }, [mod])

  if (!mod) return null
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  return (
    <iframe
      ref={frame}
      data-module={mod.id}
      title={mod.name}
      src={`${mod.url}?theme=${theme}`}
      onLoad={(e) => applyModuleTheme(e.currentTarget)}
      className="block w-full rounded-md border border-border bg-bg"
      style={{ height: 'calc(100vh - 6rem)', minHeight: 420 }}
    />
  )
}
