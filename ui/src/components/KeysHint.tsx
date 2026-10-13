/**
 * The one-line card that says how to move around, shown once (owner,
 * 2026-10-14, translated: "now it's unclear how to switch between sessions
 * in one project"). ⌘1–⌘9 changed meaning in the same release — tabs, no
 * longer the sidebar's Nth item — so the people who learned the old keys
 * are told once, and so is everyone new. Got it puts it away for good on
 * this machine; All keys opens the shortcuts sheet. No new panel: one line
 * above the bottom strips, which never takes focus from the terminal.
 */
import { moveKeysLine } from '@/lib/appkeys'
import { useState } from 'react'

export const KEYS_HINT_KEY = 'caprock.app.keysHint'

function seen(): boolean {
  try { return localStorage.getItem(KEYS_HINT_KEY) === 'seen' } catch { return false }
}

export function KeysHint({ isMac, onAllKeys }: { isMac: boolean; onAllKeys: () => void }) {
  const [hidden, setHidden] = useState(seen)
  if (hidden) return null
  const done = () => {
    try { localStorage.setItem(KEYS_HINT_KEY, 'seen') } catch { /* shown again next time */ }
    setHidden(true)
  }
  return (
    <div role="status" aria-label="Keys to move around" data-keys-hint
      className="app-fade-in flex shrink-0 justify-center border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-4 py-1.5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg">
        <span className="mono">{moveKeysLine(isMac)}</span>
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => { done(); onAllKeys() }} className="rounded-[6px] px-1.5 py-0.5 text-accent hover:bg-[var(--app-row-hover)]">All keys</button>
          <button type="button" onClick={done} className="rounded-[6px] px-1.5 py-0.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Got it</button>
        </span>
      </p>
    </div>
  )
}
