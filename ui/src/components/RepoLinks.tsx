import { useState } from 'react'
import type { RepoLink, SessionPR } from '@/lib/api'
import { PRIMARY, SECONDARY } from '@/components/ProjectTerminal'

/**
 * The repository a session works in, and the pull requests it opened, one
 * click away (owner request, 2026-10-04: "acutely missing").
 *
 * Everything here is local (rule 4): the address is the session directory's
 * git remote turned into its web form by the daemon, and the pull requests are
 * Claude Code's own record of each `gh pr` command the session ran. Nothing
 * asks GitHub, so nothing here can say a PR is open — only that it was opened,
 * and that it was merged when a merge was recorded.
 *
 * No remote, no link: the local path is shown with a copy button instead,
 * because a button that opens nothing is worse than a path you can paste.
 */

const MAX_SHOWN = 3

function prLabel(p: SessionPR): string {
  const t = p.title ? ` ${p.title}` : ''
  return `#${p.number}${t}`
}

/** A PR is "the" PR to open when nothing recorded it as merged or closed. */
export function latestUnmergedPR(prs: SessionPR[]): SessionPR | undefined {
  return prs.find((p) => !p.merged_at && !p.closed_at)
}

/** The header row's size: as loud as the Projects button, but short enough
 *  to sit on the title line without making it taller than it needs to be. */
const COMPACT = (cls: string) => cls.replace('py-2 min-h-[36px]', 'py-1 min-h-[30px]')

/**
 * Open repo and Open PR — the two buttons. They sit at the right end of the
 * session's title line (owner feedback, 2026-10-04: on a row of their own
 * they pushed the terminal down for nothing). On a narrow screen they wrap
 * under the title rather than squeeze it.
 */
export function RepoButtons({ repo, prs = [], cwd, className = '' }: { repo?: RepoLink; prs?: SessionPR[]; cwd: string; className?: string }) {
  const [copied, setCopied] = useState('')
  const pr = latestUnmergedPR(prs)
  const path = repo?.root || cwd
  const href = repo?.branch_url || repo?.url

  async function copy() {
    try {
      await navigator.clipboard.writeText(path)
      setCopied('copied')
    } catch {
      setCopied('select the path and copy it')
    }
    window.setTimeout(() => setCopied(''), 2000)
  }

  if (!href && !path && !pr) return null
  return (
    <div className={`flex flex-wrap items-center gap-2 min-w-0 ${className}`} aria-label="Repository">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={COMPACT(PRIMARY)}
          title={repo?.branch_url ? `${repo.url} — branch ${repo.branch}` : repo?.url}
        >
          Open repo ↗
        </a>
      ) : (
        path && (
          <span className="inline-flex items-center gap-2 min-w-0 max-w-full">
            <span className="mono text-[12px] text-fg-muted truncate" title={path}>{path}</span>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 text-[12px] rounded-sm border border-border px-2 py-1 text-fg-muted hover:text-fg"
              title="No git remote to link to: copy the local path"
            >
              {copied || 'Copy path'}
            </button>
          </span>
        )
      )}
      {pr && (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className={COMPACT(SECONDARY)} title={prLabel(pr)}>
          Open PR #{pr.number} ↗
        </a>
      )}
    </div>
  )
}

/** The latest pull requests, newest first, the rest behind "+N more". */
export function RecentPRs({ prs = [], className = '' }: { prs?: SessionPR[]; className?: string }) {
  const [all, setAll] = useState(false)
  if (prs.length === 0) return null
  const shown = all ? prs : prs.slice(0, MAX_SHOWN)
  return (
    <span className={`flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 text-[12px] ${className}`} aria-label="Pull requests">
      {shown.map((p) => (
        <a
          key={p.url}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-baseline gap-1 max-w-[22rem] min-w-0 text-fg-muted hover:text-accent"
          title={prLabel(p)}
        >
          <span className="truncate">{prLabel(p)}</span>
          {p.merged_at ? <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-ok">merged</span> : null}
          {!p.merged_at && p.closed_at ? <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-fg-faint">closed</span> : null}
          <span aria-hidden className="shrink-0">↗</span>
        </a>
      ))}
      {prs.length > MAX_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-fg-faint hover:text-fg" aria-expanded={all}>
          {all ? 'fewer' : `+${prs.length - MAX_SHOWN} more`}
        </button>
      )}
    </span>
  )
}

/** Both together, for a place with a row to spare. */
export function RepoLinks({ repo, prs = [], cwd }: { repo?: RepoLink; prs?: SessionPR[]; cwd: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RepoButtons repo={repo} prs={prs} cwd={cwd} />
      <RecentPRs prs={prs} />
    </div>
  )
}

/** The Projects row's version: the repository and its latest PR, compact. */
export function ProjectRepoLinks({ url, pr }: { url?: string; pr?: SessionPR }) {
  if (!url && !pr) return null
  return (
    <>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className={SECONDARY} title={url}>
          Open repo ↗
        </a>
      )}
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center min-h-[36px] text-[12px] text-fg-muted hover:text-accent whitespace-nowrap"
          title={prLabel(pr)}
        >
          last PR #{pr.number}
          {pr.merged_at ? ' · merged' : ''} ↗
        </a>
      )}
    </>
  )
}
