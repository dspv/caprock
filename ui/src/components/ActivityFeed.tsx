/**
 * ActivityFeed — one column showing what every session on the machine is doing,
 * newest first. This is the "it's actually alive" surface: a session list tells
 * you what exists, the feed tells you what is happening.
 *
 * Seeded from recent history so it is never empty on open, then fed by the live
 * WebSocket. Events we cannot phrase usefully are dropped (see lib/feed.ts) —
 * a feed of raw event kinds is noise, and noise is what makes people stop
 * looking.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type SessionSummary } from '@/lib/api'
import { live } from '@/lib/live'
import { pushItem, toFeedItem, type FeedItem } from '@/lib/feed'
import { fmtAgo, shortId } from '@/lib/format'
import { Panel } from '@/components/ui'
import { href } from '@/lib/router'

export function ActivityFeed({ sessions, now, emptyHint }: { sessions: SessionSummary[]; now: number; emptyHint?: ReactNode }) {
  const [items, setItems] = useState<FeedItem[]>([])
  const [paused, setPaused] = useState(false)
  // Held in a ref so the WS subscription never re-subscribes when sessions load.
  const projects = useRef(new Map<string, string>())
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  for (const s of sessions) if (s.project) projects.current.set(s.session_id, s.project)

  // Seed from history so the panel has content the moment it opens.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Seed from the most recently active sessions whether or not they are
      // still running: on a quiet machine every session is "ended", and an
      // empty feed reads as broken rather than as a calm morning.
      const recent = [...sessions]
        .sort((a, b) => b.last_event_at - a.last_event_at)
        .slice(0, 4)
      const batches = await Promise.all(
        recent.map((s) => api.events(s.session_id, 0, 60).catch(() => [] as never[])),
      )
      if (cancelled) return
      const seeded = batches
        .flat()
        .map((e) => toFeedItem(e))
        .filter((x): x is FeedItem => x !== null)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 40)
      // Merge rather than skip: a live frame usually lands before this
      // resolves, and dropping the seed on that basis left the feed showing a
      // single line with all the history discarded.
      setItems((cur) => {
        // Drop anything from a session that is no longer in scope: a filter
        // change must clear the other agent's rows rather than merge around
        // them.
        const inScope = new Set(recent.map((s) => s.session_id))
        const kept = cur.filter((i) => !i.sessionId || inScope.has(i.sessionId))
        const seen = new Set(kept.map((i) => i.id))
        return [...kept, ...seeded.filter((i) => !seen.has(i.id))]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 60)
      })
    })()
    return () => { cancelled = true }
    // Seeding once was the point — later updates arrive over the WS. It now
    // also re-seeds when the set of sessions changes, which is what an agent
    // filter does: without it the panel kept the previous agent's history and
    // only new frames obeyed the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.map((s) => s.session_id).join(',')])

  // Which sessions this feed is allowed to show. A live frame carries no
  // agent, only a session id, so the filter has to be applied by membership —
  // without it a filtered feed refills with the other agent's events within
  // seconds and silently contradicts the panel beside it.
  const allowed = useRef(new Set<string>())
  allowed.current = new Set(sessions.map((s) => s.session_id))

  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type !== 'event' || pausedRef.current) return
      const id = (f.data as { session_id?: string })?.session_id
      // An unknown id is shown: it is a session that started after this list
      // was fetched, and hiding new work is worse than briefly showing one
      // that a filter would have excluded.
      if (id && projects.current.has(id) && !allowed.current.has(id)) return
      const item = toFeedItem(f.data)
      if (item) setItems((cur) => pushItem(cur, item))
    })
  }, [])

  return (
    <Panel
      title="Live activity"
      right={
        <button
          onClick={() => setPaused((v) => !v)}
          className="text-[11px] mono text-fg-faint hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
        >
          {paused ? 'resume' : 'pause'}
        </button>
      }
    >
      {items.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-fg-muted">
          {/* Under an agent filter this is "nothing from that agent", not
            * "nothing at all" — and telling someone to start `claude` when
            * they filtered for OpenCode is advice for the wrong program. */}
          {emptyHint ?? (
            <>Nothing yet — start <span className="mono">claude</span> in any terminal.</>
          )}
        </div>
      ) : (
        // A fade at the bottom edge, so a list that continues looks like one.
        // With the scrollbar hidden and the last row cut off square, a feed
        // with fifty more entries below looked exactly like a feed that had
        // ended — the reader has no way to tell without trying to scroll. The
        // gradient sits above the content and ignores pointer events, so it
        // hints without taking a click.
        <div className="relative">
          <div className="max-h-[420px] overflow-y-auto">
          {items.map((it) => (
            <Row key={it.id} it={it} now={now} project={projects.current.get(it.sessionId)} />
          ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-panel to-transparent" />
        </div>
      )}
    </Panel>
  )
}

function toneClass(tone: FeedItem['tone']): string {
  switch (tone) {
    case 'ok': return 'text-ok'
    case 'warn': return 'text-warn'
    case 'danger': return 'text-danger'
    default: return 'text-fg-faint'
  }
}

function Row({ it, now, project }: { it: FeedItem; now: number; project?: string }) {
  return (
    <a
      href={href({ name: 'session', id: it.sessionId })}
      className="grid grid-cols-[auto_auto_1fr_auto] items-baseline gap-2 px-3 py-1 border-t border-border first:border-t-0 hover:bg-panel-2 no-underline text-fg"
    >
      <span className={`mono text-[12px] w-3 text-center ${toneClass(it.tone)}`}>{it.icon}</span>
      <span className="mono text-[11px] text-fg-muted truncate max-w-[12ch]">
        {project ?? it.project ?? shortId(it.sessionId)}
      </span>
      <span className="text-[12px] truncate">
        <span className="text-fg-muted">{it.text}</span>
        {it.detail && <span className="mono text-fg ml-1.5">{it.detail}</span>}
      </span>
      <span className="num text-[11px] text-fg-faint">{fmtAgo(it.ts, now)}</span>
    </a>
  )
}
