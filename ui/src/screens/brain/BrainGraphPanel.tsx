/**
 * The side of the opened graph (04-ui.md § Second Brain, *The graph
 * opened*): what the node under the pointer or opened is, else what the
 * whole graph holds. Every figure is a count of the graph read on screen.
 *
 * - **Nothing in focus** — the counts (memories, topics, projects, links),
 *   the projects as the graph colours them, each a filter, the newest
 *   memories, and how to read the picture.
 * - **A project or a topic** — what it holds: how many memories, from how
 *   many sessions, the newest; its latest memories (each opens), the
 *   sessions they came from (each a link to the session) and *Open*: a
 *   project's memories on the screen, a topic searched there.
 * - **A memory under the pointer** — a peek: kind, project, title, when and
 *   from which session; a click opens it in full (BrainDetail).
 */
import type { BrainGraph, BrainNode } from '@/lib/api'
import { isEntity, KIND_COLOR, KIND_LABEL } from '@/lib/brain'
import { entityView, type GraphIndex } from '@/lib/brainview'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { href } from '@/lib/router'
import { BrainDetail } from './BrainDetail'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Swatch({ color, size = 9, ring = false }: { color: string; size?: number; ring?: boolean }) {
  return (
    <span aria-hidden className={`inline-block shrink-0 rounded-full ${ring ? 'ring-2 ring-[color-mix(in_srgb,var(--color-fg)_18%,transparent)]' : ''}`}
      style={{ width: size, height: size, background: color }} />
  )
}

function Heading({ children }: { children: string }) {
  return <p className="text-[12px] font-semibold text-fg-faint">{children}</p>
}

function MemoryRow({ n, now, onSelect }: { n: BrainNode; now: number; onSelect: (id: number) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(n.id)} data-brain-panel-memory={n.id}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-[6px] px-1.5 py-1 text-left hover:bg-panel-2">
        <span aria-hidden className="inline-block h-[7px] w-[7px] translate-y-[-1px] rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
        <span className="truncate text-[12.5px] text-fg" title={n.title}>{n.title}</span>
        <span className="num shrink-0 text-[11px] text-fg-faint">{fmtAgo(n.created_at, now)}</span>
      </button>
    </li>
  )
}

export function BrainGraphPanel({ graph, idx, focus, selected, project, onSelect, onProject, onOpenProject, onOpenTopic, editable, now }: {
  graph: BrainGraph
  idx: GraphIndex
  /** The node under the pointer, else the opened one. */
  focus?: number
  selected?: number
  /** The project the graph is filtered to ('' none). */
  project: string
  onSelect: (id: number | undefined) => void
  onProject: (name: string) => void
  onOpenProject: (name: string) => void
  onOpenTopic: (title: string) => void
  editable: boolean
  now: number
}) {
  const node = focus !== undefined ? idx.byId.get(focus) : undefined
  let body
  if (!node) {
    body = <Overview graph={graph} idx={idx} project={project} onProject={onProject} onSelect={onSelect} now={now} />
  } else if (isEntity(node.kind)) {
    body = <Entity graph={graph} idx={idx} node={node} onSelect={onSelect} onOpenProject={onOpenProject} onOpenTopic={onOpenTopic} now={now}
      onClose={selected === node.id ? () => onSelect(undefined) : undefined} />
  } else if (selected === node.id) {
    return (
      <BrainDetail key={node.id} id={node.id} onSelect={onSelect} onClose={() => onSelect(undefined)} editable={editable}
        className="!static grid max-h-none min-h-0 w-full overflow-y-auto" />
    )
  } else {
    body = <Peek idx={idx} node={node} now={now} />
  }
  return (
    <aside aria-label="About the graph" data-brain-graph-panel={node ? (isEntity(node.kind) ? 'entity' : 'peek') : 'overview'}
      className="grid min-h-0 w-full content-start gap-3 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-panel p-3 [&>*]:min-w-0">
      {body}
    </aside>
  )
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="grid gap-0" data-brain-figure={label}>
      <span className="num text-[22px] font-semibold leading-tight tracking-[-0.01em] text-fg">{value.toLocaleString('en-US')}</span>
      <span className="text-[11.5px] text-fg-muted">{label}</span>
    </div>
  )
}

function Overview({ graph, idx, project, onProject, onSelect, now }: {
  graph: BrainGraph; idx: GraphIndex; project: string; onProject: (name: string) => void; onSelect: (id: number) => void; now: number
}) {
  const newest = graph.nodes.filter((n) => !isEntity(n.kind)).sort((a, b) => b.created_at - a.created_at).slice(0, 5)
  const max = idx.projects[0]?.memories ?? 1
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2" data-brain-figures-graph>
        <Figure value={idx.memories} label={idx.memories === 1 ? 'memory' : 'memories'} />
        <Figure value={idx.topics} label={idx.topics === 1 ? 'topic' : 'topics'} />
        <Figure value={idx.projects.length} label={idx.projects.length === 1 ? 'project' : 'projects'} />
        <Figure value={idx.links} label={idx.links === 1 ? 'link' : 'links'} />
      </div>
      {graph.total > idx.memories && (
        <p className="text-[11.5px] text-fg-muted">The newest {idx.memories.toLocaleString('en-US')} of {graph.total.toLocaleString('en-US')} memories are drawn.</p>
      )}
      {idx.projects.length > 0 && (
        <div className="grid gap-1">
          <Heading>Projects</Heading>
          <ul className="grid gap-0.5" aria-label="Projects in the graph">
            {idx.projects.slice(0, 10).map((p) => (
              <li key={p.name}>
                <button type="button" onClick={() => onProject(project === p.name ? '' : p.name)} aria-pressed={project === p.name}
                  title={project === p.name ? 'Show every project' : `Pick out ${p.name} in the graph`} data-brain-project-chip={p.name}
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[6px] px-1.5 py-1 text-left ${project === p.name ? 'bg-accent/[0.09]' : 'hover:bg-panel-2'}`}>
                  <Swatch color={p.color} ring={project === p.name} />
                  <span className="truncate text-[12.5px] text-fg">{p.name}</span>
                  <span className="num text-[11.5px] text-fg-muted">{p.memories}</span>
                  <span aria-hidden className="col-start-2 col-end-4 mt-0.5 h-[2px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_14%,transparent)]">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.round((p.memories / max) * 100))}%`, background: p.color }} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {idx.projects.length > 10 && <p className="px-1.5 text-[11.5px] text-fg-muted">and {idx.projects.length - 10} more, in grey</p>}
        </div>
      )}
      {newest.length > 0 && (
        <div className="grid gap-1">
          <Heading>Newest</Heading>
          <ul className="grid gap-0">
            {newest.map((n) => <MemoryRow key={n.id} n={n} now={now} onSelect={onSelect} />)}
          </ul>
        </div>
      )}
      <div className="grid gap-1.5 border-t border-border pt-2.5 text-[11.5px] text-fg-muted" data-brain-legend>
        <Heading>Reading it</Heading>
        <span className="flex items-center gap-2"><Swatch color="var(--color-fg)" size={4} /> a memory · <Swatch color="var(--color-fg)" size={6} /> a topic · <Swatch color="var(--color-fg)" size={9} /> a project</span>
        <span>The colour is the project; a hub grows with its links.</span>
        <span>Hover a dot for what it holds; click the graph to zoom and move it.</span>
      </div>
    </>
  )
}

function Entity({ graph, idx, node, onSelect, onOpenProject, onOpenTopic, onClose, now }: {
  graph: BrainGraph; idx: GraphIndex; node: BrainNode; onSelect: (id: number) => void
  onOpenProject: (name: string) => void; onOpenTopic: (title: string) => void; onClose?: () => void; now: number
}) {
  const v = entityView(graph, idx, node.id)
  const color = idx.colorOf.get(node.id) ?? 'var(--color-fg)'
  const project = node.kind === 'project'
  const newest = v.memories[0]?.created_at
  return (
    <>
      <div className="grid gap-1">
        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
          <Swatch color={color} />
          {KIND_LABEL[node.kind]}{node.vault && ` · Obsidian · ${node.vault}`}
          {!project && idx.projectOf.get(node.id) && <span className="truncate">· mostly {idx.projectOf.get(node.id)}</span>}
          {onClose && <button type="button" onClick={onClose} className="ml-auto text-[11.5px] text-fg-faint hover:text-fg" aria-label="Let it go">×</button>}
        </span>
        <h3 className="text-[16px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]" data-brain-panel-title>{node.title}</h3>
        <p className="text-[12px] text-fg-muted" data-brain-panel-figures>
          {plural(v.memories.length, 'memory', 'memories')}
          {v.sessions.length > 0 && ` · from ${plural(v.sessions.length, 'session', 'sessions')}`}
          {newest && ` · newest ${fmtAgo(newest, now)}`}
        </p>
      </div>
      <button type="button" data-brain-panel-open
        onClick={() => (project ? onOpenProject(node.title) : onOpenTopic(node.title))}
        className="justify-self-start rounded-[7px] bg-accent px-2.5 py-1 text-[12.5px] font-medium text-panel hover:bg-accent-strong">
        {project ? `Open ${node.title}’s memories` : 'Open its memories'}
      </button>
      {v.memories.length > 0 && (
        <div className="grid gap-1">
          <Heading>Latest</Heading>
          <ul className="grid gap-0">
            {v.memories.slice(0, 6).map((n) => <MemoryRow key={n.id} n={n} now={now} onSelect={onSelect} />)}
          </ul>
        </div>
      )}
      {project && v.topics.length > 0 && (
        <div className="grid gap-1">
          <Heading>Topics</Heading>
          <p className="flex flex-wrap gap-1">
            {v.topics.slice(0, 8).map((t) => (
              <button key={t.node.id} type="button" onClick={() => onSelect(t.node.id)}
                className="rounded-full border border-border px-2 py-[1px] text-[11.5px] text-fg-muted hover:border-border-strong hover:text-fg">
                {t.node.title} <span className="num text-fg-faint">{t.memories}</span>
              </button>
            ))}
          </p>
        </div>
      )}
      {v.sessions.length > 0 && (
        <div className="grid gap-1">
          <Heading>From sessions</Heading>
          <ul className="grid gap-0" data-brain-panel-sessions>
            {v.sessions.slice(0, 5).map((s) => (
              <li key={s.id}>
                <a className="flex items-baseline gap-2 rounded-[6px] px-1.5 py-1 text-[12.5px] hover:bg-panel-2" href={href({ name: 'session', id: s.id, at: s.ts || undefined })}
                  title="Open the session at its last memory here">
                  <span className="min-w-0 flex-1 truncate text-fg">{fmtWhen(s.ts, now)}</span>
                  <span className="num shrink-0 text-[11.5px] text-fg-muted">{plural(s.memories, 'memory', 'memories')}</span>
                </a>
              </li>
            ))}
          </ul>
          {v.sessions.length > 5 && <p className="px-1.5 text-[11.5px] text-fg-muted">and {v.sessions.length - 5} more</p>}
        </div>
      )}
    </>
  )
}

function Peek({ idx, node, now }: { idx: GraphIndex; node: BrainNode; now: number }) {
  const project = idx.projectOf.get(node.id)
  const src = node.source
  return (
    <div className="grid gap-1.5">
      <span className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
        <span aria-hidden className="inline-block h-[8px] w-[8px] rounded-full" style={{ background: KIND_COLOR[node.kind] }} />
        {KIND_LABEL[node.kind]}{node.vault && ` · Obsidian · ${node.vault}`}
        {project && <><span>·</span><Swatch color={idx.colorOf.get(node.id) ?? 'var(--color-fg)'} size={7} /><span className="truncate">{project}</span></>}
      </span>
      <h3 className="text-[15px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]" data-brain-panel-title>{node.title}</h3>
      <p className="text-[12px] text-fg-muted">
        Kept {fmtAgo(node.created_at, now)}
        {src.session_id ? <> · <a className="link" href={href({ name: 'session', id: src.session_id, at: src.ts || undefined })}>open the session</a></> : node.manual ? ' · typed in by hand' : ''}
      </p>
      <p className="text-[11.5px] text-fg-faint">Click the dot to open it.</p>
    </div>
  )
}
