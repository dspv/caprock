/**
 * New chat in three steps (ADR-091; owner approved the mockup 2026-11-05):
 *
 * 1. **Who works** — Claude on the user's subscription, another Claude
 *    sign-in, DeepSeek or Kimi on the user's key (only while it is set),
 *    Codex on a ChatGPT sign-in, then any other agent here (lib/newChat
 *    whoOptions). The last pick is marked and remembered.
 * 2. **Where** — *Just a chat* (a folder of its own, as Quick chat has
 *    always made), the recent folders (`GET /v1/recent-dirs`: deduped,
 *    newest first, at most eight, never a temp or a chat folder) each with
 *    its Work / Personal tag and a ⋯ to set it, and *Pick another folder…*,
 *    a touch-sized browser over `GET /v1/browse` (home and below on a phone).
 * 3. **Chat** — the chat opens (screens/Chat), whose context line says what
 *    the agent sees.
 *
 * A bottom sheet on a phone, a centred dialog elsewhere (ChatSheet).
 */
import { useState } from 'react'
import { api, errText, type FolderLabelKind } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo } from '@/lib/format'
import { navigate } from '@/lib/router'
import { tildePath } from '@/lib/projectSearch'
import { folderChatRequest, LABEL_TEXT, labelFor, ownLabel, rememberedWho, rememberWho, whoChoice, whoOptions, type WhoOption } from '@/lib/newChat'
import { rememberStartedChat } from '@/lib/quickchat'
import { quickChoiceLabel, rememberQuickChoice } from './QuickChat'
import { ChatSheet, type useChatChoice } from './ChatStart'
import { AgentCharacter } from './Characters'
import { ChatIcon, ChevronIcon, FolderIcon, MoreIcon } from './AppIcons'

type Step = 'who' | 'where' | 'browse'

export function NewChatSteps({ chat, onClose }: { chat: ReturnType<typeof useChatChoice>; onClose: () => void }) {
  const subs = useApi(() => api.subscriptions(), [], { live: false, share: 'subscriptions' })
  const ready = chat.loaded && (!!subs.data || !!subs.error)
  const options = ready ? whoOptions(chat.agents, subs.data) : []
  const last = rememberedWho(options)
  const [step, setStep] = useState<Step>('who')
  const [who, setWho] = useState<WhoOption | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const home = subs.data?.home ?? chat.home

  const pickWho = (o: WhoOption) => { rememberWho(o); setWho(o); setStep('where') }
  const start = async (cwd: string) => {
    if (!who) return
    setBusy(cwd || 'chat')
    setError('')
    try {
      const c = whoChoice(who, chat.choice)
      const { session_id } = await api.spawn(folderChatRequest(c, cwd))
      if (!who.provider) rememberQuickChoice(c)
      rememberStartedChat(session_id, { agent: c.agent, model: c.model, label: quickChoiceLabel(c) })
      onClose()
      navigate({ name: 'chat', id: session_id })
    } catch (e) {
      setError(errText(e))
      setBusy('')
    }
  }

  const title = step === 'who' ? 'Who works' : step === 'where' ? 'Where' : 'Pick a folder'
  return (
    <ChatSheet title={title} onClose={onClose}>
      <div data-new-chat-step={step} className="grid gap-3">
        <Steps step={step} />
        {step === 'who' && (
          !ready ? <p className="text-[14px] text-fg-muted">Reading what can answer here…</p>
          : options.length === 0 ? <p className="text-[14px] text-fg-muted">No agent Caprock can start was found on this machine.</p>
          : (
            <ul aria-label="Who works" className="overflow-hidden rounded-[12px] border border-border bg-bg">
              {options.map((o) => (
                <li key={o.key} className="border-b border-border last:border-b-0">
                  <button type="button" data-who={o.key} onClick={() => pickWho(o)} className={`flex min-h-[60px] w-full min-w-0 items-center gap-3 px-3 text-left active:bg-panel-2 ${last?.key === o.key ? 'bg-accent/10' : ''}`}>
                    <AgentCharacter who={o.who} face={o.face} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-medium text-fg">{o.label}</span>
                      {o.hint && <span className="block truncate text-[13px] text-fg-muted">{o.hint}</span>}
                    </span>
                    {last?.key === o.key && <span className="shrink-0 text-[12px] text-accent">last used</span>}
                    <span className="shrink-0 text-fg-faint"><ChevronIcon size={14} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
        {step === 'where' && who && (
          <Where who={who} home={home} busy={busy} onBack={() => setStep('who')} onBrowse={() => setStep('browse')} onStart={(d) => void start(d)} />
        )}
        {step === 'browse' && who && (
          <Browse busy={busy} home={home} onBack={() => setStep('where')} onStart={(d) => void start(d)} />
        )}
        {error && <p role="alert" className="text-[13.5px] text-danger">{error}</p>}
      </div>
    </ChatSheet>
  )
}

/** "1 Who works · 2 Where · 3 Chat", the current one marked. */
function Steps({ step }: { step: Step }) {
  const at = step === 'who' ? 0 : 1
  return (
    <ol aria-label="Steps" className="flex items-center gap-2 text-[12.5px] text-fg-faint">
      {['Who works', 'Where', 'Chat'].map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={`flex items-center gap-1.5 ${i === at ? 'font-medium text-fg' : ''}`}>
          <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] num ${i === at ? 'bg-accent text-bg' : i < at ? 'bg-accent/25 text-accent' : 'border border-border-strong'}`}>{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  )
}

function Where({ who, home, busy, onBack, onBrowse, onStart }: { who: WhoOption; home?: string; busy: string; onBack: () => void; onBrowse: () => void; onStart: (dir: string) => void }) {
  const recent = useApi(() => api.recentDirs(), [], { live: false })
  const labels = useApi(() => api.folderLabels(), [], { live: false, share: 'folder-labels' })
  const [menu, setMenu] = useState('')
  const [error, setError] = useState('')
  const setLabel = async (dir: string, label: FolderLabelKind | '') => {
    setMenu('')
    setError('')
    try { await api.setFolderLabel(dir, label); labels.refresh() } catch (e) { setError(errText(e)) }
  }
  const rows = recent.data ?? []
  return (
    <div className="grid gap-3">
      <button type="button" onClick={onBack} className="flex min-h-11 items-center gap-2 rounded-[12px] border border-border bg-bg px-3 text-left text-[14px] text-fg-muted">
        <AgentCharacter who={who.who} face={who.face} size={22} />
        <span className="min-w-0 flex-1 truncate"><span className="text-fg">{who.label}</span>{who.hint ? ` · ${who.hint}` : ''}</span>
        <span className="shrink-0 text-accent">Change</span>
      </button>
      <button type="button" data-where="chat" disabled={!!busy} onClick={() => onStart('')} className="flex min-h-[60px] w-full items-center gap-3 rounded-[12px] border border-border-strong bg-bg px-3 text-left active:bg-panel-2 disabled:opacity-60">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><ChatIcon size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-medium text-fg">{busy === 'chat' ? 'Starting…' : 'Just a chat'}</span>
          <span className="block truncate text-[13px] text-fg-muted">A folder of its own; no project needed</span>
        </span>
      </button>
      <div className="grid gap-1.5">
        <h3 className="px-1 text-[12px] font-medium uppercase tracking-wide text-fg-faint">Recent folders</h3>
        {!recent.data && !recent.error && <p className="px-1 text-[14px] text-fg-muted">Reading…</p>}
        {recent.error && <p role="alert" className="px-1 text-[13.5px] text-danger">{errText(recent.error)}</p>}
        {recent.data && rows.length === 0 && <p className="px-1 text-[14px] text-fg-muted">No folder has had a session yet.</p>}
        {rows.length > 0 && (
          <ul aria-label="Recent folders" className="overflow-hidden rounded-[12px] border border-border bg-bg">
            {rows.map((r) => {
              const tag = labelFor(r.dir, labels.data?.labels)
              const own = ownLabel(r.dir, labels.data?.labels)
              return (
                <li key={r.dir} className="border-b border-border last:border-b-0">
                  <div className="flex min-w-0 items-center">
                    <button type="button" data-where={r.dir} disabled={!!busy} onClick={() => onStart(r.dir)} className="flex min-h-[56px] min-w-0 flex-1 items-center gap-3 pl-3 text-left active:bg-panel-2 disabled:opacity-60">
                      <span className="shrink-0 text-fg-muted"><FolderIcon size={18} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[15.5px] font-medium text-fg">{busy === r.dir ? 'Starting…' : r.name}</span>
                          {tag && <LabelTag label={tag} />}
                        </span>
                        <span className="block truncate text-[12.5px] text-fg-faint">{tildePath(r.dir, home)} · {fmtAgo(r.last_event_at)}</span>
                      </span>
                    </button>
                    <button type="button" aria-label={`Label ${r.name}`} aria-expanded={menu === r.dir} onClick={() => setMenu(menu === r.dir ? '' : r.dir)} className="grid h-12 w-12 shrink-0 place-items-center text-fg-muted">
                      <MoreIcon size={18} />
                    </button>
                  </div>
                  {menu === r.dir && (
                    <div role="group" aria-label={`Label for ${r.name}`} className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
                      {(['work', 'personal'] as const).map((l) => (
                        <button key={l} type="button" aria-pressed={own === l} onClick={() => void setLabel(r.dir, l)} className={`min-h-9 rounded-full border px-3.5 text-[14px] ${own === l ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong text-fg'}`}>
                          {LABEL_TEXT[l]}
                        </button>
                      ))}
                      <button type="button" aria-pressed={!own} onClick={() => void setLabel(r.dir, '')} className="min-h-9 rounded-full px-3 text-[14px] text-fg-muted">No label</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {error && <p role="alert" className="px-1 text-[13px] text-danger">{error}</p>}
      </div>
      <button type="button" onClick={onBrowse} className="flex min-h-12 items-center gap-3 rounded-[12px] px-3 text-left text-[15px] text-accent">
        <FolderIcon size={18} /> Pick another folder…
      </button>
    </div>
  )
}

/** A folder browser sized for a thumb: tap a folder to go in, then start there. */
function Browse({ busy, home, onBack, onStart }: { busy: string; home?: string; onBack: () => void; onStart: (dir: string) => void }) {
  const [dir, setDir] = useState('')
  const list = useApi(() => api.browse(dir), [dir], { live: false })
  const d = list.data
  return (
    <div className="grid gap-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={() => (d?.parent ? setDir(d.parent) : onBack())} aria-label={d?.parent ? 'Up to the parent folder' : 'Back'} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-muted">
          <span className="rotate-180"><ChevronIcon size={16} /></span>
        </button>
        <span className="mono min-w-0 flex-1 truncate text-[13px] text-fg-muted" title={d?.dir}>{d ? tildePath(d.dir, home) : '…'}</span>
      </div>
      {list.error && <p role="alert" className="text-[13.5px] text-danger">{errText(list.error)}</p>}
      <ul aria-label="Folders" className="max-h-[46dvh] overflow-y-auto overflow-x-hidden rounded-[12px] border border-border bg-bg">
        {d && d.entries.length === 0 && <li className="px-3 py-3 text-[14px] text-fg-muted">No folders in here.</li>}
        {d?.entries.map((e) => (
          <li key={e.path} className="border-b border-border last:border-b-0">
            <button type="button" onClick={() => setDir(e.path)} className="flex min-h-[50px] w-full min-w-0 items-center gap-3 px-3 text-left active:bg-panel-2">
              <span className="shrink-0 text-fg-muted"><FolderIcon size={16} /></span>
              <span className="min-w-0 flex-1 truncate text-[15px] text-fg">{e.name}</span>
              {e.repo && <span className="shrink-0 text-[11px] uppercase tracking-wide text-accent">repo</span>}
              <span className="shrink-0 text-fg-faint"><ChevronIcon size={13} /></span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={!d || !!busy} onClick={() => d && onStart(d.dir)} className="min-h-12 w-full truncate rounded-[12px] bg-accent px-4 text-[16px] font-semibold text-bg disabled:opacity-60">
        {busy ? 'Starting…' : d ? `Chat in ${tildePath(d.dir, home) === '~' ? '~' : d.dir.split(/[\\/]/).filter(Boolean).pop() ?? d.dir}` : 'Chat here'}
      </button>
    </div>
  )
}

/** Work or Personal, as a small tag. */
export function LabelTag({ label }: { label: FolderLabelKind }) {
  return (
    <span data-label={label} className={`shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 ${label === 'work' ? 'bg-accent/15 text-accent' : 'bg-ok/15 text-ok'}`}>
      {LABEL_TEXT[label]}
    </span>
  )
}

