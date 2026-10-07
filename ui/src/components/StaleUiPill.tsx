/**
 * "Reload — Caprock was updated": shown when the daemon was updated under
 * this page and reloading by itself would lose text typed into an open sheet
 * (lib/staleui.ts). One click reloads, keeping the route.
 */
import { reloadFor, useStaleUi } from '@/lib/staleui'

export function StaleUiPill({ className = '' }: { className?: string }) {
  const running = useStaleUi()
  if (!running) return null
  return (
    <button
      type="button"
      onClick={() => reloadFor(running)}
      className={`rounded-full bg-accent px-2 py-[1px] text-[11px] font-medium text-panel hover:opacity-90 ${className}`}
      title={`This page is from an older Caprock; the daemon is now ${running}. Reloading keeps where you are; terminals keep what you typed.`}
    >
      Reload — Caprock was updated
    </button>
  )
}
