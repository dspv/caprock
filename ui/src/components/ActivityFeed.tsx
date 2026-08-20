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
import { useEffect, useRef, useState } from 'react'
import { api, type SessionSummary } from '@/lib/api'
import { live } from '@/lib/live'
import { pushItem, toFeedItem, type FeedItem } from '@/lib/feed'
import { fmtAgo, shortId } from '@/lib/format'
import { Panel } from '@/components/ui'
import { href } from '@/lib/router'

export function ActivityFeed({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
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
        const seen = new Set(cur.map((i) => i.id))
        return [...cur, ...seeded.filter((i) => !seen.has(i.id))]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 60)
      })
    })()
    return () => { cancelled = true }
    // Seeding once is the point — later updates arrive over the WS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length > 0])

  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type !== 'event' || pausedRef.current) return
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
          Nothing yet — start <span className="mono">claude</span> in any terminal.
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {items.map((it) => (
            <Row key={it.id} it={it} now={now} project={projects.current.get(it.sessionId)} />
          ))}
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
