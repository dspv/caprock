/**
 * The phone home's *Releases* section (.ai/04-ui.md § The phone home; owner,
 * 2026-10-15, translated: "In the mobile app I want to see my releases'
 * progress bars, to understand what's going on"): one repository's next
 * version and its rows, each with a four-step bar and its stage word — the
 * release plan the Pipeline, the right panel and Work → Release draw
 * (components/ReleasePlan, `phone`), not a copy of it. A row opens its pull
 * request on GitHub, an agent's row its session's chat; a chip picks the repository when there are several.
 *
 * What it reads, and when — a phone pays for every byte, so no timer:
 *
 * - `GET /v1/work` (useWork) once on opening, again on release news only (a
 *   live `github` frame, or `reset`), and on a pull or *Refresh*.
 * - The picked repository's Pipeline answer (`GET /v1/sessions/{id}/ci/stats`,
 *   through the session the Work answer names for it) at the same moments,
 *   drawn at once from the answer kept for it (lib/deckCache) while it is
 *   asked again. While the daemon says a newer answer is being composed
 *   (`refreshing`) it is asked again a few times, REFRESHING_MS apart — a
 *   local read, nothing asked of GitHub — and then left alone.
 *
 * Both are on a paired device's allowlist (lanauth.go), so the relay's
 * phone reads them through the same end-to-end channel as the rest.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type SessionCIStats, type WorkRepo } from '@/lib/api'
import { readDeck, writeDeck } from '@/lib/deckCache'
import { live } from '@/lib/live'
import { onPageVisibility, pageHidden } from '@/lib/visible'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { planForRepo } from '@/lib/releaseplan'
import { changesRelease, useWork } from '@/lib/useWork'
import { keepStats } from './PipelineView'
import { ReleasePlan } from './ReleasePlan'
import { ChipSelect, SectionLabel } from './PhoneParts'

/** The repository last picked here. */
export const RELEASE_REPO_KEY = 'caprock.phone.releaseRepo'
/** How soon an answer the daemon is still composing is asked again, and how many times. */
export const REFRESHING_MS = 1_500
export const REFRESHING_TRIES = 3
/** Release news arrives in bursts (one frame per pull request moved): one read for a burst. */
const NEWS_MS = 1_000

function readRepo(): string {
  try { return localStorage.getItem(RELEASE_REPO_KEY) ?? '' } catch { return '' }
}

/**
 * The repository to show: the one picked last while it is still listed, else
 * the first on GitHub in the board's order (the one with agents running
 * first), else the first.
 */
export function pickRepo(repos: readonly WorkRepo[], picked: string): WorkRepo | undefined {
  return repos.find((r) => r.root === picked) ?? repos.find((r) => !!r.remote) ?? repos[0]
}

interface StatsRead { d?: SessionCIStats; at: number; failed?: string }

/**
 * One repository's Pipeline answer, read when the repository is picked, on
 * `pull`, and on release news; never on a timer (see the file's comment).
 */
export function useReleaseStats(repo: WorkRepo | undefined, pull: number): StatsRead {
  const key = repo ? `stats:${repo.root}` : undefined
  const [read, setRead] = useState<StatsRead & { key?: string }>(() => ({ key, ...(readDeck<SessionCIStats>(key) ?? { at: 0 }) }))
  const shown: StatsRead = read.key === key ? read : { ...(readDeck<SessionCIStats>(key) ?? { at: 0 }) }
  const shownRef = useRef(shown)
  shownRef.current = shown
  const via = repo?.via_session
  useEffect(() => {
    if (!key || !via) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    let missed = false
    const ask = async () => {
      if (pageHidden()) { missed = true; return }
      missed = false
      try {
        const d = await api.sessionCIStats(via)
        if (!alive) return
        const prev = shownRef.current.d
        if (prev && keepStats(prev, d)) {
          setRead({ key, d: prev, at: shownRef.current.at, failed: d.error?.message ?? 'GitHub did not answer' })
        } else {
          writeDeck(key, d)
          setRead({ key, d, at: Date.now() })
        }
        if (d.refreshing && tries < REFRESHING_TRIES) { tries++; timer = setTimeout(() => void ask(), REFRESHING_MS) }
      } catch (e) {
        if (alive) setRead((r) => ({ ...(r.key === key ? r : shownRef.current), key, failed: errText(e) }))
      }
    }
    void ask()
    let news: ReturnType<typeof setTimeout> | undefined
    const offFrame = live.onFrame((f) => {
      if (!changesRelease(f) || news) return
      news = setTimeout(() => { news = undefined; tries = 0; void ask() }, NEWS_MS)
    })
    const offVis = onPageVisibility((hidden) => { if (!hidden && missed) void ask() })
    return () => { alive = false; offFrame(); offVis(); if (timer) clearTimeout(timer); if (news) clearTimeout(news) }
  }, [key, via, pull])
  return shown
}

/** The section: drawn once the Work answer names a repository; nothing on a daemon that refuses it. */
export function PhoneReleases({ pull }: { pull: number }) {
  const work = useWork({ changes: changesRelease })
  const [tapped, setTapped] = useState(0)
  const asked = pull + tapped
  const refreshWork = work.refresh
  // A pull or a tap reads the Work answer again too; the first read is useWork's own.
  useEffect(() => { if (asked > 0) refreshWork() }, [asked, refreshWork])
  const repos = useMemo(() => work.data?.repos ?? [], [work.data])
  const [picked, setPicked] = useState(readRepo)
  const repo = pickRepo(repos, picked)
  const stats = useReleaseStats(repo, asked)
  const now = useNow(60_000)
  const plan = useMemo(() => (repo ? planForRepo(work.data, repo.root, stats.d, now) : undefined), [work.data, repo, stats.d, now])

  if (!work.data && work.error) return null
  if (work.data && !repo) return null
  const pick = (root: string) => {
    setPicked(root)
    try { localStorage.setItem(RELEASE_REPO_KEY, root) } catch { /* this phone only */ }
  }
  const empty = !plan || (plan.rows.length === 0 && plan.later.length === 0)
  return (
    <section aria-label="Releases" data-phone-releases>
      <SectionLabel right={repos.length > 1 && repo && (
        <ChipSelect label="Repository" value={repo.root} onChange={pick} className="max-w-[60vw]"
          options={repos.map((r) => ({ value: r.root, label: r.name }))} />
      )}>Releases</SectionLabel>
      <div className="overflow-hidden rounded-[12px] border border-border bg-panel">
        {!plan ? (
          <div className="px-3 py-4 text-[14px] text-fg-muted">Reading your releases…</div>
        ) : (
          <div className={`px-3 pt-3 ${empty ? 'pb-3' : ''}`}>
            <ReleasePlan plan={plan} phone showRepo={repos.length <= 1}
              empty="Nothing merged since the last tag, no pull request open and no agent at work here." />
          </div>
        )}
        <div className="flex min-h-11 items-center gap-2 border-t border-border pl-3 text-[12px] text-fg-faint">
          <span data-release-read className="min-w-0 truncate">{readLine(stats, repo, now)}</span>
          <button type="button" onClick={() => setTapped((n) => n + 1)} className="ml-auto min-h-11 shrink-0 px-3 text-[13px] text-accent">Refresh</button>
        </div>
      </div>
    </section>
  )
}

/** Where the rows come from, and how old they are. */
function readLine(s: StatsRead, repo: WorkRepo | undefined, now: number): string {
  if (s.failed) return `Not refreshed: ${s.failed}`
  if (s.d && !s.d.connected) return 'GitHub not connected on your Mac: agents only'
  if (s.d) return `Pull requests from GitHub, read ${fmtAgo(s.d.read_at || s.at, now)}`
  return repo?.remote ? 'Reading pull requests…' : 'Agents on this machine'
}
