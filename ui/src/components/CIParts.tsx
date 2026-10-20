/**
 * Small parts the CI views share (the Pipeline page, the inspector's CI
 * block): a job's state mark, the grey rows of a first read, the Pipeline's
 * way there and back (⌘P), and connecting GitHub in one click. They lived
 * in the session deck until it was removed (2026-10-20).
 */
import type { CITone } from '@/lib/ci'
import { githubApi } from '@/lib/github'
import { PIPELINE_KEY, keys } from '@/lib/appkeys'

const CI_TEXT: Record<CITone, string> = {
  running: 'text-warn', queued: 'text-fg-faint', pass: 'text-ok', fail: 'text-danger', skipped: 'text-fg-faint',
}

/** A job's or a step's state as a mark: a turning ring while it runs. */
export function CIMark({ tone }: { tone: CITone }) {
  if (tone === 'running') return <span role="img" aria-label="running" className="ci-spin inline-block h-[9px] w-[9px] shrink-0 rounded-full" />
  const mark = tone === 'pass' ? '✓' : tone === 'fail' ? '✗' : tone === 'queued' ? '○' : '–'
  return <span role="img" aria-label={tone === 'pass' ? 'passed' : tone === 'fail' ? 'failed' : tone} className={`w-[9px] shrink-0 text-center text-[11px] leading-none ${CI_TEXT[tone]}`}>{mark}</span>
}

/** Three grey rows in the shape of the list: the first read ever of a view. */
export function DeckSkeleton({ label }: { label: string }) {
  return (
    <ul data-deck-skeleton aria-busy="true" aria-label={label} className="-mx-1 flex flex-col gap-[5px] px-1 pt-1">
      {[0.62, 0.48, 0.55].map((w, i) => (
        <li key={i} aria-hidden className="flex h-[14px] items-center gap-2 animate-pulse motion-reduce:animate-none">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-[var(--app-hairline)]" />
          <span className="h-[8px] w-[28px] shrink-0 rounded-[3px] bg-[var(--app-hairline)]" />
          <span className="h-[8px] rounded-[3px] bg-[var(--app-hairline)]" style={{ width: `${w * 100}%` }} />
          <span className="ml-auto h-[8px] w-[64px] shrink-0 rounded-[3px] bg-[var(--app-hairline)]" />
        </li>
      ))}
    </ul>
  )
}

/** The Pipeline page's way back (`collapse`: *Back*, to the tab or screen
 *  ⌘P was pressed on), or a way there (*Pipeline*), both ⌘P (Ctrl+Shift+P
 *  off macOS; ⇧⌘B, its key until 2026-10-15, still works). `compact`: the
 *  key in the tooltip only. */
export function ExpandToggle({ collapse, onClick, compact }: { collapse?: boolean; onClick: () => void; compact?: boolean }) {
  const k = keys(PIPELINE_KEY)
  return (
    <button
      type="button"
      data-deck-expand={collapse ? undefined : ''}
      data-prs-back={collapse ? '' : undefined}
      onClick={onClick}
      aria-label={collapse ? `Back to where you were (${k})` : `Open the Pipeline: every pull request on its way to a release, in its own tab (${k})`}
      title={collapse
        ? `Back to where you were; ${k} opens the Pipeline again`
        : `The Pipeline: every pull request of the repository on its way — open, CI, merged, released — in its own tab (${k})`}
      className={compact
        ? 'flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] px-1 text-[10.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-accent'
        : 'flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] border border-accent/60 px-2 text-[12px] font-medium text-accent hover:bg-accent/10'}
    >
      <ExpandIcon back={collapse} /> {collapse ? 'Back' : 'Pipeline'} {!compact && <kbd aria-hidden className="app-kbd-key">{k}</kbd>}
    </button>
  )
}

/** Two arrows out to the corners: the large view. */
export function ExpandIcon({ back }: { back?: boolean }) {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {back ? <path d="M6 2v4H2M10 14v-4h4M6 6 2 2M10 10l4 4" /> : <path d="M10 2h4v4M6 14H2v-4M14 2 9 7M2 14l5-5" />}
    </svg>
  )
}

/**
 * One click turns the GitHub integration on through the GitHub CLI's own
 * login (ADR-047: off until the user turns it on; this button is that).
 * Without a usable `gh`, Settings is where a token goes. True when connected.
 */
export async function connectGitHub(): Promise<boolean> {
  try {
    const st = await githubApi.connect('gh')
    if (st.connected) return true
  } catch { /* Settings says why */ }
  location.hash = '#/settings'
  return false
}

