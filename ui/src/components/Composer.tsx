/**
 * The composer (.ai/21-app.md § Composer): a box docked under an agent's
 * terminal to write a message in, for people who would rather not compose a
 * long prompt inside a TUI. Off by default (Settings → Terminal); a pane with
 * it off is exactly the pane it always was.
 *
 * - **Sending** is the chat field's path (`POST /v1/agents/{id}/queue`,
 *   ADR-053): typed in at once when the agent is at its prompt, held by the
 *   daemon and typed in when the turn ends otherwise. The daemon types each
 *   line break as ESC CR and Enter after a pause, so a message of several
 *   lines arrives as one message.
 * - **The terminal keeps the keyboard it had.** A click in the terminal
 *   focuses the terminal, Esc here goes back to it, and a key typed in the
 *   terminal stays there: a permission prompt or a menu is answered in the
 *   terminal, and the box says so while one is open.
 * - **Pickers and saved prompts** are the chat field's: `/` lists the
 *   session's commands, `@` its files, Saved its saved prompts. A pick only
 *   puts text in the box.
 * - **An image pasted here** goes to the terminal's own paste path, so
 *   Claude Code shows `[Image #N]` in its prompt, and the words sent from
 *   the box follow it.
 * - **History**: ↑ and ↓ on an empty box walk the last 50 messages sent from
 *   it to this session (this browser only).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useQueue } from '@/lib/queue'
import { useSavedPromptsFor } from '@/lib/saved'
import { keys } from '@/lib/appkeys'
import { historyStep, loadHistory, pushHistory, setComposerEnabled } from '@/lib/composer'
import { ChatPickerList, useChatPicker } from './ChatPicker'
import { MoreIcon } from './AppIcons'

/** Six lines of 20px, the padding and the border: past this the box scrolls. */
const BOX_MAX_PX = 6 * 20 + 14 + 2

/** The agent as a sentence names it. */
export function composerAgentName(agent?: string): string {
  switch (agent) {
    case undefined:
    case '':
    case 'claude': return 'Claude'
    case 'opencode': return 'OpenCode'
    case 'gemini': return 'Gemini'
    case 'codex': return 'Codex'
    case 'deepseek': return 'DeepSeek'
    case 'grok': return 'Grok'
    default: return 'the agent'
  }
}

export function Composer({ sessionId, agent, asking, onFiles, onBack }: {
  sessionId: string
  agent?: string
  /** A permission prompt is open in the terminal (the live permissions set). */
  asking: boolean
  /** Pasted files: the terminal's own paste path (xtermInput sendFiles). */
  onFiles: (files: File[]) => void
  /** Back to the terminal. */
  onBack: () => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [menu, setMenu] = useState<'' | 'more' | 'saved'>('')
  const field = useRef<HTMLTextAreaElement>(null)
  const history = useRef<string[]>([])
  // The history entry shown, or history.length for a fresh message.
  const at = useRef(0)
  useEffect(() => {
    history.current = loadHistory(sessionId)
    at.current = history.current.length
  }, [sessionId])
  // A menu closes on a press anywhere outside the composer.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setMenu('') }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])
  const queue = useQueue(sessionId)
  const saved = useSavedPromptsFor(sessionId)
  const name = composerAgentName(agent)
  const question = queue.waiting === 'question'
  const prompt = asking || queue.waiting === 'permission' || question

  // One line idle, growing with what is typed up to six, then scrolling.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    // Empty, it is one line whatever the placeholder would wrap to: a
    // placeholder that wraps beside a status must not grow the box.
    if (!text) { el.style.height = ''; return }
    el.style.height = 'auto'
    if (el.scrollHeight === 0) return
    el.style.height = `${Math.min(el.scrollHeight + 2, BOX_MAX_PX)}px`
  }, [text])

  // A pick puts the caret after what it inserted, once the box has it.
  const caretAfter = useRef<number | null>(null)
  const chooser = useChatPicker(sessionId, true, (t, caret) => {
    caretAfter.current = caret
    setText(t)
  })
  useLayoutEffect(() => {
    const el = field.current
    const c = caretAfter.current
    if (!el || c === null) return
    caretAfter.current = null
    el.focus()
    el.setSelectionRange(c, c)
  }, [text])
  const trackCaret = (el: HTMLTextAreaElement) => chooser.track(el.value, el.selectionStart ?? el.value.length)
  const listId = `composer-picker-${sessionId}`

  const submit = async () => {
    const message = text
    if (!message.trim() || sending) return
    setSending(true)
    setError('')
    try {
      const r = await api.queueSend(sessionId, message)
      queue.apply(r.queue)
      history.current = pushHistory(sessionId, message)
      at.current = history.current.length
      setText((t) => (t === message ? '' : t))
      chooser.track('', 0)
    } catch (e) {
      setError(`Not sent: ${errText(e)}`)
    } finally {
      setSending(false)
    }
  }

  const walk = (dir: -1 | 1): boolean => {
    const list = history.current
    // Only from an empty box, or one still showing the entry walked to.
    const showing = at.current < list.length ? list[at.current] : ''
    if (text !== showing) return false
    const step = historyStep(list, at.current, dir)
    if (!step) return false
    at.current = step.at
    caretAfter.current = step.text.length
    setText(step.text)
    return true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (chooser.onKeyDown(e)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setMenu('')
      onBack()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      void submit()
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (walk(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return // text: the box's own paste
    e.preventDefault()
    onFiles(files)
  }

  const queued = queue.messages.length
  const status = prompt
    ? { tone: 'warn', text: question ? `${name} asked a question — answer in the terminal` : `${name} is asking — answer in the terminal (1/2/3)` }
    : error
      ? { tone: 'danger', text: error }
      : queued > 0
        ? { tone: 'muted', text: `${queued > 1 ? `${queued} ` : ''}queued · sends when the agent is free` }
        : null

  return (
    <div ref={root} data-composer className="relative shrink-0 px-2 pb-2 pt-1">
      <ChatPickerList p={chooser} listId={listId} />
      {menu && (
        <div role="menu" aria-label={menu === 'saved' ? 'Saved prompts' : 'Composer'} className="absolute bottom-full right-2 z-20 mb-1 w-[min(320px,90%)] rounded-sm border border-border-strong bg-panel p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          {menu === 'saved' ? saved.map((v) => (
            <button key={v.id} type="button" role="menuitem" title={v.text}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setMenu('')
                caretAfter.current = null
                setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${v.text}` : v.text))
                field.current?.focus()
              }}
              className="flex w-full min-w-0 flex-col items-start rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-accent/15">
              <span className="w-full truncate">{v.name}</span>
              <span className="w-full truncate text-[12px] text-fg-muted">{v.text}</span>
            </button>
          )) : (
            <button type="button" role="menuitem" onClick={() => { setMenu(''); setComposerEnabled(false); onBack() }}
              className="flex w-full flex-col items-start rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-accent/15">
              <span>Turn the composer off</span>
              <span className="text-[12px] text-fg-muted">Every pane; Settings → Terminal turns it back on</span>
            </button>
          )}
        </div>
      )}
      <div data-composer-box data-asking={prompt || undefined} className="app-composer flex items-end gap-1 rounded-[8px] pl-2.5 pr-1">
        <textarea
          ref={field}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            trackCaret(e.target)
            if (error) setError('')
          }}
          onSelect={(e) => trackCaret(e.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={status ? `Message ${name}…` : `Message ${name}…  ${keys('↩')} send · ${keys('⇧↩')} newline · Esc back to terminal`}
          aria-label={`Message ${name}`}
          aria-autocomplete="list"
          aria-expanded={chooser.open}
          aria-controls={listId}
          aria-activedescendant={chooser.open && chooser.rows.length > 0 ? `${listId}-${chooser.active}` : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`min-w-0 flex-1 resize-none bg-transparent py-[7px] text-[13px] leading-[20px] text-fg outline-none placeholder:text-fg-faint ${text ? 'overflow-y-auto' : 'h-[34px] overflow-hidden'}`}
          style={{ maxHeight: BOX_MAX_PX }}
        />
        {status && (
          <span role="status" aria-live="polite" data-composer-status={status.tone}
            className={`mb-[7px] max-w-[45%] shrink truncate text-[12px] leading-[20px] ${status.tone === 'warn' ? 'text-warn' : status.tone === 'danger' ? 'text-danger' : 'text-fg-muted'}`}>
            {status.text}
          </span>
        )}
        {saved.length > 0 && (
          <button type="button" aria-haspopup="menu" aria-expanded={menu === 'saved'} title="Saved prompts: put one in the box"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu((m) => (m === 'saved' ? '' : 'saved'))}
            className="mb-[5px] h-[24px] shrink-0 rounded-[6px] px-1.5 text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            Saved
          </button>
        )}
        <button type="button" aria-haspopup="menu" aria-expanded={menu === 'more'} aria-label="Composer options" title="Composer options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenu((m) => (m === 'more' ? '' : 'more'))}
          className="mb-[5px] flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg">
          <MoreIcon size={14} />
        </button>
      </div>
    </div>
  )
}
