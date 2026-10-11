/**
 * What a quick chat's pane adds around its terminal (owner, 2026-10-12:
 * "Quick chat opened a terminal … and now I can't get out of there",
 * translated).
 *
 * - **The hint**, one line above the terminal: who the chat is with and the
 *   two ways out, ⌘W and /exit. Dismissed once, it is gone for good.
 * - **The ended state**, over the terminal once the agent has exited: what
 *   happened, *Close tab* (focused, so Enter takes it) and *Start again* on
 *   the same agent and model. Other agents' tabs become a shell in their
 *   folder instead; a chat's folder is Caprock's own, where a shell is a
 *   terminal nobody asked for, and it looked just like the chat had.
 */
import { useEffect, useRef } from 'react'
import { ChatIcon, CloseIcon } from './AppIcons'

/** A quick chat's pane, as the workspace describes it to the terminal stack. */
export interface ChatPane {
  /** The line above the terminal; absent once dismissed. */
  hint?: string
  /** The agent has exited. */
  ended: boolean
}

export function ChatHint({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="note" aria-label="Quick chat" className="flex h-[28px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] bg-term-bg pl-3 pr-1 text-[12px] text-fg-muted">
      <ChatIcon size={12} className="shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss — not shown again"
        onClick={onDismiss}
        className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  )
}

export function ChatEnded({ visible, onClose, onRestart }: { visible: boolean; onClose: () => void; onRestart: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  // The keyboard leaves the terminal that has nothing behind it.
  useEffect(() => { if (visible) close.current?.focus() }, [visible])
  return (
    <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/25 pb-10 app-fade-in">
      <div role="group" aria-label="The chat ended" className="grid w-[340px] max-w-[calc(100%-32px)] gap-3 rounded-[12px] border border-[var(--app-hairline)] bg-panel px-4 py-3.5 shadow-lg">
        <div className="grid gap-0.5">
          <p className="text-[13.5px] font-medium text-fg">The chat ended</p>
          <p className="text-[12px] text-fg-muted">Its conversation stays on the dashboard.</p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onRestart} className="h-[30px] rounded-[7px] px-3 text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            Start again
          </button>
          <button ref={close} type="button" onClick={onClose} className="app-primary h-[30px] rounded-[7px] px-3 text-[12.5px] font-medium">
            Close tab
          </button>
        </div>
      </div>
    </div>
  )
}
