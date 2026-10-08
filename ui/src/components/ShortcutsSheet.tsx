import { SHORTCUTS } from '@/lib/appkeys'
import { Sheet } from './Sheet'

/** Every app key in one place, from the palette (⌘K → Keyboard shortcuts). */
export function ShortcutsSheet({ isMac, onClose }: { isMac: boolean; onClose: () => void }) {
  return (
    <Sheet label="Keyboard shortcuts" title="Keyboard shortcuts" onClose={onClose} width={480}>
      <div className="grid gap-3 px-5 py-4">
        {!isMac && (
          <p className="text-[12px] text-fg-muted">
            Here each is Ctrl+Shift with the same key; Ctrl+Shift+C and V stay the terminal&rsquo;s copy and paste, and F5 reloads.
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[13px]">
          {SHORTCUTS.map(([keys, does]) => (
            <div key={keys} className="contents">
              <dt><kbd className="mono text-[12px] text-fg">{keys}</kbd></dt>
              <dd className="text-fg-muted">{does}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Sheet>
  )
}
