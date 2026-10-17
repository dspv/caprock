/**
 * Second Brain's graph, read for the opened graph (04-ui.md § Second Brain,
 * *The graph opened*): which project each node belongs to and its colour,
 * the projects by size, what a project or a topic holds, and which nodes a
 * search or a project picks out. Pure functions over one graph read: every
 * figure is a count of what the daemon returned, nothing estimated.
 */
import type { BrainGraph, BrainNode } from './api'
import { isEntity } from './brain'
import { foldSearch } from './brainsearch'

/**
 * The projects' colours, biggest project first: hues mixed with the muted
 * ink like the memory kinds (design/tokens.css), so every
 * palette draws its own. Past these, a project is drawn in OTHER_COLOR.
 */
export const PROJECT_COLORS = [
  'color-mix(in srgb, #4f9fe0 80%, var(--color-fg-muted))',
  'color-mix(in srgb, var(--color-ok) 82%, var(--color-fg-muted))',
  'color-mix(in srgb, var(--color-merged) 82%, var(--color-fg-muted))',
  'color-mix(in srgb, #2fb3a6 80%, var(--color-fg-muted))',
  'color-mix(in srgb, #d0679d 80%, var(--color-fg-muted))',
  'color-mix(in srgb, #a3b23a 80%, var(--color-fg-muted))',
  'color-mix(in srgb, #e0a040 80%, var(--color-fg-muted))',
]
/** A project past the named colours, and a node with no project. */
export const OTHER_COLOR = 'color-mix(in srgb, var(--color-fg) 72%, transparent)'

export interface ProjectInfo {
  name: string
  color: string
  /** Memories of it in this read. */
  memories: number
  /** Its project node, when the read has one. */
  nodeId?: number
}

export interface GraphIndex {
  byId: Map<number, BrainNode>
  /** Each node's neighbours, by id. */
  near: Map<number, number[]>
  /** Each node's project ('' when none): a memory's source, else the project it is part of; a topic's, the one most of its memories are in. */
  projectOf: Map<number, string>
  /** Each node's colour (a CSS colour), by its project. */
  colorOf: Map<number, string>
  /** Projects with memories, most first. */
  projects: ProjectInfo[]
  memories: number
  topics: number
  people: number
  links: number
}

function bump(m: Map<string, number>, k: string) { m.set(k, (m.get(k) ?? 0) + 1) }

export function indexGraph(g: BrainGraph): GraphIndex {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const))
  const near = new Map<number, number[]>()
  const add = (a: number, b: number) => {
    const l = near.get(a)
    if (l) l.push(b)
    else near.set(a, [b])
  }
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue
    add(e.from, e.to)
    add(e.to, e.from)
  }
  const projectOf = new Map<number, string>()
  const projectNode = new Map<string, number>()
  for (const n of g.nodes) {
    if (n.kind === 'project') { projectOf.set(n.id, n.title); projectNode.set(n.title, n.id) }
  }
  let memories = 0
  let topics = 0
  let people = 0
  const counts = new Map<string, number>()
  for (const n of g.nodes) {
    if (n.kind === 'topic') topics++
    if (n.kind === 'person') people++
    if (isEntity(n.kind)) continue
    memories++
    let p = n.source.project ?? ''
    if (!p) {
      const hub = (near.get(n.id) ?? []).map((id) => byId.get(id)).find((m) => m?.kind === 'project')
      p = hub?.title ?? ''
    }
    projectOf.set(n.id, p)
    if (p) bump(counts, p)
  }
  // A topic or a person: the project most of its memories are in.
  for (const n of g.nodes) {
    if (n.kind !== 'topic' && n.kind !== 'person') continue
    const tally = new Map<string, number>()
    for (const id of near.get(n.id) ?? []) {
      const p = projectOf.get(id)
      if (p && !isEntity(byId.get(id)!.kind)) bump(tally, p)
    }
    let best = ''
    let most = 0
    for (const [p, c] of tally) if (c > most || (c === most && p < best)) { best = p; most = c }
    projectOf.set(n.id, best)
  }
  const projects: ProjectInfo[] = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, m], i) => ({ name, memories: m, color: PROJECT_COLORS[i] ?? OTHER_COLOR, nodeId: projectNode.get(name) }))
  const colorByName = new Map(projects.map((p) => [p.name, p.color] as const))
  const colorOf = new Map<number, string>()
  for (const n of g.nodes) colorOf.set(n.id, colorByName.get(projectOf.get(n.id) ?? '') ?? OTHER_COLOR)
  const links = g.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).length
  return { byId, near, projectOf, colorOf, projects, memories, topics, people, links }
}

/**
 * The nodes a search and a project pick out, or null when neither is set.
 * A memory matches when every word of the search is in its title, project
 * or topics (folded as the daemon folds: any case or accent); an entity when
 * every word is in its name. A project keeps its own node, its memories and
 * the topics they hang off.
 */
export function pickNodes(g: BrainGraph, idx: GraphIndex, query: string, project: string): Set<number> | null {
  const words = foldSearch(query.trim()).split(/\s+/).filter(Boolean)
  if (words.length === 0 && !project) return null
  const out = new Set<number>()
  for (const n of g.nodes) {
    if (project && idx.projectOf.get(n.id) !== project) continue
    if (words.length > 0) {
      let hay = n.title
      if (!isEntity(n.kind)) {
        hay += ' ' + (idx.projectOf.get(n.id) ?? '')
        for (const id of idx.near.get(n.id) ?? []) {
          const m = idx.byId.get(id)
          if (m && m.kind === 'topic') hay += ' ' + m.title
        }
      }
      const f = foldSearch(hay)
      if (!words.every((w) => f.includes(w))) continue
    }
    out.add(n.id)
  }
  return out
}

export interface SessionInfo { id: string; ts: number; memories: number }

export interface EntityView {
  /** Its memories in this read, newest first. */
  memories: BrainNode[]
  /** The sessions they were taken from, newest first. */
  sessions: SessionInfo[]
  /** Topics linked to it (a project: its memories' topics), busiest first. */
  topics: { node: BrainNode; memories: number }[]
}

/** What a project, topic or person holds in this read. */
export function entityView(g: BrainGraph, idx: GraphIndex, id: number): EntityView {
  const n = idx.byId.get(id)
  if (!n) return { memories: [], sessions: [], topics: [] }
  const mems = n.kind === 'project'
    ? g.nodes.filter((m) => !isEntity(m.kind) && idx.projectOf.get(m.id) === n.title)
    : (idx.near.get(id) ?? []).map((x) => idx.byId.get(x)!).filter((m) => m && !isEntity(m.kind))
  mems.sort((a, b) => b.created_at - a.created_at)
  const sessions = new Map<string, SessionInfo>()
  const topicCount = new Map<number, number>()
  for (const m of mems) {
    const sid = m.source.session_id
    if (sid) {
      const s = sessions.get(sid)
      const ts = m.source.ts || m.created_at
      if (s) { s.memories++; s.ts = Math.max(s.ts, ts) }
      else sessions.set(sid, { id: sid, ts, memories: 1 })
    }
    for (const x of idx.near.get(m.id) ?? []) {
      if (x === id) continue
      if (idx.byId.get(x)?.kind === 'topic') topicCount.set(x, (topicCount.get(x) ?? 0) + 1)
    }
  }
  return {
    memories: mems,
    sessions: [...sessions.values()].sort((a, b) => b.ts - a.ts),
    topics: [...topicCount].sort((a, b) => b[1] - a[1]).map(([x, c]) => ({ node: idx.byId.get(x)!, memories: c })),
  }
}
