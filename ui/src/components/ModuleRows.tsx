/**
 * The app sidebar's rows for private modules (ADR-075): one per installed
 * module the admin key opens, above the footer. Without a key there are none
 * and nothing is drawn, not even the band.
 */
import { useRoute } from '@/lib/router'
import { useModules } from '@/lib/modules'

export function ModuleRows({ onOpen, dashboardActive }: { onOpen: (hash: string) => void; dashboardActive: boolean }) {
  const mods = useModules()
  const route = useRoute()
  if (mods.length === 0) return null
  return (
    <div data-module-rows className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-1 px-2 pt-2">
      {mods.map((m) => {
        const active = dashboardActive && route.name === 'module' && route.id === m.id
        return (
          <button
            key={m.id}
            type="button"
            data-nav-row
            data-module-row={m.id}
            aria-current={active ? 'true' : undefined}
            title={m.name}
            onClick={() => onOpen(`#/x/${m.id}`)}
            className="app-row flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg hover:bg-[var(--app-row-hover)]"
          >
            <span aria-hidden className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-accent text-[10px] font-semibold uppercase text-panel">{m.name.slice(0, 1)}</span>
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
          </button>
        )
      })}
    </div>
  )
}
