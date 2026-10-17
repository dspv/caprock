/**
 * The app sidebar's rows for private modules (ADR-076): one per installed
 * module the admin key opens, above the footer, each with its key (⌥⌘1 for
 * the first, appkeys moduleKey). Without a key there are none and nothing is
 * drawn, not even the band.
 */
import { useRoute } from '@/lib/router'
import { useModules } from '@/lib/modules'
import { keys, moduleKey } from '@/lib/appkeys'
import { useChipFit } from '@/lib/keyChipFit'
import { isMacPlatform } from '@/lib/appmode'
import type { ModuleInfo } from '@/lib/api'

export function ModuleRows({ onOpen, dashboardActive }: { onOpen: (hash: string) => void; dashboardActive: boolean }) {
  const mods = useModules()
  const route = useRoute()
  if (mods.length === 0) return null
  return (
    <div data-module-rows className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-1 px-2 pt-2">
      {mods.map((m, i) => (
        <ModuleRow key={m.id} m={m} index={i} active={dashboardActive && route.name === 'module' && route.id === m.id} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** One row: the module's initial, its name and its key, the key left out whole when it does not fit. */
function ModuleRow({ m, index, active, onOpen }: { m: ModuleInfo; index: number; active: boolean; onOpen: (hash: string) => void }) {
  const mac = moduleKey(index)
  const label = mac ? keys(mac) : ''
  const [ref, fits] = useChipFit<HTMLButtonElement>([label, m.name])
  return (
    <button
      ref={ref}
      type="button"
      data-nav-row
      data-module-row={m.id}
      aria-current={active ? 'true' : undefined}
      aria-keyshortcuts={mac ? (isMacPlatform() ? `Alt+Meta+${index + 1}` : `Control+Alt+Shift+${index + 1}`) : undefined}
      title={label ? `${m.name} (${label})` : m.name}
      onClick={() => onOpen(`#/x/${m.id}`)}
      className="app-row relative flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg hover:bg-[var(--app-row-hover)]"
    >
      <span aria-hidden className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-accent text-[10px] font-semibold uppercase text-panel">{m.name.slice(0, 1)}</span>
      <span data-key-label className="min-w-0 flex-1 truncate">{m.name}</span>
      {label && <kbd data-key-chip data-dropped={fits ? undefined : ''} className={`app-kbd-key shrink-0 ${fits ? '' : 'pointer-events-none invisible absolute right-2'}`}>{label}</kbd>}
    </button>
  )
}
