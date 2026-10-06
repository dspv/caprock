/**
 * Find in the terminal's scrollback (F16): the bar ⌘F opens over the focused
 * pane. Enter and ⇧Enter go to the next and previous match, Aa matches case,
 * .* reads the text as a regular expression, Esc closes and gives the
 * keyboard back to the terminal. The search itself is xterm's official
 * addon (@xterm/addon-search), which highlights every match.
 */
import { useEffect, useRef, useState } from 'react'
import { CloseIcon } from './AppIcons'

export interface FindOptions {
  caseSensitive: boolean
  regex: boolean
}

/** What the pane hands the bar: the addon's two directions and its clear. */
export interface TermSearch {
  /** False when nothing matches. Throws on a regular expression that does not compile. */
  next: (query: string, opts: FindOptions & { incremental?: boolean }) => boolean
  prev: (query: string, opts: FindOptions) => boolean
  clear: () => void
}

/** "3 of 12", "1000+ matches" past the highlight limit, or what went wrong. */
export function resultLabel(query: string, results: { index: number; count: number } | null, invalid: boolean): string {
  if (!query) return ''
  if (invalid) return 'Invalid pattern'
  if (!results || results.count === 0) return 'No results'
  if (results.index < 0) return `${results.count}+ matches`
  return `${results.index + 1} of ${results.count}`
}

export function TerminalFind({ search, results, focusToken, onClose }: {
  search: TermSearch
  results: { index: number; count: number } | null
  /** Changes each time ⌘F is pressed, so a second press selects the text again. */
  focusToken: number
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState<FindOptions>({ caseSensitive: false, regex: false })
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusToken])

  const run = (dir: 'next' | 'prev', q = query, o = opts, incremental = false) => {
    if (!q) {
      search.clear()
      setInvalid(false)
      return
    }
    try {
      if (dir === 'next') search.next(q, { ...o, incremental })
      else search.prev(q, o)
      setInvalid(false)
    } catch {
      search.clear()
      setInvalid(true)
    }
  }
  const toggle = (k: keyof FindOptions) => {
    const next = { ...opts, [k]: !opts[k] }
    setOpts(next)
    run('next', query, next, true)
    input.current?.focus()
  }
  const label = resultLabel(query, results, invalid)
  const none = !!query && (invalid || !results || results.count === 0)

  return (
    <div
      role="search"
      aria-label="Find in the terminal"
      className="app-fade-in absolute right-3 top-2 z-20 flex items-center gap-1 rounded-[9px] border border-[var(--app-hairline-strong)] bg-panel py-1 pl-2 pr-1 text-[12px] text-fg shadow-[0_12px_32px_-14px_rgba(0,0,0,0.6)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={input}
        type="text"
        value={query}
        placeholder="Find"
        aria-label="Find"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value)
          run('next', e.target.value, opts, true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            run(e.shiftKey ? 'prev' : 'next')
          }
        }}
        className={`mono h-[24px] w-[180px] rounded-[5px] bg-transparent px-1 outline-none placeholder:text-fg-faint ${none ? 'text-danger' : ''}`}
      />
      <span role="status" aria-live="polite" className="num min-w-[64px] text-right text-[11px] text-fg-faint">{label}</span>
      <Toggle label="Match case" pressed={opts.caseSensitive} onClick={() => toggle('caseSensitive')}>Aa</Toggle>
      <Toggle label="Regular expression" pressed={opts.regex} onClick={() => toggle('regex')}>.*</Toggle>
      <BarButton label="Previous match (⇧Enter)" onClick={() => run('prev')}>↑</BarButton>
      <BarButton label="Next match (Enter)" onClick={() => run('next')}>↓</BarButton>
      <BarButton label="Close (Esc)" onClick={onClose}><CloseIcon size={12} /></BarButton>
    </div>
  )
}

function Toggle({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`mono flex h-[22px] min-w-[24px] items-center justify-center rounded-[5px] px-1 text-[11px] ${pressed ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      {children}
    </button>
  )
}
