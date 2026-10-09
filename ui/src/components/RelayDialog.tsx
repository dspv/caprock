import { useEffect, useRef, useState } from 'react'
import { CloseButton, DialogBackdrop } from './Dialog'
import { api, errText, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { href, navigate } from '@/lib/router'
import { SPAWN_AGENTS, rememberAgent, useSpawnableAgents, type SpawnAgent } from './AgentPicker'
import { fmtAgo } from '@/lib/format'
import { agentName } from './Projects'

/**
 * Carry a session's work on in a new session — in the same agent or another.
 *
 * This is a relay, not a continuation: the new session does not get the old
 * one's conversation, only a brief Caprock writes from what it holds — the
 * last substantial thing the agent said (recency beats retrieval, as for the
 * SessionStart handoff), the working tree now, and the PRs the session
 * opened. The brief is shown before anything is sent and can be edited; it
 * goes out as the new session's first message only when the user starts it,
 * into a process Caprock starts for the purpose (rule 7).
 */
export function RelayMenu({ sessionID }: { sessionID: string }) {
  const agents = useSpawnableAgents()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<SpawnAgent | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Starting a process is not something a paired device may do.
  if (isPairedDevice() || agents.length === 0) return null
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Start a new session that picks this work up, with a summary you can read first"
        className="text-[11px] border border-border px-1.5 rounded-sm text-fg-muted hover:text-fg"
      >
        Continue in… ▾
      </button>
      {open && (
        <span role="menu" className="absolute left-0 top-full mt-1 z-10 grid min-w-[160px] border border-border-strong bg-panel rounded-sm py-1 shadow-lg">
          {SPAWN_AGENTS.filter((a) => agents.includes(a.key)).map((a) => (
            <button
              key={a.key}
              role="menuitem"
              onClick={() => { setTarget(a.key); setOpen(false) }}
              className="text-left text-[12px] px-3 py-1 text-fg-muted hover:text-fg hover:bg-fg/5"
            >
              {agentName(a.key)}
            </button>
          ))}
        </span>
      )}
      {target && <RelayDialog sessionID={sessionID} agent={target} onClose={() => setTarget(null)} />}
    </span>
  )
}

export function RelayDialog({ sessionID, agent, onClose }: { sessionID: string; agent: SpawnAgent; onClose: () => void }) {
  const brief = useApi(() => api.relayBrief(sessionID), [sessionID], { live: false })
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const b = brief.data
  // The proposal fills the box once; after that the box is the user's.
  useEffect(() => { if (b && text === null) setText(b.text) }, [b, text])

  const start = async () => {
    if (!b || !text?.trim()) return
    setBusy(true); setError('')
    try {
      const req: Parameters<typeof api.spawn>[0] = { relay_from: sessionID, prompt: text, cwd: b.cwd }
      if (agent !== 'claude') req.agent = agent
      const { session_id } = await api.spawn(req)
      rememberAgent(agent)
      onClose()
      navigate({ name: 'session', id: session_id, tab: 'terminal' })
    } catch (e) {
      setError(errText(e))
    } finally { setBusy(false) }
  }

  const name = agentName(agent)
  const files = b?.git && !b.git.not_repo ? b.git.files.length + (b.git.more ?? 0) : undefined
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-16">
      <div role="dialog" aria-label={`Continue in ${name}`} className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[720px] max-w-[94vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">Continue in {name}</h2>
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
        </header>
        <div className="px-4 py-3 grid min-w-0 gap-2.5 text-[13px]">
          {/* The honest sentence first: what the user would otherwise assume
            * is the one thing this is not. */}
          <p className="text-fg">
            This starts a <b>new</b> {name} session with a summary of this one as its first message — not the same
            conversation. {name} sees only what is in the box below.
          </p>
          {brief.error && <div className="text-danger text-[12px]">{errText(brief.error)}</div>}
          {!b && !brief.error && <div className="text-fg-muted">Putting the summary together…</div>}
          {b && (
            <>
              <div className="text-[12px] text-fg-muted flex flex-wrap gap-x-4 gap-y-1">
                <span>Folder <span className="mono text-fg">{b.cwd || 'unknown'}</span></span>
                <span>{b.passage_at ? <>Last passage {fmtAgo(b.passage_at, Date.now())}</> : 'No passage to carry'}</span>
                {files !== undefined && <span>{files === 0 ? 'No changes in the tree' : `${files} changed file${files === 1 ? '' : 's'}`}{b.git?.branch ? ` on ${b.git.branch}` : ''}</span>}
                {b.prs.length > 0 && <span>{b.prs.length} PR{b.prs.length === 1 ? '' : 's'} opened</span>}
              </div>
              {!b.cwd_exists ? (
                <div className="text-danger text-[12px]">The folder this session worked in no longer exists, so there is nowhere to start the new one.</div>
              ) : (
                <label className="grid gap-1">
                  <span className="text-[11px] uppercase tracking-[0.08em] text-fg-muted">First message · edit freely</span>
                  <textarea
                    className="input mono text-[12px] leading-[1.45] min-h-[320px] max-h-[55vh] resize-y"
                    value={text ?? ''}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                  />
                </label>
              )}
              <p className="text-[11px] text-fg-faint">
                Built on this machine from what Caprock recorded and the folder&rsquo;s git state; nothing has been sent.
                Starting the session sends this message, and {name} answers it with your account.
              </p>
            </>
          )}
          {error && <div className="text-danger text-[12px]">{error}</div>}
        </div>
        <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
          <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
          <button
            onClick={start}
            disabled={busy || !b || !b.cwd_exists || !text?.trim()}
            className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? 'starting…' : `Start ${name} with this message`}
          </button>
        </footer>
      </div>
    </DialogBackdrop>
  )
}

/** The relay chain on a session page: where this one came from, and where it
 *  was carried on. */
export function RelayChain({ from, to }: { from?: { session_id: string; agent: string; title?: string }; to?: { session_id: string; agent: string; title?: string }[] }) {
  if (!from && !(to && to.length)) return null
  return (
    <div className="text-[12px] text-fg-muted flex flex-wrap gap-x-4 gap-y-1">
      {from && (
        <span>
          Carries on from a {agentName(from.agent)} session:{' '}
          <a className="link mono" href={href({ name: 'session', id: from.session_id })}>{from.title || from.session_id.slice(0, 8)}</a>
          <span className="text-fg-faint"> — started with a summary, not its conversation</span>
        </span>
      )}
      {to && to.length > 0 && (
        <span>
          Carried on in{' '}
          {to.map((t, i) => (
            <span key={t.session_id}>
              {i > 0 && ', '}
              {agentName(t.agent)}{' '}
              <a className="link mono" href={href({ name: 'session', id: t.session_id })}>{t.title || t.session_id.slice(0, 8)}</a>
            </span>
          ))}
        </span>
      )}
    </div>
  )
}
