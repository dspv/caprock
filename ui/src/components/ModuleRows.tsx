/**
 * The app sidebar's rows for private modules (ADR-076): one per installed
 * module the admin key opens, above the footer, each with its key (⇧⌘1 for
 * the first, appkeys moduleKey; on a Mac the third to fifth draw none, as
 * macOS takes ⇧⌘3–5 for screenshots). Without a key there are none and nothing is
 * drawn, not even the band.
 *
 * What waits on the owner in a module (PUT /v1/x/<id>/attention, amended
 * 2026-10-22) is a microscopic informer inside its row and nowhere else
 * (owner, 2026-10-22, translated: "inside the Ops chip, a microscopic
 * informer, and from there I can jump in. Nothing more."): *2 waiting* in the
 * warn colour. A click on it unfolds the row into the items the module named
 * (up to eight), each opening the module at its own route; with none named,
 * it opens the module. The row and Second Brain above it are an accordion,
 * kept in this browser (lib/sidebarAccordion). At 0 the row is as it always
 * was.
 */
import { useRoute } from '@/lib/router'
import { useModules } from '@/lib/modules'
import { keys, macTakenModuleKey, moduleKey, revealClass } from '@/lib/appkeys'
import { useChipFit } from '@/lib/keyChipFit'
import { isMacPlatform } from '@/lib/appmode'
import { href } from '@/lib/router'
import { setModuleFold, useModuleFold } from '@/lib/sidebarAccordion'
import type { ModuleAttention, ModuleInfo } from '@/lib/api'
import { ChevronIcon } from './AppIcons'

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

/** What waits in a module now: its attention while the count is above 0 and the report is under a day old. */
export function waiting(m: ModuleInfo, now = Date.now()): ModuleAttention | undefined {
  const a = m.attention
  return a && a.count > 0 && now - a.updated_at <= 24 * 3600_000 ? a : undefined
}

/** One row: the module's initial, its name and its key, the key left out whole when it does not fit; and what waits in it, when something does. */
function ModuleRow({ m, index, active, onOpen }: { m: ModuleInfo; index: number; active: boolean; onOpen: (hash: string) => void }) {
  const a = waiting(m)
  const unfolded = useModuleFold() === m.id
  if (!a) return <ModuleButton m={m} index={index} active={active} onOpen={onOpen} />
  const open = unfolded && a.items.length > 0
  const words = `${a.count} waiting`
  return (
    <div data-module-chip={m.id} className="min-w-0 rounded-[8px] border border-[var(--app-hairline-strong)]">
      <div className="flex min-w-0 items-center">
        <ModuleButton m={m} index={index} active={active} onOpen={onOpen} bare />
        <button
          type="button"
          data-module-attention
          aria-expanded={a.items.length > 0 ? open : undefined}
          aria-label={`${words} in ${m.name}`}
          title={a.items.length > 0 ? `${words} in ${m.name} — ${open ? 'fold' : 'show'} them` : `${words} in ${m.name} — open it`}
          onClick={() => (a.items.length > 0 ? setModuleFold(open ? null : m.id) : onOpen(`#/x/${m.id}`))}
          className="num mr-1 flex h-[20px] shrink-0 items-center gap-1 rounded-[5px] px-1 text-[10.5px] leading-none text-warn hover:bg-[var(--app-row-hover)]"
        >
          <span aria-hidden className="h-[5px] w-[5px] shrink-0 rounded-full bg-warn" />
          {words}
          {a.items.length > 0 && (
            <span aria-hidden className={`flex text-fg-faint transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}><ChevronIcon size={8} /></span>
          )}
        </button>
      </div>
      {open && (
        <ul data-module-items className="grid grid-cols-[minmax(0,1fr)] gap-px px-1 pb-1">
          {a.items.slice(0, 8).map((it, i) => (
            <li key={i} className="min-w-0">
              <button
                type="button"
                data-module-item
                title={it.label}
                onClick={() => onOpen(href({ name: 'module', id: m.id, to: it.href }))}
                className="flex h-[24px] w-full min-w-0 items-center rounded-[6px] pl-[26px] pr-2 text-left text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
              >
                <span className="min-w-0 truncate">{it.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The row's own button: opens the module. `bare` inside a row whose frame holds the informer too. */
function ModuleButton({ m, index, active, onOpen, bare = false }: { m: ModuleInfo; index: number; active: boolean; onOpen: (hash: string) => void; bare?: boolean }) {
  const mac = moduleKey(index)
  // ⇧⌘3–5 are macOS's screenshot keys: no chip, and the tooltip says why.
  const taken = !!mac && macTakenModuleKey(index)
  const label = mac && !taken ? keys(mac) : ''
  const [ref, fits] = useChipFit<HTMLButtonElement>([label, m.name])
  return (
    <button
      ref={ref}
      type="button"
      data-nav-row
      data-module-row={m.id}
      aria-current={active ? 'true' : undefined}
      aria-keyshortcuts={mac && !taken ? (isMacPlatform() ? `Shift+Meta+${index + 1}` : `Control+Alt+Shift+${index + 1}`) : undefined}
      title={label ? `${m.name} (${label})` : taken ? `${m.name} (${mac} is taken by macOS screenshots; it opens this when those shortcuts are off in System Settings → Keyboard → Keyboard Shortcuts)` : m.name}
      onClick={() => onOpen(`#/x/${m.id}`)}
      className={bare
        ? 'app-row relative flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg hover:bg-[var(--app-row-hover)]'
        : 'app-row relative flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg hover:bg-[var(--app-row-hover)]'}
    >
      <span aria-hidden className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-accent text-[10px] font-semibold uppercase text-panel">{m.name.slice(0, 1)}</span>
      <span data-key-label className="min-w-0 flex-1 truncate">{m.name}</span>
      {label && <kbd data-key-chip data-dropped={fits ? undefined : ''} className={`app-kbd-key shrink-0 ${revealClass()} ${fits ? '' : 'pointer-events-none invisible absolute right-2'}`}>{label}</kbd>}
    </button>
  )
}
