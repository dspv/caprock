/**
 * How an agent's tab in the app shows its session: as a chat or as its
 * terminal (.ai/04-ui.md § Chat, *Chat or Terminal*).
 *
 * A chat (ADR-071) — a quick chat, or any session in the data directory's
 * `chats/` — opens on the conversation; a project session opens on its
 * terminal. Switching is remembered for that session in this window's
 * storage, so the tab opens the same way next time. Both views read the same
 * session: switching starts, stops and types nothing.
 */

export type SessionView = 'chat' | 'terminal'

const KEY = 'caprock.app.session-view'
/** More than a person keeps open; the oldest choices are forgotten first. */
export const VIEW_KEEP = 200

function readAll(): Record<string, SessionView> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, SessionView> = {}
    for (const [id, m] of Object.entries(v as Record<string, unknown>)) if (m === 'chat' || m === 'terminal') out[id] = m
    return out
  } catch {
    return {}
  }
}

/** Every remembered choice, by session id. */
export function rememberedViews(): Record<string, SessionView> {
  return readAll()
}

/** Remembers how a session's tab is shown; the newest choice goes last, and the oldest past VIEW_KEEP is forgotten. */
export function rememberView(sessionId: string, view: SessionView) {
  const all = readAll()
  delete all[sessionId]
  const kept = Object.entries(all).slice(-(VIEW_KEEP - 1))
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...kept, [sessionId, view]]))) } catch { /* this window still shows it; the next one opens on the default */ }
}

/** How a session's tab opens: the choice remembered for it, else Chat for a chat and Terminal for the rest. */
export function viewOf(chosen: SessionView | undefined, chat: boolean): SessionView {
  return chosen ?? (chat ? 'chat' : 'terminal')
}
