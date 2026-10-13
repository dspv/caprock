/**
 * The phone home: what Caprock opens to at phone width — the home-screen app
 * above all (owner, 2026-10-13: "I really miss a Caprock app on the phone
 * with quick access — to start new chats, save stuff", translated).
 *
 * Layout B of the two drawn that day, picked by the owner: what waits on you
 * at the top, then the sessions to continue and what was saved, and one field
 * docked at the bottom where the thumb is. Typed words go either way: **Start
 * chat** starts a session on them in the project and agent the chips name;
 * **Save** keeps them, with any photos, in the Inbox the Mac shows in Quick
 * chat. An empty field opens the full sheet instead (New chat, Save), as do
 * the home-screen shortcuts and a share from another app.
 *
 * Light on purpose: the sessions list, the projects, the Inbox — no figures,
 * no charts. The full dashboard is one link down. Spec: .ai/04-ui.md § The
 * phone home.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, errText, isPairedDevice, type InboxItem, type SessionSummary, type SpawnRequest, type Subscription } from '@/lib/api'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useNow } from '@/lib/useNow'
import { fmtAgo } from '@/lib/format'
import { projectLabels } from '@/lib/sessionLabels'
import { projectsApi, type Project } from '@/lib/projects'
import { downscalePhoto } from '@/lib/downscale'
import { isInboxImage, useInbox, useInboxThumb } from '@/lib/inbox'
import {
  continueList, INSTALL_HINT_KEY, installWay, isStandalone, messageWith, openFromHash, sharedFromSearch, waitingOnYou,
  type InstallWay,
} from '@/lib/phonehome'
import { AgentGlyph } from './AgentMarks'
import { agentLabel, isCustomAgent, startable, useAgentCatalog, type SpawnAgent } from './AgentPicker'
import { CaprockMark, ChatIcon, ChevronIcon, CloseIcon, InboxIcon } from './AppIcons'
import { PermissionPrompt } from './PermissionPrompt'
import { subscriptionsFor, useSubscriptionList } from './SubscriptionPicker'
import { chosenId, hasSubscriptions, roomText } from '@/lib/subscriptions'

/** The last project, agent and sign-in a chat was started on from here. */
const CHOICE_KEY = 'caprock.phone.choice'
interface Choice { root: string; agent: SpawnAgent; subscription: string }

function readChoice(): Partial<Choice> {
  try { return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') as Partial<Choice> } catch { return {} }
}
function keepChoice(c: Choice) {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)) } catch { /* not remembering is fine */ }
}

/** A photo picked to go with a message or a save, before it is sent. */
interface Picked { file: File; url: string }

/** A file's bytes as base64, in chunks: one call over a large array blows the argument limit. */
async function base64Of(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return btoa(bin)
}

async function uploads(photos: readonly Picked[]): Promise<{ name: string; type: string; data: string }[]> {
  const out = []
  for (const p of photos) {
    const f = await downscalePhoto(p.file)
    out.push({ name: f.name || 'photo.jpg', type: f.type, data: await base64Of(f) })
  }
  return out
}

/** A project's id as the Inbox stores it: a listed project's number, else 0. */
function projectNumber(p?: Project): number {
  return p && /^\d+$/.test(p.id) ? Number(p.id) : 0
}

/** Projects with the most recently used first, pinned ahead of the rest. */
function byUse(list: readonly Project[]): Project[] {
  return list
    .filter((p) => !p.archived_at)
    .slice()
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.last_activity ?? 0) - (a.last_activity ?? 0) || a.name.localeCompare(b.name))
}

/**
 * The agents this screen offers: installed and ready, and on a phone only the
 * ones Caprock knows by name — the daemon refuses a phone a custom one.
 */
function useAgents() {
  const catalog = useAgentCatalog()
  const paired = isPairedDevice()
  const agents = startable(catalog.entries).filter((a) => !(paired && isCustomAgent(a)))
  return { agents, entries: catalog.entries, loaded: catalog.loaded }
}

/** Starts a session and opens its chat; the error, if any, for the caller to show. */
async function startChat(project: Project, agent: SpawnAgent, subscription: string, text: string, photos: readonly Picked[]): Promise<void> {
  const paths: string[] = []
  for (const p of photos) {
    const f = await downscalePhoto(p.file)
    const { path } = await api.paste({ name: f.name || 'photo.jpg', type: f.type, data: await base64Of(f) })
    paths.push(path)
  }
  const req: SpawnRequest = { cwd: project.root }
  if (agent !== 'claude') req.agent = agent
  if (subscription && hasSubscriptions(agent)) req.subscription = subscription
  const prompt = messageWith(text, paths)
  if (prompt) req.prompt = prompt
  const res = await api.spawn(req)
  keepChoice({ root: project.root, agent, subscription })
  navigate({ name: 'session', id: res.session_id, tab: 'chat' })
}

/** The picks a chat starts on, shared by the dock and the New chat sheet. */
function useChatPicks(projects: readonly Project[]) {
  const { agents, entries, loaded } = useAgents()
  const subs = useSubscriptionList()
  const remembered = useMemo(readChoice, [])
  const [root, setRoot] = useState(remembered.root ?? '')
  const [agent, setAgent] = useState<SpawnAgent>((remembered.agent as SpawnAgent) ?? 'claude')
  const [sub, setSub] = useState(remembered.subscription ?? '')
  const project = projects.find((p) => p.root === root) ?? projects[0]
  const agentNow: SpawnAgent = agents.includes(agent) ? agent : agents[0] ?? 'claude'
  const subsNow = subscriptionsFor(subs.all, agentNow)
  const subNow = subsNow.length ? chosenId(subsNow, sub) : ''
  return {
    project, setRoot, agent: agentNow, setAgent, agents, entries, loaded,
    subs: subsNow, sub: subNow, setSub,
  }
}

/** Keeps the dock above the on-screen keyboard: iOS leaves `fixed; bottom: 0` under it. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on) }
  }, [])
  return inset
}

export function PhoneHome() {
  const canControl = useCanControl()
  const sessions = useApi(() => api.sessionsWithTotal(false, '', 60), [], { intervalMs: 5000 })
  const projectsRes = useApi(() => projectsApi.list(), [], { intervalMs: 60000 })
  const projects = useMemo(() => byUse(projectsRes.data ?? []), [projectsRes.data])
  const inbox = useInbox()
  const list = useMemo(() => sessions.data?.items ?? [], [sessions.data])
  const now = useNow(15000)
  const waiting = waitingOnYou(list)
  const rows = continueList(list, now)

  // A home-screen shortcut (#/?open=…) or another app's share (/?share=1…)
  // opens its sheet once, and the address is put back so a reload does not.
  // Bumped when a save succeeds, so the dock lets go of the words it handed over.
  const [saved, setSaved] = useState(0)
  const [sheet, setSheet] = useState<null | { kind: 'chat' } | { kind: 'save'; text: string; photos: Picked[] }>(() => {
    const shared = sharedFromSearch(window.location.search)
    if (shared) return { kind: 'save', text: shared.text, photos: [] }
    const open = openFromHash(window.location.hash)
    if (open === 'chat') return { kind: 'chat' }
    if (open === 'save') return { kind: 'save', text: '', photos: [] }
    return null
  })
  useEffect(() => {
    const clean = () => {
      if (window.location.search || window.location.hash.includes('?')) {
        try { window.history.replaceState(null, '', `${window.location.pathname}#/`) } catch { /* a sandboxed frame */ }
      }
    }
    clean()
    // A shortcut taken while the page is already open changes only the hash.
    const onHash = () => {
      const open = openFromHash(window.location.hash)
      if (!open) return
      setSheet(open === 'chat' ? { kind: 'chat' } : { kind: 'save', text: '', photos: [] })
      clean()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <div className="grid gap-4 pb-[236px]">
      {waiting[0] && <Waiting session={waiting[0]} more={waiting.length - 1} now={now} />}
      <Continue rows={rows} now={now} loading={!sessions.data && !sessions.error} />
      <Saved items={inbox.items} now={now} canDelete={canControl} />
      <a href="#/now" className="flex min-h-11 items-center justify-center gap-1 text-[14px] text-fg-muted no-underline">
        Full dashboard <ChevronIcon size={14} />
      </a>
      <Dock
        projects={projects}
        canControl={canControl}
        saved={saved}
        onSave={(text, photos) => setSheet({ kind: 'save', text, photos })}
        onNewChat={() => setSheet({ kind: 'chat' })}
      />
      {sheet?.kind === 'chat' && <NewChatSheet projects={projects} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'save' && (
        <SaveSheet projects={projects} text={sheet.text} photos={sheet.photos} canSave={canControl} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); setSaved((n) => n + 1); inbox.refresh() }} />
      )}
      <InstallHint />
    </div>
  )
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline px-1 pb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint">
      <span>{children}</span>
      {right && <span className="ml-auto text-[13px] normal-case tracking-normal">{right}</span>}
    </div>
  )
}

/** The first session that waits on you, answered here when it is a permission prompt. */
function Waiting({ session, more, now }: { session: SessionSummary; more: number; now: number }) {
  return (
    <section aria-label="Waiting on you" className="rounded-[12px] border border-warn/50 bg-warn/10 p-3">
      <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.08em] text-warn">
        <span className="h-2 w-2 rounded-full bg-warn" /> Waiting on you{more > 0 ? ` · ${more + 1}` : ''}
      </div>
      <a href={href({ name: 'session', id: session.session_id, tab: 'chat' })} className="mt-2 flex min-w-0 items-baseline gap-2 text-fg no-underline">
        <span className="truncate text-[16px] font-medium">{session.project || 'unknown project'}</span>
        <span className="shrink-0 text-[12px] text-fg-faint">{fmtAgo(session.activity?.at || session.last_event_at, now)}</span>
        <span className="ml-auto shrink-0 text-[15px] font-medium text-accent">Open</span>
      </a>
      {session.description && <div className="mt-0.5 truncate text-[14px] text-fg-muted">{session.description}</div>}
      <div className="mt-2"><PermissionPrompt sessionId={session.session_id} keys={false} /></div>
    </section>
  )
}

function healthDot(s: SessionSummary): string {
  const h = s.activity?.health
  if (h === 'working') return 'bg-ok animate-pulse'
  if (h === 'waiting-on-you') return 'bg-warn'
  if (h === 'looping' || h === 'error') return 'bg-danger'
  return 'bg-fg-faint'
}

function healthWord(s: SessionSummary): string {
  if (s.status === 'ended') return 'ended'
  const h = s.activity?.health
  return h === 'waiting-on-you' ? 'waiting for you' : h === 'working' ? 'working' : h === 'looping' ? 'looping' : h === 'error' ? 'error' : 'idle'
}

function Continue({ rows, now, loading }: { rows: SessionSummary[]; now: number; loading: boolean }) {
  const labels = projectLabels(rows)
  return (
    <section aria-label="Continue">
      <SectionLabel right={<a href="#/now" className="text-accent no-underline">All sessions</a>}>Continue</SectionLabel>
      {rows.length === 0 ? (
        <div className="rounded-[12px] border border-border bg-panel px-3 py-4 text-[14px] text-fg-muted">
          {loading ? 'Reading your sessions…' : 'Nothing from the last two days. Start a chat below.'}
        </div>
      ) : (
        <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
          {rows.map((s) => {
            const waiting = s.activity?.health === 'waiting-on-you'
            const when = s.worked_at || s.last_event_at
            return (
              <li key={s.session_id} className="border-b border-border last:border-b-0">
                <a
                  href={href({ name: 'session', id: s.session_id, tab: 'chat' })}
                  className={`flex min-h-[60px] items-center gap-3 px-3 py-2 text-fg no-underline active:bg-panel-2 ${s.status === 'ended' ? 'opacity-75' : ''}`}
                >
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${healthDot(s)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[15px] font-medium">{labels.get(s.session_id) || s.project || 'unknown project'}</span>
                      {s.agent && s.agent !== 'claude' && <AgentGlyph agent={s.agent} size={12} />}
                      <span className={`ml-auto shrink-0 text-[12px] ${waiting ? 'text-warn' : 'text-fg-faint'}`}>
                        {healthWord(s)}{when ? ` · ${fmtAgo(when, now)}` : ''}
                      </span>
                    </span>
                    <span className="block truncate text-[13px] text-fg-muted">{s.description || s.activity?.phrase || '—'}</span>
                  </span>
                  <span className="text-fg-faint"><ChevronIcon size={16} /></span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** An item's first image: fetched with the device's token on a phone (lib/inbox). */
function Thumb({ item }: { item: InboxItem }) {
  const n = item.files.findIndex(isInboxImage)
  return n < 0 ? <ThumbIcon /> : <ThumbImage id={item.id} n={n} />
}

function ThumbImage({ id, n }: { id: number; n: number }) {
  const url = useInboxThumb(id, n)
  return url ? <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-[6px] object-cover" /> : <ThumbIcon />
}

function ThumbIcon() {
  return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[6px] bg-panel-2 text-fg-faint"><InboxIcon size={18} /></span>
}

const SAVED_FOLDED = 3

function Saved({ items, now, canDelete }: { items: InboxItem[]; now: number; canDelete: boolean }) {
  const [all, setAll] = useState(false)
  const [gone, setGone] = useState<number[]>([])
  const shown = items.filter((i) => !gone.includes(i.id))
  if (shown.length === 0) return null
  const rows = all ? shown : shown.slice(0, SAVED_FOLDED)
  const remove = async (id: number) => {
    setGone((g) => [...g, id])
    try { await api.removeInbox(id) } catch { setGone((g) => g.filter((x) => x !== id)) }
  }
  return (
    <section aria-label="Saved">
      <SectionLabel right={shown.length > SAVED_FOLDED && (
        <button type="button" className="text-accent" onClick={() => setAll((v) => !v)}>{all ? 'Fewer' : `All ${shown.length}`}</button>
      )}>Saved · on your Mac in Quick chat</SectionLabel>
      <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
        {rows.map((r) => (
          <li key={r.id} className="flex min-h-[56px] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <Thumb item={r} />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words text-[14px] leading-[1.3]">{r.text || `${r.files.length} photo${r.files.length === 1 ? '' : 's'}`}</span>
              <span className="block truncate text-[12px] text-fg-faint">{r.project_name || 'Inbox'} · {fmtAgo(r.created_at, now)}</span>
            </span>
            {canDelete && (
              <button type="button" aria-label="Delete" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-faint" onClick={() => void remove(r.id)}>
                <CloseIcon size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function CameraIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" />
    </svg>
  )
}

/** Photos picked from the camera roll or the camera, with object URLs for their previews. */
function usePhotos(initial: Picked[] = []) {
  const [photos, setPhotos] = useState<Picked[]>(initial)
  const latest = useRef(photos)
  latest.current = photos
  useEffect(() => () => { for (const p of latest.current) URL.revokeObjectURL(p.url) }, [])
  const add = (files: FileList | null) => {
    if (!files) return
    const next = [...files].filter((f) => f.type.startsWith('image/')).map((file) => ({ file, url: URL.createObjectURL(file) }))
    setPhotos((p) => [...p, ...next].slice(0, 4))
  }
  const remove = (i: number) => setPhotos((p) => { const x = p[i]; if (x) URL.revokeObjectURL(x.url); return p.filter((_, j) => j !== i) })
  // Handing them on to a sheet: the sheet revokes them, this hook forgets them.
  const take = () => { const p = latest.current; latest.current = []; setPhotos([]); return p }
  return { photos, add, remove, take }
}

function PhotoRow({ photos, onRemove }: { photos: Picked[]; onRemove: (i: number) => void }) {
  if (photos.length === 0) return null
  return (
    <div className="mb-2 flex gap-2">
      {photos.map((p, i) => (
        <span key={p.url} className="relative">
          <img src={p.url} alt="" className="h-14 w-14 rounded-[8px] object-cover" />
          <button type="button" aria-label="Remove photo" onClick={() => onRemove(i)} className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-border-strong bg-panel text-fg-muted">
            <CloseIcon size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

/** One field at the bottom: Start chat on it, or Save it. */
function Dock({ projects, canControl, saved, onSave, onNewChat }: {
  projects: Project[]
  canControl: boolean
  saved: number
  onSave: (text: string, photos: Picked[]) => void
  onNewChat: () => void
}) {
  const picks = useChatPicks(projects)
  const [text, setText] = useState('')
  const { photos, add, remove, take } = usePhotos()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const inset = useKeyboardInset()
  useEffect(() => { if (saved) setText('') }, [saved])
  // The field grows with what is typed, to five lines.
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [text])

  const start = async () => {
    if (!text.trim() && photos.length === 0) { onNewChat(); return }
    if (!picks.project) { onNewChat(); return }
    setBusy(true)
    setError('')
    try {
      await startChat(picks.project, picks.agent, picks.sub, text, photos)
      setText('')
      take().forEach((p) => URL.revokeObjectURL(p.url))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const sub = picks.subs.find((s) => s.id === picks.sub)

  return (
    <div
      className="fixed inset-x-0 z-30 border-t border-border bg-panel/95 px-3 pt-2.5 shadow-[0_-12px_32px_-18px_rgba(0,0,0,0.5)] backdrop-blur"
      style={{ bottom: inset, paddingBottom: inset ? 10 : 'max(10px, env(safe-area-inset-bottom))' }}
    >
      {!canControl ? (
        <p className="pb-1 text-[14px] leading-[1.4] text-fg-muted">
          This phone can read Caprock. To start chats and save from it, on your Mac open <span className="text-fg">Settings → Use on your phone</span> and let it control.
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 overflow-hidden">
            <ChipSelect
              label="Project"
              value={picks.project?.root ?? ''}
              onChange={picks.setRoot}
              options={projects.map((p) => ({ value: p.root, label: p.name }))}
              empty="No projects"
            />
            <ChipSelect
              label="Agent"
              value={picks.agent}
              onChange={(v) => picks.setAgent(v as SpawnAgent)}
              options={picks.agents.map((a) => ({ value: a, label: agentLabel(a, picks.entries).replace(/ (Code|CLI)$/, '') }))}
              icon={<AgentGlyph agent={picks.agent} size={12} />}
            />
            {sub && <span className="truncate text-[12px] text-fg-faint">{subText(sub)}</span>}
          </div>
          <PhotoRow photos={photos} onRemove={remove} />
          <div className="flex items-end gap-2">
            <button type="button" aria-label="Add a photo" onClick={() => file.current?.click()} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border-strong bg-bg text-fg-muted">
              <CameraIcon />
            </button>
            <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = '' }} />
            <textarea
              ref={field}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask, or jot something down…"
              aria-label="Message or note"
              className="min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-border-strong bg-bg px-3.5 py-2.5 text-[16px] leading-[1.35] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
          </div>
          {error && <p role="alert" className="mt-1.5 text-[13px] text-danger">{error}</p>}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={() => onSave(text, take())} className="min-h-12 rounded-[12px] border border-border-strong bg-bg text-[16px] font-medium text-fg disabled:opacity-60">
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => void start()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[12px] bg-accent text-[16px] font-semibold text-bg disabled:opacity-60">
              <ChatIcon size={18} /> {busy ? 'Starting…' : 'Start chat'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function subText(s: Subscription): string {
  if (s.provider) return s.label
  const room = roomText(s)
  return room ? `${s.label} · ${room}` : s.label
}

/** A chip that is a native select: the phone's own picker, at the size of a thumb. */
function ChipSelect({ label, value, onChange, options, icon, empty }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  icon?: ReactNode
  empty?: string
}) {
  const shown = options.find((o) => o.value === value)?.label ?? empty ?? ''
  return (
    <label className="relative inline-flex min-h-9 max-w-[44%] shrink-0 items-center gap-1.5 rounded-full border border-border-strong bg-bg px-3 text-[14px] text-fg">
      {icon}
      <span className="truncate">{shown}</span>
      <ChevronIcon size={12} className="rotate-90 shrink-0" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function BottomSheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/45" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[94dvh] w-full flex-col rounded-t-[18px] border-t border-border-strong bg-panel text-fg shadow-[0_-24px_64px_-20px_rgba(0,0,0,0.55)]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" />
        <div className="flex items-center px-4 pb-1 pt-2">
          <h2 className="text-[19px] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto grid h-10 w-10 place-items-center rounded-full text-fg-muted"><CloseIcon size={20} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-3">{children}</div>
        <div className="border-t border-border px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint first:mt-1">{children}</div>
}

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[15px] ${on ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong bg-bg text-fg'}`}
    >
      {children}
    </button>
  )
}

const SHEET_PROJECTS = 6

export function NewChatSheet({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const picks = useChatPicks(projects)
  const [text, setText] = useState('')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const list = more ? projects : projects.slice(0, SHEET_PROJECTS)
  const start = async () => {
    if (!picks.project) return
    setBusy(true)
    setError('')
    try {
      await startChat(picks.project, picks.agent, picks.sub, text, [])
      onClose()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }
  return (
    <BottomSheet
      title="New chat"
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
          <button type="button" disabled={busy || !picks.project || picks.agents.length === 0} onClick={() => void start()} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[16px] font-semibold text-bg disabled:opacity-60">
            <ChatIcon size={18} /> {busy ? 'Starting…' : `Start chat${picks.project ? ` in ${picks.project.name}` : ''}`}
          </button>
        </>
      }
    >
      <FieldLabel>Project</FieldLabel>
      {projects.length === 0 ? (
        <p className="text-[14px] text-fg-muted">No projects yet. <a href="#/start" className="text-accent">Add one</a> — a folder, a clone or a new repository.</p>
      ) : (
        <ul className="overflow-hidden rounded-[12px] border border-border bg-bg">
          {list.map((p) => {
            const on = p.root === picks.project?.root
            return (
              <li key={p.id} className="border-b border-border last:border-b-0">
                <button type="button" aria-pressed={on} onClick={() => picks.setRoot(p.root)} className={`flex min-h-[52px] w-full items-center gap-3 px-3 text-left ${on ? 'bg-accent/10' : ''}`}>
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-accent' : 'border-border-strong'}`}>
                    {on && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{p.name}</span>
                    <span className="mono block truncate text-[12px] text-fg-faint">{p.root}</span>
                  </span>
                </button>
              </li>
            )
          })}
          {!more && projects.length > SHEET_PROJECTS && (
            <li><button type="button" onClick={() => setMore(true)} className="min-h-11 w-full text-[14px] text-accent">All {projects.length} projects</button></li>
          )}
        </ul>
      )}
      <FieldLabel>Agent</FieldLabel>
      {picks.agents.length === 0 ? (
        <p className="text-[14px] text-fg-muted">{picks.loaded ? 'No coding agent is installed on your Mac.' : 'Reading the agents…'}</p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {picks.agents.map((a) => {
            const on = a === picks.agent
            return (
              <button key={a} type="button" aria-pressed={on} onClick={() => picks.setAgent(a)} className={`flex min-h-[58px] min-w-0 flex-col items-center justify-center gap-1 rounded-[10px] border px-1 text-[13px] ${on ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong bg-bg text-fg'}`}>
                <AgentGlyph agent={a} size={16} />
                <span className="max-w-full truncate">{agentLabel(a, picks.entries).replace(/ (Code|CLI)$/, '')}</span>
              </button>
            )
          })}
        </div>
      )}
      {picks.subs.length > 1 && (
        <>
          <FieldLabel>Runs on</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {picks.subs.map((s) => <Chip key={s.id} on={s.id === picks.sub} onClick={() => picks.setSub(s.id)}>{subText(s)}</Chip>)}
          </div>
          {picks.sub === 'deepseek' && (
            <p className="mt-2 text-[13px] leading-[1.4] text-fg-muted">This chat runs on DeepSeek: its prompts, files and tool output go to api.deepseek.com on your DeepSeek key.</p>
          )}
        </>
      )}
      <FieldLabel>First message · optional</FieldLabel>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="What should it do?"
        aria-label="First message"
        className="w-full resize-none rounded-[12px] border border-border-strong bg-bg px-3.5 py-3 text-[16px] leading-[1.4] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
      />
    </BottomSheet>
  )
}

export function SaveSheet({ projects, text: initialText, photos: initialPhotos, canSave, onClose, onSaved }: {
  projects: Project[]
  text: string
  photos: Picked[]
  canSave: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState(initialText)
  const { photos, add, remove } = usePhotos(initialPhotos)
  const [to, setTo] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const listed = projects.filter((p) => projectNumber(p) > 0)
  const chips = listed.slice(0, 4)
  const rest = listed.slice(4)
  const target = listed.find((p) => projectNumber(p) === to)
  const save = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await api.addInbox({ text, project_id: to, files: await uploads(photos) })
      onSaved()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }, [text, to, photos, onSaved])
  const empty = !text.trim() && photos.length === 0
  return (
    <BottomSheet
      title="Save"
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
          <button type="button" disabled={busy || empty || !canSave} onClick={() => void save()} className="min-h-12 w-full rounded-[12px] bg-accent text-[16px] font-semibold text-bg disabled:opacity-60">
            {busy ? 'Saving…' : `Save to ${target ? target.name : 'Inbox'}`}
          </button>
        </>
      }
    >
      {!canSave && <p className="mb-2 text-[14px] text-warn">This phone can read Caprock but not save to it. On your Mac, Settings → Use on your phone lets it control.</p>}
      <FieldLabel>What</FieldLabel>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="A note, an idea, a link…"
        aria-label="What to save"
        className="w-full resize-none rounded-[12px] border border-border-strong bg-bg px-3.5 py-3 text-[16px] leading-[1.4] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
      />
      <FieldLabel>Photos</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {photos.map((p, i) => (
          <span key={p.url} className="relative">
            <img src={p.url} alt="" className="h-[72px] w-[72px] rounded-[10px] object-cover" />
            <button type="button" aria-label="Remove photo" onClick={() => remove(i)} className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-border-strong bg-panel text-fg-muted"><CloseIcon size={12} /></button>
          </span>
        ))}
        {photos.length < 4 && (
          <button type="button" onClick={() => file.current?.click()} className="grid h-[72px] w-[72px] place-items-center rounded-[10px] border border-dashed border-border-strong text-fg-muted">
            <span className="grid justify-items-center gap-0.5 text-[12px]"><CameraIcon />Add</span>
          </button>
        )}
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      </div>
      <FieldLabel>Save to</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Chip on={to === 0} onClick={() => setTo(0)}><InboxIcon size={15} /> Inbox</Chip>
        {chips.map((p) => <Chip key={p.id} on={to === projectNumber(p)} onClick={() => setTo(projectNumber(p))}>{p.name}</Chip>)}
        {rest.length > 0 && (
          <label className={`relative inline-flex min-h-10 items-center rounded-full border px-3.5 text-[15px] ${rest.some((p) => projectNumber(p) === to) ? 'border-accent bg-accent/15 text-accent' : 'border-border-strong bg-bg text-fg'}`}>
            {rest.find((p) => projectNumber(p) === to)?.name ?? 'More…'}
            <select aria-label="Another project" value={String(to)} onChange={(e) => setTo(Number(e.target.value))} className="absolute inset-0 opacity-0">
              <option value="0">Inbox</option>
              {rest.map((p) => <option key={p.id} value={projectNumber(p)}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="mt-3 text-[13px] leading-[1.4] text-fg-faint">Kept on your Mac, in Caprock: open Quick chat there to start a chat from it.</p>
    </BottomSheet>
  )
}

/**
 * Once, in a phone's browser: how to put Caprock on the home screen, where it
 * opens full screen and to this page. Gone for good once dismissed.
 */
function InstallHint() {
  const [way, setWay] = useState<InstallWay>(null)
  useEffect(() => {
    let seen = false
    try { seen = localStorage.getItem(INSTALL_HINT_KEY) === '1' } catch { /* show it */ }
    if (!seen) setWay(installWay(navigator.userAgent, isStandalone(), navigator.maxTouchPoints ?? 0))
  }, [])
  if (!way) return null
  const done = () => {
    try { localStorage.setItem(INSTALL_HINT_KEY, '1') } catch { /* it comes back next time */ }
    setWay(null)
  }
  return (
    <div role="note" aria-label="Add to Home Screen" className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-30 rounded-[14px] border border-border-strong bg-panel p-3.5 text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.6)]">
      <div className="flex items-start gap-3">
        <CaprockMark size={28} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">Put Caprock on your Home Screen</div>
          <p className="mt-0.5 text-[14px] leading-[1.4] text-fg-muted">
            {way === 'ios'
              ? <>In Safari tap <span className="font-medium text-fg">Share</span>, then <span className="font-medium text-fg">Add to Home Screen</span>. It opens here, full screen, like an app.</>
              : <>Open the browser menu <span className="font-medium text-fg">⋮</span>, then <span className="font-medium text-fg">Add to Home screen</span>. It opens here, full screen, like an app.</>}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={done} className="min-h-11 rounded-[10px] bg-accent px-4 text-[15px] font-semibold text-bg">Got it</button>
      </div>
    </div>
  )
}
