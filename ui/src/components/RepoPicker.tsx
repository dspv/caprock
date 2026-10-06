/**
 * Your GitHub repositories, to clone one with a click (WP-19): every
 * repository the connection reaches, or one owner's (you, or an
 * organization), searched by name, a page at a time. Picking one fills the
 * clone address — https, or ssh when that is what you clone with — and the
 * address field stays for pasting anything else. Used by ⌘O on the desktop
 * and by Start work on the phone.
 */
import { useEffect, useRef, useState } from 'react'
import { isPairedDevice } from '@/lib/api'
import { githubApi, githubErrorText, useGitHubStatus, type GitHubOwner, type GitHubRepo } from '@/lib/github'

const PROTOCOL_KEY = 'caprock.github.protocol'

function loadProtocol(): 'https' | 'ssh' {
  try { return localStorage.getItem(PROTOCOL_KEY) === 'ssh' ? 'ssh' : 'https' } catch { return 'https' }
}

/** How long typing pauses before a search goes out (GitHub's search allows 30 a minute). */
export const SEARCH_DEBOUNCE_MS = 350

export function RepoPicker({ onPick, picked, compact = false }: { onPick: (url: string, repo: GitHubRepo) => void; picked?: string; compact?: boolean }) {
  const { status, error: statusError } = useGitHubStatus()
  const [owners, setOwners] = useState<GitHubOwner[]>([])
  const [owner, setOwner] = useState('')
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [page, setPage] = useState(1)
  const [next, setNext] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [protocol, setProtocol] = useState<'https' | 'ssh'>(loadProtocol)
  const seq = useRef(0)
  const qRef = useRef('')
  const connected = status?.connected ?? false

  useEffect(() => { try { localStorage.setItem(PROTOCOL_KEY, protocol) } catch { /* not kept */ } }, [protocol])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = query.trim()
      if (next === qRef.current) return
      qRef.current = next
      setQ(next)
      setPage(1) // a new search starts from the first page
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!connected) return
    githubApi.owners().then(setOwners).catch(() => { /* the list below says what failed */ })
  }, [connected])

  useEffect(() => {
    if (!connected) return
    const n = ++seq.current
    setLoading(true)
    setError('')
    githubApi.repos(owner, q, page)
      .then((p) => {
        if (n !== seq.current) return
        setRepos((cur) => (page === 1 ? p.repos : [...cur, ...p.repos]))
        setNext(p.next)
      })
      .catch((e: unknown) => { if (n === seq.current) setError(githubErrorText(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [connected, owner, q, page])

  if (statusError) return null // an older daemon: the address field is all there is
  if (!status) return null
  if (!connected) {
    return (
      <p className="text-[12px] leading-relaxed text-fg-faint">
        {isPairedDevice() ? 'Connect GitHub in Settings on the computer to pick from your repositories.' : 'Connect GitHub in Settings → GitHub to pick from your repositories.'}
      </p>
    )
  }

  const row = compact ? 'min-h-11 py-2' : 'py-1.5'
  const field = compact ? 'input h-11 !text-[16px]' : 'input'
  return (
    <div className="grid min-w-0 gap-2" aria-label="Your GitHub repositories">
      <div className="flex min-w-0 flex-wrap gap-2">
        <input
          className={`${field} min-w-0 flex-1`}
          type="search"
          aria-label="Search your repositories"
          placeholder="Search your repositories"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {owners.length > 1 && (
          <select className={`${field} w-auto max-w-[45%]`} aria-label="Owner" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1) }}>
            <option value="">All</option>
            {owners.map((o) => <option key={o.login} value={o.login}>{o.login}</option>)}
          </select>
        )}
      </div>
      <div className={`app-scroll overflow-y-auto rounded-[8px] border border-border ${compact ? 'max-h-[300px]' : 'max-h-[220px]'}`} role="listbox" aria-label="Repositories">
        {repos.map((r) => {
          const url = protocol === 'ssh' ? r.ssh_url : r.clone_url
          const on = picked === r.clone_url || picked === r.ssh_url
          return (
            <button
              key={r.full_name}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(url, r)}
              className={`flex w-full min-w-0 items-baseline gap-2 border-b border-border/60 px-2.5 text-left last:border-0 ${row} ${on ? 'bg-accent/10' : 'hover:bg-panel-2'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">
                  <span className="text-fg-muted">{r.owner}/</span>{r.name}
                  {r.private && <span className="ml-1.5 rounded-[4px] border border-border px-1 text-[10.5px] text-fg-muted">private</span>}
                  {r.fork && <span className="ml-1.5 text-[10.5px] text-fg-faint">fork</span>}
                  {r.archived && <span className="ml-1.5 text-[10.5px] text-warn">archived</span>}
                </span>
                {r.description && <span className="block truncate text-[11.5px] text-fg-faint">{r.description}</span>}
              </span>
            </button>
          )
        })}
        {!loading && !error && repos.length === 0 && <p className="px-2.5 py-2 text-[12px] text-fg-faint">{q ? `No repository named like “${q}”.` : 'No repositories.'}</p>}
        {loading && <p className="px-2.5 py-2 text-[12px] text-fg-faint" aria-busy="true">Reading GitHub…</p>}
        {next && !loading && (
          <button type="button" onClick={() => setPage((p) => p + 1)} className={`w-full px-2.5 text-left text-[12px] text-accent ${row}`}>More…</button>
        )}
      </div>
      {error && <p role="alert" className="text-[12px] leading-snug text-danger [overflow-wrap:anywhere]">{error}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-faint">
        <span>Clone over</span>
        {(['https', 'ssh'] as const).map((p) => (
          <label key={p} className={`flex items-center gap-1 ${compact ? 'min-h-11' : ''}`}>
            <input type="radio" name="clone-protocol" checked={protocol === p} onChange={() => setProtocol(p)} className="accent-[var(--color-accent)]" />
            {p === 'https' ? 'HTTPS' : 'SSH'}
          </label>
        ))}
        <span>· or paste any address below</span>
      </div>
    </div>
  )
}
