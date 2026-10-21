/**
 * Second Brain's hero (ADR-063): the agents this user actually runs, drawn
 * as the app's own characters (components/Characters — the duck or whichever
 * face Claude wears, Codex's terminal, Gemini's spark, OpenCode's
 * braces, DeepSeek's whale), around the brain made of a graph (BrainMark),
 * each linked to it by a line along which a pulse travels into the brain.
 * One picture for "all your agents feed one memory, and it is yours" (owner,
 * 2026-10-15, translated: "show the icons of what the user actually uses …
 * a shared, connected brain, plus yours").
 *
 * Who is drawn comes from usage, not a list of everything supported: the
 * agent split of the last 30 days that GET /v1/glance?range=30d already
 * answers (the daemon caches it for a minute), main threads and subagents
 * added together, most sessions first, up to five. Only agents that have a
 * character are drawn, so the names under the picture always match it.
 * Before anything is known — loading, a failure, a new install — it is
 * Claude Code alone.
 *
 * That is the pitch, shown before anything is built. Once reads happen, the
 * card's faces are the agents actually read (readFaces, below).
 *
 * Motion is CSS alone (BrainMark.css): each pulse is a dash of a path
 * normalised to length 1, its offset animated. Under prefers-reduced-motion
 * every pulse holds still halfway along its line.
 */
import { useEffect, useState } from 'react'
import { api, type BrainAutoStatus, type WeekAgent } from '@/lib/api'
import { useSessionFace } from '@/lib/faces'
import { agentName, Body, characterFor } from './Characters'
import { BrainMark } from './BrainMark'

/** The headline under the hero, in the banner and the dialog alike. */
export const BRAIN_HEADLINE = 'One memory for all your agents'

/** The agents with a character of their own, in the order a tie falls. */
const DRAWN = ['claude', 'codex', 'gemini', 'opencode', 'deepseek', 'hermes'] as const
export type DrawnAgent = (typeof DRAWN)[number]
const MAX = 5
/** The window "what you use" is read over. */
const RANGE = '30d'

/**
 * The agents to draw, from the agent split: summed per agent (a subagent row
 * is still that agent's work), most sessions first, then most turns, then
 * the fixed order. Claude Code alone when nothing was used.
 */
export function agentsUsed(rows: WeekAgent[] | undefined): DrawnAgent[] {
  const tally = new Map<DrawnAgent, { sessions: number; turns: number }>()
  for (const r of rows ?? []) {
    const a = DRAWN.find((d) => d === r.agent)
    if (!a || (r.sessions <= 0 && r.turns <= 0)) continue
    const t = tally.get(a) ?? { sessions: 0, turns: 0 }
    t.sessions += r.sessions
    t.turns += r.turns
    tally.set(a, t)
  }
  const out = [...tally.entries()]
    .sort(([a, x], [b, y]) => y.sessions - x.sessions || y.turns - x.turns || DRAWN.indexOf(a) - DRAWN.indexOf(b))
    .map(([a]) => a)
    .slice(0, MAX)
  return out.length ? out : ['claude']
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The line under the headline, built from the agents drawn. */
export function agentsLine(agents: string[]): string {
  const names = agents.map(agentName)
  return names.length > 1 ? `${nameList(names)} remember together.` : `${names[0] ?? 'Claude Code'} remembers across sessions.`
}

/** One agent whose sessions Second Brain read in the last 24 hours, for a face on its card. */
export interface ReadFace {
  agent: DrawnAgent
  /** Distinct sessions read in the last 24 hours. */
  sessions: number
  /** One of its sessions is being read right now. */
  now: boolean
  /** That session's title, while it is read. */
  reading?: string
}

/**
 * The faces on the Second Brain card: only agents whose sessions a read
 * went through in the last 24 hours (`auto.agents_24h`, from the reads
 * themselves — not what the user ran, which once drew Codex though Codex
 * had never fed it), plus the agent being read now, which glows. Most
 * sessions first; at most four; none when nothing was read.
 */
export function readFaces(auto: BrainAutoStatus | undefined): ReadFace[] {
  const out: ReadFace[] = []
  const nowAgent = auto?.reading ? auto.reading.agent || 'claude' : ''
  for (const r of auto?.agents_24h ?? []) {
    const a = DRAWN.find((d) => d === r.agent)
    if (!a || out.some((f) => f.agent === a)) continue
    out.push({ agent: a, sessions: r.sessions, now: a === nowAgent, reading: a === nowAgent ? auto?.reading?.title : undefined })
  }
  const a = DRAWN.find((d) => d === nowAgent)
  if (a && !out.some((f) => f.agent === a)) out.unshift({ agent: a, sessions: 0, now: true, reading: auto?.reading?.title })
  return out.slice(0, 4)
}

/** A face's tooltip, in plain words: *Codex: 2 sessions read in the last 24 hours · reading “Fix login” now*. */
export function faceWords(f: ReadFace): string {
  const name = agentName(f.agent)
  const parts = f.sessions > 0 ? [`${f.sessions} ${f.sessions === 1 ? 'session' : 'sessions'} read in the last 24 hours`] : []
  if (f.now) parts.push(f.reading ? `reading “${f.reading}” now` : 'reading a session now')
  return `${name}: ${parts.join(' · ')}`
}

/** The agents this user ran in the last 30 days (see the header). */
export function useAgentsUsed(): DrawnAgent[] {
  const [agents, setAgents] = useState<DrawnAgent[]>(['claude'])
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => api.glance(RANGE))
      .then((g) => { if (live) setAgents(agentsUsed(g?.agents)) }, () => { /* keep Claude Code */ })
    return () => { live = false }
  }, [])
  return agents
}

// The scene, in a 300x150 box: the brain in the middle, the agents on its
// two sides. Seats by how many there are, the most used first.
const W = 300
const H = 150
const R = 23
const L = 26
const RT = W - 26
const SEATS: Record<number, [number, number][]> = {
  1: [[L, 75]],
  2: [[L, 75], [RT, 75]],
  3: [[L, 40], [RT, 75], [L, 112]],
  4: [[L, 40], [RT, 40], [L, 112], [RT, 112]],
  5: [[L, 40], [RT, 75], [L, 112], [RT, 25], [RT, 125]],
}
const PULSE = ['var(--brain-idea)', 'var(--brain-decision)', 'var(--brain-finding)', 'var(--brain-question)']

/** From the agent's edge into the brain: level at both ends, an S between. */
function link([x, y]: [number, number]): string {
  const left = x < W / 2
  const sx = left ? x + R + 2 : x - R - 2
  const tx = left ? 104 : 196
  const ty = 75 + (y - 75) * 0.35
  const mx = (sx + tx) / 2
  return `M${sx} ${y}C${mx} ${y} ${mx} ${ty} ${tx} ${ty}`
}

export function BrainHero({ agents, className = '' }: { agents: DrawnAgent[]; className?: string }) {
  const claudeFace = useSessionFace(undefined)
  const shown = agents.slice(0, MAX)
  const seats = SEATS[shown.length] ?? SEATS[1]!
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`brain-hero block ${className}`} aria-hidden="true" data-brain-hero>
      <g className="brain-hero-links">
        {shown.map((a, i) => (
          <path key={a} d={link(seats[i]!)} />
        ))}
      </g>
      <BrainMark x={74} y={14} width={152} height={122} />
      {shown.map((a, i) => (
        <path key={a} d={link(seats[i]!)} pathLength={1} className="brain-hero-pulse"
          style={{ stroke: PULSE[i % PULSE.length], animationDelay: `${-i * 0.55}s` }} />
      ))}
      {shown.map((a, i) => {
        const [x, y] = seats[i]!
        return (
          <g key={a} data-brain-agent={a}>
            <circle cx={x} cy={y} r={R} className="brain-hero-seat" />
            <g transform={`translate(${x - 20.8} ${y - 22.6}) scale(0.52)`}>
              <Body who={characterFor(a)} face={a === 'claude' ? claudeFace : undefined} />
            </g>
          </g>
        )
      })}
    </svg>
  )
}

/** "Free", said plainly: an accent tint, not a fill (like Get premium's). */
export function FreePill({ className = '' }: { className?: string }) {
  return <span className={`brain-free ${className}`} data-brain-free>Free</span>
}
