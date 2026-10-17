/**
 * Settings → Subscriptions (ADR-048): more than one sign-in to Claude Code or
 * Codex, and the one a new session runs on picked in New agent and Quick chat.
 *
 * The owner, 2026-10-10 (translated): "make subscription management so
 * several subscriptions can be authorised and you can work through them."
 *
 * Each subscription is a folder of Caprock's that the agent uses as its
 * configuration directory, so it keeps its own sign-in. Adding one makes the
 * folder and types the agent's own sign-in command into a shell tab, not
 * run; the user presses Enter and signs in there. Caprock never sees a
 * password or a token: whether a folder is signed in is read from what the
 * agent wrote. Three per agent are free, the user's own sign-in included; a
 * fourth is Premium, and the daemon refuses it (402) whatever the page does.
 *
 * Self-contained: one section, its own fetching and state, so the Settings
 * screen places it and nothing else.
 */
import { useState, type ReactNode } from 'react'
import { api, errText, type Settings, type Subscription, type SubscriptionAgentId, type SubscriptionsResponse, ApiError } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { currentWindows, forgetAgentPicks, forgetSubscription, resetText, signIns, windowLabel, DEEPSEEK_ID, NEAR_PCT } from '@/lib/subscriptions'
import { planFields, planText } from './AccountPlan'
import { subscriptionsChanged, useSubscriptionsChanged } from './SubscriptionPicker'
import { useSetupShell } from '@/lib/setupShell'
import { PremiumModal } from './PremiumModal'
import { Section } from './SettingsParts'
import { SecretField, type SecretProvider } from './SecretField'
import { extTitle } from '@/lib/externalLinks'

const AGENT_LABEL: Record<SubscriptionAgentId, string> = { claude: 'Claude Code', codex: 'Codex' }

export function SubscriptionsSetting() {
  const res = useApi(() => api.subscriptions(), [], { live: false, intervalMs: 10_000 })
  useSubscriptionsChanged(res.refresh)
  const data = res.data
  return (
    <Section id="subscriptions" title="Subscriptions">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Sign in to Claude Code or Codex more than once — a work account and your own, say — and pick which one a new session runs on in <span className="text-fg">New agent</span> and <span className="text-fg">Quick chat</span>; the one marked <span className="text-fg">default</span> is used when you pick none. Each sign-in lives in its own folder; you sign in with the agent’s own command, and Caprock never sees a password or token.
      </p>
      {!data && res.error && <p className="text-[12px] text-fg-faint">This daemon does not offer subscriptions yet.</p>}
      {data && <SubscriptionsBody data={data} refresh={() => res.refresh?.()} />}
    </Section>
  )
}

function SubscriptionsBody({ data, refresh }: { data: SubscriptionsResponse; refresh: () => void }) {
  const setupShell = useSetupShell()
  // The sign-in command waiting to be run, for a browser with no tabs to put it in.
  const [toRun, setToRun] = useState<{ what: string; command: string } | null>(null)
  // The agent's own sign-in or sign-out, typed into a shell tab, never run.
  const run = (what: string, command: string) => {
    if (setupShell) setupShell(command, data.home)
    else setToRun({ what, command })
  }
  const signIn = (s: Subscription) => run(`sign ${s.label} in`, s.login_command)
  const signOut = (s: Subscription) => { if (s.logout_command) run(`sign ${s.label} out`, s.logout_command) }
  const groups = data.agents.filter((g) => g.installed || signIns(g.subscriptions).length > 1)
  return (
    <div className="grid gap-4">
      {groups.length === 0 && <p className="text-[12px] text-fg-faint">Neither Claude Code nor Codex is installed here.</p>}
      {groups.map((g) => (
        <AgentGroup key={g.agent} agent={g.agent} list={signIns(g.subscriptions)} ignoredEnv={g.ignored_env ?? []} onSignIn={signIn} onSignOut={signOut} refresh={refresh}>
          {g.agent === 'claude' && <DeepSeekKey entry={g.subscriptions.find((s) => s.id === DEEPSEEK_ID)} refresh={refresh} />}
        </AgentGroup>
      ))}
      {toRun && <CommandToRun what={toRun.what} command={toRun.command} onClose={() => setToRun(null)} />}
      <AddSubscription data={data} onAdded={(s) => { refresh(); signIn(s) }} />
      <p className="text-[11.5px] leading-snug text-fg-faint">
        {data.free_per_agent} per agent are free, your own sign-in included{data.licensed ? '; Premium adds more.' : '.'} A new subscription starts with the agent’s own defaults: your settings, plugins and servers in <span className="mono">~/.claude</span> or <span className="mono">~/.codex</span> are not copied. You choose which subscription each session uses; Caprock never switches one for you.
      </p>
      {/* Claude Code's docs: a Console sign-in without an API key is stored
          outside the configuration directory, so folders do not separate two. */}
      <p className="text-[11.5px] leading-snug text-fg-faint">
        Claude Code keeps each claude.ai sign-in, and each Console sign-in that made an API key, in its own folder. A Console sign-in without an API key is kept outside the folders, so two of those are not kept apart.
      </p>
    </div>
  )
}

function AgentGroup({ agent, list, ignoredEnv, onSignIn, onSignOut, refresh, children }: {
  agent: SubscriptionAgentId
  list: Subscription[]
  ignoredEnv: string[]
  onSignIn: (s: Subscription) => void
  onSignOut: (s: Subscription) => void
  refresh: () => void
  children?: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <h3 className="text-[12px] font-medium text-fg-muted">{AGENT_LABEL[agent]}</h3>
      <ul className="grid gap-1.5" aria-label={`${AGENT_LABEL[agent]} subscriptions`}>
        {list.map((s) => <SubscriptionRow key={s.id} sub={s} onSignIn={() => onSignIn(s)} onSignOut={() => onSignOut(s)} refresh={refresh} choice={list.length > 1} />)}
      </ul>
      {ignoredEnv.length > 0 && (
        <p role="note" className="text-[12px] leading-snug text-fg-muted">
          Your shell sets {ignoredEnv.map((n, i) => <span key={n}>{i > 0 && ', '}<span className="mono text-fg">{n}</span></span>)}. {AGENT_LABEL[agent]} would use {ignoredEnv.length === 1 ? 'it' : 'them'} instead of a folder’s sign-in, so a session on a subscription added here starts without {ignoredEnv.length === 1 ? 'it' : 'them'}; sessions on your own sign-in keep {ignoredEnv.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {children}
    </div>
  )
}

/**
 * Claude Code on DeepSeek: the user's own DeepSeek key, pasted here. Set, it
 * adds "DeepSeek" to the Subscription picker in New agent and Quick chat; a
 * session started on it gets the key in its own environment and talks to
 * DeepSeek's Anthropic-compatible API. Free. The key is write-only: the
 * daemon says whether one is set and shows its first and last characters.
 */
export const DEEPSEEK_PROVIDER: SecretProvider = {
  name: 'DeepSeek',
  host: 'api.deepseek.com',
  sentWhen: 'from the environment of a session you start on DeepSeek, when that session talks to the model.',
  revokeAt: 'platform.deepseek.com/api_keys',
  revokeHow: 'delete the key there.',
}

export function DeepSeekKey({ entry, refresh }: { entry?: Subscription; refresh: () => void }) {
  const st = useApi(() => api.settings(), [], { live: false })
  const set = !!st.data?.deepseek_key_set
  const save = async (key: string) => {
    await api.saveSettings({ deepseek_api_key: key } as Partial<Settings> as Settings)
    st.refresh?.()
    refresh()
    subscriptionsChanged()
  }
  return (
    <div className="grid gap-1.5 rounded-[8px] border border-border px-3 py-2" aria-label="DeepSeek">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium text-fg">DeepSeek</span>
        <span className="text-[12px] text-fg-muted">{set ? 'key saved' : 'off'}</span>
        {entry && entry.running > 0 && <span className="text-[12px] text-fg-faint">· {entry.running} running</span>}
        {entry && entry.sessions_7d > 0 && <span className="mono text-[11.5px] text-fg-faint">· 7 days: {entry.sessions_7d} session{entry.sessions_7d === 1 ? '' : 's'}, {fmtUSD(entry.cost_7d_usd)}</span>}
      </div>
      {/* What it sends where stays visible with explanations off (rule 4). */}
      <p data-keep className="text-[12px] leading-snug text-fg-muted">
        Claude Code on your DeepSeek key: a session on it sends its prompts, files and tool output to api.deepseek.com. Caprock itself sends nothing.
      </p>
      <p className="text-[12px] leading-snug text-fg-muted">
        Pick <span className="text-fg">DeepSeek</span> under Subscription in New agent or Quick chat. DeepSeek bills your key; the session does not use your Claude plan or its limits, and the key goes only into that session&rsquo;s environment. Get a key at{' '}
        <a className="link" href="https://platform.deepseek.com/api_keys" target="_blank" title={extTitle()} rel="noreferrer">platform.deepseek.com</a>.
      </p>
      <SecretField
        label="DeepSeek API key"
        what="DeepSeek key"
        set={set}
        hint={st.data?.deepseek_key_hint}
        where={st.data?.deepseek_key_where}
        provider={DEEPSEEK_PROVIDER}
        placeholder={set ? 'Paste the new key' : 'sk-…'}
        saveLabel="Save key"
        removeLabel="Remove"
        onSave={async (k) => {
          try { await save(k) } catch (e) { throw new Error(errText(e)) }
        }}
        onRemove={async () => {
          try { await save('') } catch (e) { throw new Error(errText(e)) }
        }}
      />
    </div>
  )
}

function SubscriptionRow({ sub, onSignIn, onSignOut, refresh, choice }: { sub: Subscription; onSignIn: () => void; onSignOut: () => void; refresh: () => void; choice: boolean }) {
  const [mode, setMode] = useState<'' | 'rename' | 'remove'>('')
  const [name, setName] = useState(sub.label)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = Date.now() / 1000
  const windows = currentWindows(sub, now)

  const rename = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateSubscription(sub.id, { agent: sub.agent, label: name })
      setMode('')
      refresh()
      subscriptionsChanged()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  // Which folder Caprock gives the sessions it starts next: nothing about the
  // sign-in itself moves, and a running session stays where it is.
  const makeDefault = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateSubscription(sub.id, { agent: sub.agent, make_default: true })
      forgetAgentPicks(sub.agent)
      refresh()
      subscriptionsChanged()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await api.removeSubscription(sub.id)
      forgetSubscription(sub.id)
      refresh()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  return (
    <li className="grid gap-1.5 rounded-[8px] border border-border px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {mode === 'rename' ? (
          <input
            className="input h-[26px] w-48 text-[13px]"
            aria-label="Subscription name"
            value={name}
            autoFocus
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { e.stopPropagation(); setMode(''); setName(sub.label) } }}
          />
        ) : (
          <span className="text-[13px] font-medium text-fg">{sub.label}</span>
        )}
        {choice && sub.preferred && (
          <span className="rounded-sm border border-accent/50 px-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-accent" title="New sessions start on it when you pick none">default</span>
        )}
        <span className={`text-[12px] ${sub.signed_in ? 'text-fg-muted' : 'text-accent'}`}>
          {sub.signed_in ? (sub.account || 'signed in') : 'not signed in'}
        </span>
        {sub.running > 0 && <span className="text-[12px] text-fg-faint">· {sub.running} running</span>}
        {sub.plan && <span className="mono text-[11.5px] text-fg-faint">· {planText(planFields(sub.plan), fmtUSD)}</span>}
      </div>
      <p className="mono text-[11.5px] text-fg-muted">
        {windows.length === 0
          ? <span className="text-fg-faint">no plan figures yet{sub.agent === 'claude' ? ' — they arrive with its first session' : ''}</span>
          : windows.map((w, i) => (
            <span key={w.window}>
              {i > 0 && ' · '}
              <span className={w.used_percentage >= NEAR_PCT ? 'text-danger' : ''}>{windowLabel(w.window)} {Math.round(w.used_percentage)}%</span>
              {w.resets_at ? <span className="text-fg-faint"> resets {resetText(w.resets_at)}</span> : null}
            </span>
          ))}
        {sub.sessions_7d > 0 && <span className="text-fg-faint"> · 7 days: {sub.sessions_7d} session{sub.sessions_7d === 1 ? '' : 's'}, {fmtUSD(sub.cost_7d_usd)}</span>}
      </p>
      <p className="mono truncate text-[11px] text-fg-faint" title={sub.dir}>{sub.dir}{sub.default ? ' · your own sign-in' : ''}</p>
      {mode === 'remove' && (
        <p className="text-[12px] leading-snug text-fg">
          Remove {sub.label}? Its folder is deleted, with the sign-in, history and settings {sub.agent === 'codex' ? 'Codex' : 'Claude Code'} kept there. Sessions already recorded stay in Caprock.
        </p>
      )}
      {/* The Keychain or keyring is outside the folder, and Caprock never
          touches it: the agent's own sign-out removes what it put there. */}
      {mode === 'remove' && sub.signed_in && sub.logout_command && (sub.keychain_item || sub.agent === 'codex') && (
        <p className="text-[12px] leading-snug text-fg-muted">
          {sub.keychain_item
            ? <>On this Mac the sign-in itself is in the Keychain as <span className="mono text-fg">{sub.keychain_item}</span>, outside the folder.</>
            : <>If Codex keeps this sign-in in the system keyring, it is outside the folder.</>}
          {' '}Sign out first and {AGENT_LABEL[sub.agent]} removes it; Caprock does not touch it.{' '}
          <button type="button" onClick={onSignOut} className="text-accent hover:underline">Sign out first</button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        {mode === '' && (
          <>
            <button type="button" onClick={onSignIn} className="text-accent hover:underline">
              {sub.signed_in ? 'Sign in again' : 'Sign in'}
            </button>
            {choice && !sub.preferred && (
              <button type="button" disabled={busy} onClick={() => void makeDefault()} title="New sessions start on it when you pick none; running ones stay where they are" className="text-fg-muted hover:text-fg disabled:opacity-50">
                Make default
              </button>
            )}
            <button type="button" onClick={() => setMode('rename')} className="text-fg-muted hover:text-fg">Rename</button>
            {!sub.default && (
              <button
                type="button"
                disabled={sub.running > 0}
                title={sub.running > 0 ? 'A session Caprock started is running on it' : undefined}
                onClick={() => setMode('remove')}
                className="text-fg-muted hover:text-danger disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </>
        )}
        {mode === 'rename' && (
          <>
            <button type="button" disabled={busy} onClick={() => void rename()} className="text-accent hover:underline disabled:opacity-50">Save</button>
            <button type="button" onClick={() => { setMode(''); setName(sub.label) }} className="text-fg-muted hover:text-fg">Cancel</button>
          </>
        )}
        {mode === 'remove' && (
          <>
            <button type="button" disabled={busy} onClick={() => void remove()} className="text-danger hover:underline disabled:opacity-50">Remove {sub.label}</button>
            <button type="button" onClick={() => setMode('')} className="text-fg-muted hover:text-fg">Cancel</button>
          </>
        )}
        {error && <span role="alert" className="min-w-0 truncate text-danger" title={error}>{error}</span>}
      </div>
    </li>
  )
}

/** The add form, or — at the free number without a licence — the Premium path. */
function AddSubscription({ data, onAdded }: { data: SubscriptionsResponse; onAdded: (s: Subscription) => void }) {
  const installed = data.agents.filter((g) => g.installed).map((g) => g.agent)
  const [agent, setAgent] = useState<SubscriptionAgentId>(installed[0] ?? 'claude')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [premium, setPremium] = useState(false)
  const count = signIns(data.agents.find((g) => g.agent === agent)?.subscriptions ?? []).length || 1
  const atLimit = !data.licensed && count >= data.free_per_agent

  const add = async () => {
    if (atLimit) { setPremium(true); return }
    setBusy(true)
    setError('')
    try {
      const s = await api.addSubscription(agent, label)
      setLabel('')
      onAdded(s)
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) setPremium(true)
      else setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2 rounded-[8px] border border-border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          <span className="text-[12px] text-fg-muted">Agent</span>
          <select className="input h-[30px]" value={agent} onChange={(e) => setAgent(e.target.value as SubscriptionAgentId)}>
            {(['claude', 'codex'] as const).map((a) => <option key={a} value={a}>{AGENT_LABEL[a]}</option>)}
          </select>
        </label>
        <label className="grid min-w-[10rem] flex-1 gap-1">
          <span className="text-[12px] text-fg-muted">Name</span>
          <input className="input h-[30px]" placeholder="Work Max" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
        </label>
        <button type="button" disabled={busy || (!atLimit && !label.trim())} onClick={() => void add()} className="h-[30px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50">
          Add subscription
        </button>
      </div>
      {atLimit && (
        <p className="text-[12px] leading-snug text-fg-muted">
          {AGENT_LABEL[agent]} has {count} subscriptions, the free number. A fourth and more come with{' '}
          <button type="button" onClick={() => setPremium(true)} className="text-premium underline-offset-2 hover:underline">Premium</button>.
        </p>
      )}
      {!atLimit && <p className="text-[11.5px] leading-snug text-fg-faint">Adding opens a shell tab with the sign-in typed; press Enter there and sign in with the account you want.</p>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {premium && <PremiumModal feature="subscriptions" onClose={() => setPremium(false)} />}
    </div>
  )
}

/** In a browser: the sign-in to run in a terminal, with a copy button. */
function CommandToRun({ what, command, onClose }: { what: string; command: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div role="note" className="grid gap-1.5 rounded-[8px] border border-border p-3">
      <p className="text-[12px] text-fg">Run this in a terminal to {what}:</p>
      <code className="mono block overflow-x-auto whitespace-pre rounded-[6px] bg-panel-2 px-2 py-1.5 text-[12px] text-fg">{command}</code>
      <div className="flex gap-3 text-[12px]">
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true)) }} className="text-accent hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onClose} className="text-fg-muted hover:text-fg">Done</button>
      </div>
    </div>
  )
}
