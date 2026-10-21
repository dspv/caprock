/**
 * The demo's sample data (ADR-083): what the dashboard reads from a paired
 * computer, made up for the iOS app's "Try it without a Mac". Every name here
 * is a sample; nothing came from a real machine, and the demo shows a strip
 * saying so on every screen.
 *
 * Built once per launch from `now`, so "2m ago" reads right.
 */
import type { AgentCatalog, ChatList, Event, InboxItem, LimitsAnswer, PairMe, Permission, SessionDetail, SessionSummary, Status } from '@/lib/api'
import type { Project } from '@/lib/projects'

export interface Fixture {
  status: Status
  pairMe: PairMe
  premium: unknown
  projects: Project[]
  sessions: SessionSummary[]
  chats: SessionSummary[]
  events: Record<string, Event[]>
  permissions: Record<string, Permission>
  inbox: { items: InboxItem[]; max: number }
  limits: LimitsAnswer
  catalog: AgentCatalog
}

const MIN = 60_000
const HOME = '/Users/sample'

interface Spec {
  id: string
  project: string
  description: string
  health: SessionSummary['activity']['health']
  phrase: string
  ago: number
  agent?: SessionSummary['agent']
  status?: SessionSummary['status']
  chat?: boolean
  model?: string
}

function summary(s: Spec, now: number): SessionSummary {
  const at = now - s.ago
  const cwd = s.chat ? `${HOME}/Chats/${s.id}` : `${HOME}/dev/${s.project}`
  return {
    session_id: s.id,
    cwd,
    project: s.chat ? 'Chats' : s.project,
    model: s.model ?? 'claude-sonnet-sample',
    model_display: s.agent === 'codex' ? 'GPT (sample)' : 'Claude (sample)',
    started_at: at - 40 * MIN,
    last_event_at: at,
    worked_at: at,
    status: s.status ?? 'active',
    transcript_path: '',
    has_hooks: true,
    has_transcript: true,
    git_branch: s.chat ? '' : 'main',
    version: 'sample',
    owned: true,
    agent: s.agent ?? 'claude',
    chat: s.chat,
    description: s.description,
    description_source: 'title',
    title: s.description,
    stats: { session_id: s.id, turns: 12, tool_calls: 30, files_touched: 4, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: s.phrase, at: new Date(at).toISOString(), health: s.health },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    repo_root: s.chat ? undefined : cwd,
  }
}

/** A conversation as stored events: a prompt, tool calls with results, a reply. */
function conversation(sessionId: string, start: number, turns: [kind: 'user' | 'assistant' | 'tool', text: string, input?: Record<string, unknown>][], stopped = true): Event[] {
  const out: Event[] = []
  let id = 1
  turns.forEach(([kind, text, input], i) => {
    const ts = new Date(start + i * 20_000).toISOString()
    const base = { session_id: sessionId, source: 'transcript' as const, ts }
    if (kind === 'tool') {
      const use = `${sessionId}-tool-${i}`
      out.push({ ...base, id: id++, kind: 'tool.pre', tool: text, payload: { tool_name: text, tool_input: input ?? {}, tool_use_id: use } })
      out.push({ ...base, id: id++, kind: 'tool.post', tool: text, payload: { tool_use_id: use, tool_response: 'ok (sample output)' } })
    } else {
      out.push({ ...base, id: id++, kind: kind === 'user' ? 'turn.user' : 'turn.assistant', payload: kind === 'user' ? { prompt: text } : { text } })
    }
  })
  // The turn's Stop: the agent is not still thinking about the last reply.
  if (stopped) out.push({ id: id++, session_id: sessionId, source: 'hook', ts: new Date(start + turns.length * 20_000).toISOString(), kind: 'agent.stop', payload: {} })
  return out
}

export function buildFixture(now: number): Fixture {
  const work: Spec[] = [
    { id: 'demo-mail', project: 'caprock', description: 'Run the migration on a copy of the database first?', health: 'waiting-on-you', phrase: 'asks to run a command', ago: 2 * MIN },
    { id: 'demo-notes', project: 'notes', description: 'Sort the reading list by topic', health: 'working', phrase: 'editing reading-list.md', ago: 1 * MIN },
    { id: 'demo-tests', project: 'caprock', description: 'Running the Windows tests', health: 'working', phrase: 'running go test', ago: 0, agent: 'codex', model: 'gpt-sample' },
    { id: 'demo-dotfiles', project: 'dotfiles', description: 'Tidy the shell aliases', health: 'idle', phrase: 'done for now', ago: 12 * MIN },
    { id: 'demo-web', project: 'caprock-web', description: 'Rewrite the landing page intro', health: 'ended', phrase: 'finished', ago: 50 * MIN, status: 'ended' },
  ]
  const chatSpecs: Spec[] = [
    { id: 'demo-chat-relay', project: 'Chats', description: 'Ask about the relay timeout', health: 'idle', phrase: 'answered', ago: 60 * MIN, chat: true },
    { id: 'demo-chat-backup', project: 'Chats', description: 'Compare two SQLite backup tools', health: 'idle', phrase: 'answered', ago: 3 * 60 * MIN, chat: true },
    { id: 'demo-chat-trip', project: 'Chats', description: 'Plan a weekend of trail running', health: 'idle', phrase: 'answered', ago: 26 * 60 * MIN, chat: true },
  ]
  const sessions = work.map((s) => summary(s, now))
  const chats = chatSpecs.map((s) => summary(s, now))

  const events: Record<string, Event[]> = {
    'demo-mail': conversation('demo-mail', now - 12 * MIN, [
      ['user', 'Why do the mail tests fail only on Windows?'],
      ['tool', 'Read', { file_path: `${HOME}/dev/caprock/internal/mail/engine/conn.go` }],
      ['tool', 'Bash', { command: 'go test ./internal/mail/...' }],
      ['assistant', 'The test sets HOME to a temporary folder, but on Windows the home folder comes from USERPROFILE, so the token is read from the real one.\n\nI can set both in the test helper. Should I?'],
      ['user', 'Yes, set both and run the tests again on Windows.'],
      ['tool', 'Edit', { file_path: `${HOME}/dev/caprock/internal/mail/engine/silent_test.go` }],
      ['assistant', 'Both are set now. The fix also needs the schema change from yesterday. Run the migration on a copy of the database first?'],
    ]),
    'demo-notes': conversation('demo-notes', now - 20 * MIN, [
      ['user', 'Sort the reading list by topic and drop the duplicates.'],
      ['tool', 'Read', { file_path: `${HOME}/dev/notes/reading-list.md` }],
      ['assistant', 'There are 41 entries in six topics, and three links appear twice. Sorting now.'],
      ['tool', 'Edit', { file_path: `${HOME}/dev/notes/reading-list.md` }],
    ], false),
    'demo-tests': conversation('demo-tests', now - 8 * MIN, [
      ['user', 'Run the Windows tests and tell me what fails.'],
      ['tool', 'Bash', { command: 'go test ./...' }],
      ['assistant', 'Running the whole suite; I will report the failures when it finishes.'],
      ['tool', 'Bash', { command: 'go test -count=1 ./internal/...' }],
    ], false),
    'demo-dotfiles': conversation('demo-dotfiles', now - 30 * MIN, [
      ['user', 'Tidy the shell aliases: group them and remove the ones I never use.'],
      ['tool', 'Read', { file_path: `${HOME}/dev/dotfiles/aliases.zsh` }],
      ['assistant', 'Grouped them into git, files and network, and removed four aliases that point at tools that are no longer installed.'],
    ]),
    'demo-web': conversation('demo-web', now - 90 * MIN, [
      ['user', 'Rewrite the landing page intro in two short paragraphs.'],
      ['tool', 'Edit', { file_path: `${HOME}/dev/caprock-web/index.html` }],
      ['assistant', 'Done: two paragraphs, the first says what it is, the second who it is for.'],
    ]),
    'demo-chat-relay': conversation('demo-chat-relay', now - 70 * MIN, [
      ['user', 'Why would a WebSocket through a relay drop after exactly sixty seconds?'],
      ['assistant', 'Usually an idle timeout on a proxy in between. Sending a small ping every 25 seconds keeps it open.'],
    ]),
    'demo-chat-backup': conversation('demo-chat-backup', now - 190 * MIN, [
      ['user', 'Compare two ways to back up an SQLite database that is in use.'],
      ['assistant', 'The online backup API copies pages while the database stays usable; VACUUM INTO writes a compact copy in one statement. Both are safe while it is in use.'],
    ]),
    'demo-chat-trip': conversation('demo-chat-trip', now - 26 * 60 * MIN, [
      ['user', 'Plan a weekend of trail running for a beginner.'],
      ['assistant', 'Saturday: an easy hour on a flat trail. Sunday: a shorter run with a few gentle climbs, walking the steep parts.'],
    ]),
  }

  const permissions: Record<string, Permission> = {
    'demo-mail': { id: 'demo-perm', tool: 'Bash', detail: 'cp caprock.db /tmp/caprock-copy.db && go run ./cmd/migrate --db /tmp/caprock-copy.db', since: new Date(now - 2 * MIN).toISOString() },
  }

  const projects: Project[] = [
    { id: '1', name: 'caprock', root: `${HOME}/dev/caprock`, kind: 'repo', branch: 'main', last_activity: now, waiting: 1 },
    { id: '2', name: 'notes', root: `${HOME}/dev/notes`, kind: 'folder', last_activity: now - MIN },
    { id: '3', name: 'dotfiles', root: `${HOME}/dev/dotfiles`, kind: 'repo', branch: 'main', last_activity: now - 12 * MIN },
    { id: '4', name: 'caprock-web', root: `${HOME}/dev/caprock-web`, kind: 'repo', branch: 'main', last_activity: now - 50 * MIN },
  ]

  const status = {
    version: 'sample',
    platform: 'darwin/arm64',
    pid: 1,
    started_at: now - 3 * 60 * MIN,
    uptime_s: 3 * 3600,
    url: 'http://127.0.0.1:22776',
    data_dir: `${HOME}/Library/Application Support/caprock`,
    pricing: { version: 'sample', source: 'sample', fetched_at: '', user_override: false, models: 0 },
    ui_built: true,
    claude_available: true,
  } as unknown as Status

  return {
    status,
    pairMe: { role: 'controller', id: 'demo-phone', name: 'This iPhone', via: 'relay' as PairMe['via'] },
    // A licence that is on and no plans: nothing on any screen offers a sale.
    premium: { license: { active: true, in_grace: false } },
    projects,
    sessions,
    chats,
    events,
    permissions,
    inbox: {
      items: [{ id: 1, text: 'Ask about the relay timeout', files: [], from_device: 'This iPhone', created_at: now - 60 * MIN }],
      max: 500,
    },
    limits: {
      rate_limits: {
        five_hour: { used_percentage: 34, resets_at: Math.floor((now + 140 * MIN) / 1000) },
        seven_day: { used_percentage: 21, resets_at: Math.floor((now + 4 * 24 * 60 * MIN) / 1000) },
      },
    },
    catalog: {
      agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }],
      licensed: true,
    },
  }
}

/** One session's page: its summary, plus what the session screen reads with it. */
export function detail(f: Fixture, id: string): SessionDetail | undefined {
  const s = [...f.sessions, ...f.chats].find((x) => x.session_id === id)
  if (!s) return undefined
  return { ...s, files: [], events: f.events[id] ?? [] }
}

/** The Chats screen's page. */
export function chatList(f: Fixture, limit: number): ChatList {
  return { items: f.chats.slice(0, limit > 0 ? limit : undefined), total: f.chats.length, chats: f.chats.length, archived: 0 }
}
