/**
 * One memory, opened (#/brain): its summary, where it came from — the session
 * and the moment, a link that opens it there — what it is linked to, and the
 * means to rename, re-summarise, pin, link to a topic and delete it.
 */
import { useEffect, useState } from 'react'
import { api, errText, type BrainKind, type BrainLink, type BrainNode } from '@/lib/api'
import { isEntity, KIND_COLOR, KIND_LABEL, MEMORY_KINDS, useBrainFrames } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { href } from '@/lib/router'
import { CloseButton } from '@/components/Dialog'

const EDGE_WORD: Record<string, [string, string]> = {
  // [from this node, to this node]
  relates: ['related to', 'related to'],
  follows: ['follows', 'followed by'],
  contradicts: ['contradicts', 'contradicted by'],
  part_of: ['part of', 'includes'],
}

export function BrainDetail({ id, onSelect, onClose, editable, className = 'grid w-[360px]' }: {
  id: number
  onSelect: (id: number) => void
  onClose: () => void
  /** Writing the brain is the machine's; a paired device only reads. */
  editable: boolean
  /** Its display and width: beside the graph, or a column's whole width. */
  className?: string
}) {
  const [data, setData] = useState<{ node: BrainNode; links: BrainLink[] } | null>(null)
  const [error, setError] = useState('')
  const [gone, setGone] = useState(false)
  const load = () => {
    api.brainNode(id).then((d) => { setData(d); setError('') }, (e: unknown) => {
      setError(errText(e))
      if (String(errText(e)).includes('no such memory')) setGone(true)
    })
  }
  useEffect(load, [id])
  useBrainFrames((f) => { if (!f || f.id === id || f.op !== 'added') load() })

  if (gone) return null
  return (
    <aside aria-label="Memory" data-brain-detail className={`sticky top-3 ${className} max-h-[calc(100vh-7rem)] shrink-0 content-start gap-3 [&>*]:min-w-0 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-panel p-3`}>
      <div className="flex items-start gap-2">
        {data && <span aria-hidden className="mt-[7px] inline-block h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: KIND_COLOR[data.node.kind] }} />}
        <div className="min-w-0 flex-1">
          {data ? <Editable node={data.node} editable={editable} onSaved={(n) => setData((d) => (d ? { ...d, node: n } : d))} /> : <p className="text-[13px] text-fg-faint">{error || 'loading…'}</p>}
        </div>
        <CloseButton onClick={onClose} />
      </div>
      {data && <Body data={data} editable={editable} onSelect={onSelect} onChanged={load} onDeleted={onClose} />}
    </aside>
  )
}

function Editable({ node, editable, onSaved }: { node: BrainNode; editable: boolean; onSaved: (n: BrainNode) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(node.title)
  const [summary, setSummary] = useState(node.summary)
  const [kind, setKind] = useState<BrainKind>(node.kind)
  const [error, setError] = useState('')
  useEffect(() => { setTitle(node.title); setSummary(node.summary); setKind(node.kind) }, [node])
  if (!editing) {
    return (
      <div className="grid gap-1.5">
        <h2 className="text-[15px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">{node.title}</h2>
        {node.summary && <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg-muted [overflow-wrap:anywhere]">{node.summary}</p>}
        {editable && (
          <button type="button" onClick={() => setEditing(true)} className="justify-self-start text-[11.5px] text-fg-faint hover:text-accent">Edit</button>
        )}
      </div>
    )
  }
  const save = async () => {
    try {
      const r = await api.patchBrain(node.id, { title, summary, ...(isEntity(node.kind) ? {} : { kind }) })
      onSaved(r.node)
      setEditing(false)
      setError('')
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <input className="input w-full text-[14px]" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus />
      <textarea className="input min-h-[96px] w-full resize-y text-[13px] leading-relaxed" value={summary} maxLength={400} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />
      {!isEntity(node.kind) && (
        <select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value as BrainKind)} aria-label="Kind">
          {MEMORY_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-[6px] bg-accent px-2.5 py-1 text-[12.5px] font-medium text-panel">Save</button>
        <button type="button" onClick={() => setEditing(false)} className="rounded-[6px] border border-border px-2.5 py-1 text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>
      </div>
    </form>
  )
}

function Body({ data, editable, onSelect, onChanged, onDeleted }: {
  data: { node: BrainNode; links: BrainLink[] }
  editable: boolean
  onSelect: (id: number) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const { node, links } = data
  const [topic, setTopic] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setError(''); onChanged() } catch (e) { setError(errText(e)) }
  }
  const addTopic = async () => {
    const t = topic.trim()
    if (!t) return
    await act(async () => {
      const r = await api.dropBrain({ kind: 'topic', title: t })
      await api.linkBrain(node.id, r.node.id, 'part_of')
      setTopic('')
    })
  }
  const src = node.source
  return (
    <>
      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[12px]">
        <dt className="text-fg-faint">Kind</dt>
        <dd className="text-fg-muted">{KIND_LABEL[node.kind]}{node.pinned ? ' · pinned' : ''}</dd>
        {src.project && (<><dt className="text-fg-faint">Project</dt><dd className="truncate text-fg-muted">{src.project}</dd></>)}
        {!isEntity(node.kind) && <><dt className="text-fg-faint">From</dt>
        <dd className="text-fg-muted">
          {src.session_id ? (
            <a className="link" href={href({ name: 'session', id: src.session_id, at: src.ts || undefined })} title="Open the session at this moment">
              the session, {fmtAgo(src.ts || node.created_at)}
            </a>
          ) : node.manual ? 'typed in by hand' : '—'}
        </dd></>}
        <dt className="text-fg-faint">Kept</dt>
        <dd className="text-fg-muted">{fmtAgo(node.created_at)} · {node.manual ? 'by hand' : node.run_id ? 'by the automatic extraction' : 'with the first memory linked to it'}</dd>
      </dl>

      {links.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">Linked</p>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {links.map((l) => (
              <li key={`${l.node.id}-${l.kind}-${l.out}`} className="group flex min-w-0 items-center gap-2">
                <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: KIND_COLOR[l.node.kind] }} />
                <span className="w-[86px] shrink-0 text-[11px] text-fg-faint">{EDGE_WORD[l.kind]?.[l.out ? 0 : 1] ?? l.kind}</span>
                <button type="button" onClick={() => onSelect(l.node.id)} className="min-w-0 flex-1 truncate text-left text-[12.5px] text-fg hover:text-accent" title={l.node.title}>
                  {l.node.title}
                </button>
                {editable && (
                  <button type="button" aria-label={`Unlink ${l.node.title}`} title="Unlink"
                    onClick={() => void act(() => api.unlinkBrain(node.id, l.node.id))}
                    className="text-[11px] text-fg-faint opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100">×</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {editable && (
        <>
          {!isEntity(node.kind) && (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void addTopic() }}>
              <input className="input min-w-0 flex-1 text-[12.5px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Link to a topic…" aria-label="Link to a topic" />
              <button type="submit" disabled={!topic.trim()} className="rounded-[6px] border border-border px-2 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50">Link</button>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
            <button type="button" onClick={() => void act(() => api.patchBrain(node.id, { pinned: !node.pinned }))}
              className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-fg-muted hover:text-fg">
              {node.pinned ? 'Unpin' : 'Pin'}
            </button>
            {confirm ? (
              <>
                <button type="button" onClick={() => void act(async () => { await api.removeBrain(node.id); onDeleted() })}
                  className="rounded-[6px] bg-danger px-2.5 py-1 text-[12px] font-medium text-white">Delete it</button>
                <button type="button" onClick={() => setConfirm(false)} className="text-[12px] text-fg-muted hover:text-fg">Keep</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirm(true)} className="ml-auto text-[12px] text-fg-faint hover:text-danger">Delete</button>
            )}
          </div>
        </>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </>
  )
}
