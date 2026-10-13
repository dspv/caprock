/**
 * Dev compare page (ui/compare-phone.html): two layouts of the phone home
 * screen — what the home-screen app opens to at phone width — and the two
 * sheets it opens, on mocked data, for the owner to pick one (2026-10-13).
 *
 * ?v=a      Launcher: the two actions as big tiles at the top, then Continue
 *           and the Inbox.
 * ?v=b      Thumb dock: Continue and the Inbox above, one field docked at the
 *           bottom that either starts a chat or saves what was typed.
 * ?v=save   The Save sheet over A, as a share from another app fills it.
 * ?v=newchat The New chat sheet over A.
 * ?v=hint   A in a phone browser, with the one-time Add to Home Screen hint.
 * &theme=dark|light
 *
 * Nothing here is wired to the daemon; the final build reuses the layout
 * picked, not this file.
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import { AgentGlyph } from '@/components/AgentMarks'
import { CaprockMark, ChatIcon, ChevronIcon, CloseIcon, InboxIcon, PlusIcon } from '@/components/AppIcons'

function CameraIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" />
    </svg>
  )
}

const params = new URLSearchParams(location.search)
const view = params.get('v') ?? 'a'

type Health = 'working' | 'waiting' | 'idle' | 'ended'

interface MockSession { project: string; agent: string; what: string; health: Health; ago: string }

const SESSIONS: MockSession[] = [
  { project: 'caprock', agent: 'claude', what: 'Fix the pairing token refresh on wake', health: 'working', ago: '1m' },
  { project: 'caprock-web', agent: 'claude', what: 'SEO page #8: a comparison landing page', health: 'waiting', ago: '4m' },
  { project: 'hermes-lab', agent: 'codex', what: 'Read per-session cost out of state.db', health: 'idle', ago: '18m' },
  { project: 'dotfiles', agent: 'gemini', what: 'Tidy the zsh startup, it takes 900 ms', health: 'ended', ago: '1h' },
]

interface MockSaved { text: string; where: string; ago: string; photo?: boolean }

const SAVED: MockSaved[] = [
  { text: 'Queue a prompt for tonight’s run: re-check the Windows CI flake in termv2 before release', where: 'caprock', ago: '12m', photo: true },
  { text: 'github.com/dspv/caprock/issues/412 — the phone loses its place in a long chat', where: 'Inbox', ago: '2h' },
  { text: 'Idea: a weekly digest of what each project cost, sent to my own Telegram bot', where: 'Inbox', ago: 'yesterday' },
]

const PROJECTS = [
  { name: 'caprock', path: '~/dev/caprock', note: '2 running' },
  { name: 'caprock-web', path: '~/dev/caprock-web', note: '1 running' },
  { name: 'hermes-lab', path: '~/dev/hermes-lab', note: '' },
  { name: 'dotfiles', path: '~/dotfiles', note: '' },
]

// A stand-in for a photo from the camera roll: a whiteboard sketch.
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" fill="#d9d4c8"/><rect x="10" y="14" width="140" height="120" rx="4" fill="#f4f1ea"/>
    <path d="M24 40h60M24 56h90M24 72h48" stroke="#3a6fb0" stroke-width="4" stroke-linecap="round"/>
    <rect x="96" y="84" width="40" height="34" rx="3" fill="none" stroke="#c0392b" stroke-width="3"/>
    <path d="M30 104c14-14 30 6 50-8" stroke="#2e7d4f" stroke-width="3" fill="none"/>
    <rect x="0" y="138" width="160" height="22" fill="#8a8170"/></svg>`,
)}`

// ── Shared pieces ──────────────────────────────────────────────────────────

function healthDot(h: Health): string {
  return h === 'working' ? 'bg-ok' : h === 'waiting' ? 'bg-warn' : 'bg-fg-faint'
}

function healthWord(h: Health): string {
  return h === 'working' ? 'working' : h === 'waiting' ? 'waiting for you' : h === 'idle' ? 'idle' : 'ended'
}

function Header() {
  return (
    <header className="flex items-center gap-2 px-4 pb-2 pt-3">
      <CaprockMark size={20} />
      <span className="text-[17px] font-semibold tracking-tight">Caprock</span>
      <span className="truncate text-[13px] text-fg-faint">on MacBook Pro</span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[12px] text-fg-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Live
      </span>
    </header>
  )
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline px-1 pb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint">
      <span>{children}</span>
      {right && <span className="ml-auto text-[13px] normal-case tracking-normal text-accent">{right}</span>}
    </div>
  )
}

/** A permission prompt a session waits on, answered with one tap. */
function Waiting() {
  return (
    <section aria-label="Waiting on you" className="rounded-[12px] border border-warn/50 bg-warn/10 p-3">
      <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.08em] text-warn">
        <span className="h-2 w-2 rounded-full bg-warn" /> Waiting on you
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[16px] font-medium">caprock-web</span>
        <span className="shrink-0 text-[12px] text-fg-faint">4m</span>
      </div>
      <div className="mt-0.5 text-[14px] text-fg-muted">wants to run</div>
      <div className="mono mt-1 truncate rounded-[6px] bg-panel px-2 py-1.5 text-[13px]">npm run build &amp;&amp; npm run check</div>
      <div className="mt-2.5 grid grid-cols-[1fr_1fr_auto] gap-2">
        <button className="min-h-11 rounded-[8px] bg-accent text-[15px] font-semibold text-bg">Allow</button>
        <button className="min-h-11 rounded-[8px] border border-border-strong bg-panel text-[15px] font-medium">Deny</button>
        <button className="min-h-11 rounded-[8px] px-3 text-[15px] font-medium text-accent">Open</button>
      </div>
    </section>
  )
}

function ContinueList({ rows = SESSIONS }: { rows?: MockSession[] }) {
  return (
    <section aria-label="Continue">
      <SectionLabel right="All sessions">Continue</SectionLabel>
      <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
        {rows.map((s) => (
          <li key={s.project} className="border-b border-border last:border-b-0">
            <a className={`flex min-h-[60px] items-center gap-3 px-3 py-2 text-fg no-underline ${s.health === 'ended' ? 'opacity-70' : ''}`}>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${healthDot(s.health)} ${s.health === 'working' ? 'animate-pulse' : ''}`} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[15px] font-medium">{s.project}</span>
                  {s.agent !== 'claude' && <AgentGlyph agent={s.agent} size={12} />}
                  <span className={`ml-auto shrink-0 text-[12px] ${s.health === 'waiting' ? 'text-warn' : 'text-fg-faint'}`}>
                    {healthWord(s.health)} · {s.ago}
                  </span>
                </span>
                <span className="block truncate text-[13px] text-fg-muted">{s.what}</span>
              </span>
              <span className="text-fg-faint"><ChevronIcon size={16} /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function InboxList({ rows = SAVED }: { rows?: MockSaved[] }) {
  return (
    <section aria-label="Saved">
      <SectionLabel right={`All ${rows.length + 4}`}>Saved</SectionLabel>
      <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
        {rows.map((r) => (
          <li key={r.text} className="flex min-h-[56px] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            {r.photo
              ? <img src={PHOTO} alt="" className="h-10 w-10 shrink-0 rounded-[6px] object-cover" />
              : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[6px] bg-panel-2 text-fg-faint"><InboxIcon size={18} /></span>}
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[14px] leading-[1.3]">{r.text}</span>
              <span className="block text-[12px] text-fg-faint">{r.where} · {r.ago}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DashboardLink() {
  return (
    <a className="flex min-h-11 items-center justify-center gap-1 text-[14px] text-fg-muted no-underline">
      Full dashboard <ChevronIcon size={14} />
    </a>
  )
}

// ── Variant A: Launcher ────────────────────────────────────────────────────

function Tiles() {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button className="flex min-h-[112px] flex-col items-start justify-between rounded-[14px] bg-accent p-3.5 text-left text-bg">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-bg/15"><PlusIcon size={22} /></span>
        <span>
          <span className="block text-[18px] font-semibold leading-tight">New chat</span>
          <span className="block truncate text-[13px] opacity-80">caprock · Claude</span>
        </span>
      </button>
      <button className="flex min-h-[112px] flex-col items-start justify-between rounded-[14px] border border-border-strong bg-panel p-3.5 text-left">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-panel-2 text-accent"><InboxIcon size={20} /></span>
        <span>
          <span className="block text-[18px] font-semibold leading-tight">Save</span>
          <span className="block truncate text-[13px] text-fg-muted">Note, link or photo</span>
        </span>
      </button>
    </div>
  )
}

function PhoneA() {
  return (
    <div className="min-h-[100dvh] bg-bg text-fg">
      <Header />
      <main className="grid gap-4 px-4 pb-6">
        <Waiting />
        <Tiles />
        <ContinueList />
        <InboxList rows={SAVED.slice(0, 2)} />
        <DashboardLink />
      </main>
    </div>
  )
}

// ── Variant B: Thumb dock ──────────────────────────────────────────────────

function Dock() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-panel/95 px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5 shadow-[0_-12px_32px_-18px_rgba(0,0,0,0.5)] backdrop-blur">
      <div className="mb-2 flex items-center gap-2 overflow-hidden">
        <button className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-border-strong bg-bg px-3 text-[14px]">
          caprock <ChevronIcon size={12} className="rotate-90" />
        </button>
        <button className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-strong bg-bg px-3 text-[14px]">
          <AgentGlyph agent="claude" size={12} /> Claude <ChevronIcon size={12} className="rotate-90" />
        </button>
        <span className="truncate text-[12px] text-fg-faint">Personal · 62% left</span>
      </div>
      <div className="flex items-end gap-2">
        <button aria-label="Add a photo" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border-strong bg-bg text-fg-muted">
          <CameraIcon size={20} />
        </button>
        <div className="min-h-11 min-w-0 flex-1 rounded-[22px] border border-border-strong bg-bg px-3.5 py-2.5 text-[16px] text-fg-faint">
          Ask, or jot something down…
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button className="min-h-12 rounded-[12px] border border-border-strong bg-bg text-[16px] font-medium">Save</button>
        <button className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[12px] bg-accent text-[16px] font-semibold text-bg">
          <ChatIcon size={18} /> Start chat
        </button>
      </div>
    </div>
  )
}

function PhoneB() {
  return (
    <div className="min-h-[100dvh] bg-bg text-fg">
      <Header />
      <main className="grid gap-4 px-4 pb-[220px]">
        <Waiting />
        <ContinueList />
        <InboxList rows={SAVED.slice(0, 2)} />
        <DashboardLink />
      </main>
      <Dock />
    </div>
  )
}

// ── Sheets ─────────────────────────────────────────────────────────────────

function BottomSheet({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/45">
      <div role="dialog" aria-label={title} className="flex max-h-[94dvh] w-full flex-col rounded-t-[18px] border-t border-border-strong bg-panel shadow-[0_-24px_64px_-20px_rgba(0,0,0,0.55)]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" />
        <div className="flex items-center px-4 pb-1 pt-2">
          <h2 className="text-[19px] font-semibold">{title}</h2>
          <button aria-label="Close" className="ml-auto grid h-10 w-10 place-items-center rounded-full text-fg-muted"><CloseIcon size={20} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-3">{children}</div>
        <div className="border-t border-border px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">{footer}</div>
      </div>
    </div>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint first:mt-1">{children}</div>
}

function Chip({ on, children }: { on?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[15px] ${on ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong bg-bg text-fg'}`}>
      {children}
    </span>
  )
}

function SaveSheet() {
  return (
    <BottomSheet
      title="Save"
      footer={
        <div className="grid gap-2">
          <button className="min-h-12 rounded-[12px] bg-accent text-[16px] font-semibold text-bg">Save to Inbox</button>
          <button className="min-h-11 text-[15px] font-medium text-accent">Save and start a chat with it</button>
        </div>
      }
    >
      <FieldLabel>What</FieldLabel>
      <div className="min-h-[124px] rounded-[12px] border border-border-strong bg-bg px-3.5 py-3 text-[16px] leading-[1.4]">
        The phone loses its place in a long chat after a reconnect — check how the pager merges pages.
        <span className="mt-1 block truncate text-accent">github.com/dspv/caprock/issues/412</span>
      </div>
      <div className="mt-1 text-[12px] text-fg-faint">Shared from Safari</div>
      <FieldLabel>Photos</FieldLabel>
      <div className="flex gap-2">
        <span className="relative">
          <img src={PHOTO} alt="Whiteboard sketch" className="h-[72px] w-[72px] rounded-[10px] object-cover" />
          <span className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-border-strong bg-panel text-fg-muted"><CloseIcon size={12} /></span>
        </span>
        <button className="grid h-[72px] w-[72px] place-items-center rounded-[10px] border border-dashed border-border-strong text-fg-muted">
          <span className="grid justify-items-center gap-0.5 text-[12px]"><CameraIcon size={20} />Add</span>
        </button>
      </div>
      <FieldLabel>Save to</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Chip on><InboxIcon size={15} /> Inbox</Chip>
        <Chip>caprock</Chip>
        <Chip>caprock-web</Chip>
        <Chip>hermes-lab</Chip>
        <Chip>More…</Chip>
      </div>
      <p className="mt-3 text-[13px] leading-[1.4] text-fg-faint">Kept on your Mac, in Caprock. Open it there from Quick chat or a project.</p>
    </BottomSheet>
  )
}

function NewChatSheet() {
  return (
    <BottomSheet
      title="New chat"
      footer={
        <button className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[16px] font-semibold text-bg">
          <ChatIcon size={18} /> Start chat in caprock
        </button>
      }
    >
      <FieldLabel>Project</FieldLabel>
      <ul className="overflow-hidden rounded-[12px] border border-border bg-bg">
        {PROJECTS.map((p, i) => (
          <li key={p.name} className={`flex min-h-[52px] items-center gap-3 border-b border-border px-3 last:border-b-0 ${i === 0 ? 'bg-accent/10' : ''}`}>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${i === 0 ? 'border-accent' : 'border-border-strong'}`}>
              {i === 0 && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{p.name}</span>
              <span className="mono block truncate text-[12px] text-fg-faint">{p.path}</span>
            </span>
            {p.note && <span className="shrink-0 text-[12px] text-ok">{p.note}</span>}
          </li>
        ))}
      </ul>
      <FieldLabel>Agent</FieldLabel>
      <div className="grid grid-cols-4 gap-1.5">
        {(['claude', 'codex', 'gemini', 'opencode'] as const).map((a, i) => (
          <span key={a} className={`flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-[10px] border text-[13px] ${i === 0 ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-border-strong bg-bg'}`}>
            <AgentGlyph agent={a} size={16} />
            {a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a === 'gemini' ? 'Gemini' : 'OpenCode'}
          </span>
        ))}
      </div>
      <FieldLabel>Runs on</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Chip on>Personal · 62% left</Chip>
        <Chip>Work · 88% left</Chip>
        <Chip>DeepSeek</Chip>
      </div>
      <FieldLabel>First message · optional</FieldLabel>
      <div className="min-h-[72px] rounded-[12px] border border-border-strong bg-bg px-3.5 py-3 text-[16px] text-fg-faint">
        What should it do?
      </div>
      <div className="mt-2 flex items-center gap-1 text-[13px] text-fg-muted">
        Model: <span className="font-medium text-fg">Opus</span> · default <ChevronIcon size={12} />
      </div>
    </BottomSheet>
  )
}

/** The one-time hint in a phone browser that is not the home-screen app. */
function InstallHint() {
  return (
    <div className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-20 rounded-[14px] border border-border-strong bg-panel p-3.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.6)]">
      <div className="flex items-start gap-3">
        <CaprockMark size={28} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">Put Caprock on your Home Screen</div>
          <p className="mt-0.5 text-[14px] leading-[1.4] text-fg-muted">
            Tap <ShareGlyph /> Share below, then <span className="font-medium text-fg">Add to Home Screen</span>. It opens here, full screen, like an app.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="min-h-11 px-3 text-[15px] text-fg-muted">Not now</button>
        <button className="min-h-11 rounded-[10px] bg-accent px-4 text-[15px] font-semibold text-bg">Got it</button>
      </div>
    </div>
  )
}

function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mb-0.5 inline align-middle text-accent">
      <path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1" />
    </svg>
  )
}

function Page() {
  switch (view) {
    case 'b': return <PhoneB />
    case 'save': return <><PhoneA /><SaveSheet /></>
    case 'newchat': return <><PhoneA /><NewChatSheet /></>
    case 'hint': return <><PhoneA /><InstallHint /></>
    default: return <PhoneA />
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>)
