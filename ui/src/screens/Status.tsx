/**
 * Settings (#/settings).
 *
 * The owner's verdict on the screen this replaced (translated): "honestly,
 * NOTHING here is understandable, and it should be easy and simple." It was
 * one panel of mixed checkboxes, a plan you could see but had to change
 * somewhere else, a phone switch that took a paragraph to explain, and a
 * diagnostic table nobody but us reads.
 *
 * Now: short sections with plain titles, in the order people come here for
 * them — the phone first, because that is what the owner opened it for. Every
 * option says in one line what happens when it is on. Anything only a few
 * people need (the memory experiment, storage composition, the daemon's own
 * figures) is one click down, not on screen.
 *
 * A paired device sees only what it may: appearance (stored in its own
 * browser), storage and the install details. Settings and pairing change on
 * the machine Caprock runs on (ADR-029), and the daemon refuses them anyway.
 */
import { useEffect, useRef, useState } from 'react'
import { ThemePicker } from '@/components/ThemePicker'
import { FaceDefaultSetting } from '@/components/SessionFace'
import { api, isPairedDevice, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { SettingsNav } from '@/components/SettingsNav'
import { fmtDuration, fmtUSD } from '@/lib/format'
import { Empty } from '@/components/ui'
import { PlanOptions, usePlan } from '@/components/PlanPicker'
import { AccountPlans, planText } from '@/components/AccountPlan'
import { subscriptionsFor, useSubscriptionList } from '@/components/SubscriptionPicker'
import { LicenseField } from '@/components/LicenseField'
import { Computers } from '@/components/Computers'
import { Pairing, revealWhenDrawn, settingsSectionId } from '@/components/Pairing'
import { PhoneAlerts } from '@/components/PhoneAlerts'
import { TelegramChat } from '@/components/TelegramChat'
import { DesktopNotifications } from '@/components/DesktopNotifications'
import { StoragePanel } from '@/components/Storage'
import { Choice, Details, Section, Toggle } from '@/components/SettingsParts'
import { GlobalHotkey } from '@/components/GlobalHotkey'
import { isAppMode, isMacPlatform, isTauri } from '@/lib/appmode'
import { useSidebarMode, type SidebarMode } from '@/lib/sidebarMode'
import { useTodayCard } from '@/lib/todayCard'
import { UI_SCALES, setUiScale, useUiScale, type UiScale } from '@/lib/uiscale'
import { TerminalSettings } from '@/components/TerminalSettings'
import { BrowserSetting } from '@/components/BrowserSetting'
import { StatuslineSetting } from '@/components/StatuslineSetting'
import { EditorSetting } from '@/components/EditorSetting'
import { DefaultFolderSetting } from '@/components/DefaultFolderSetting'
import { CustomAgentsSetting } from '@/components/CustomAgentsSetting'
import { SavedPromptsSetting } from '@/components/SavedPromptsSetting'
import { TemplatesSetting } from '@/components/TemplatesSetting'
import { SubscriptionsSetting } from '@/components/SubscriptionsSetting'
import { SpawnModeSetting } from '@/components/SpawnModeSetting'
import { KeepAwakeSetting } from '@/components/KeepAwake'
import { AgentCloseSetting } from '@/components/AgentCloseSetting'
import { WorktreeCleanupSetting } from '@/components/WorktreeCleanupSetting'
import { GitHubSettings } from '@/components/GitHubSettings'
import { WindowStopSetting } from '@/components/WindowStopSetting'
import { Locked } from '@/components/Locked'
import { BrainAutoSetting } from '@/components/BrainAutoSetting'
import { UpdatesSetting } from '@/components/UpdatesSetting'
import { CloseButton, dialogOpen } from '@/components/Dialog'
import { escapeLeavesPage, useCloseSettings } from '@/lib/settingsClose'
import { CaprockItself } from '@/components/ResourceMeter'
import { signIns } from '@/lib/subscriptions'
import { parseHash } from '@/lib/router'

/**
 * The page's own way out (lib/settingsClose.ts): a × beside the heading, and
 * Escape from anywhere on the page but a field or an open dialog. In the app
 * both do what the Settings tab's × does.
 */
function useSettingsEscape(close: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOpen() && escapeLeavesPage(e)) { e.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
}

const EXPLAIN_KEY = 'caprock-settings-explain'

/** Whether Settings shows its explanations; off by default, kept per viewer. */
function useExplain(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { return localStorage.getItem(EXPLAIN_KEY) === 'on' } catch { return false } })
  return [v, (next) => { setV(next); try { localStorage.setItem(EXPLAIN_KEY, next ? 'on' : 'off') } catch { /* private window */ } }]
}

function SettingsHeading({ onClose, explain, onExplain }: { onClose: () => void; explain?: boolean; onExplain?: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-1 pt-1">
      <h1 className="min-w-0 flex-1 text-[24px] font-semibold text-fg">Settings</h1>
      {onExplain && (
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-fg-muted">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={!!explain} onChange={(e) => onExplain(e.target.checked)} />
          Show explanations
        </label>
      )}
      <CloseButton onClick={onClose} label="Close settings" title="Close settings (Esc)" />
    </div>
  )
}

/**
 * #/settings/phone and #/settings/telegram: once the page has drawn, bring
 * that section into view, unfolded and lit for a moment (Pairing's
 * revealSection). Only scrolls: a link never shows a pairing code, which
 * turns network access on — that takes a click (openSettingsSection).
 */
function useSectionLink(ready: boolean) {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const route = parseHash(hash)
  const section = route.name === 'settings' ? route.section : undefined
  useEffect(() => {
    if (ready && section) revealWhenDrawn(settingsSectionId(section))
  }, [ready, section])
}

export function StatusScreen() {
  const close = useCloseSettings()
  useSettingsEscape(close)
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 5000 })
  const page = useRef<HTMLDivElement>(null)
  const [explain, setExplain] = useExplain()
  const s = st.data
  useSectionLink(!!s)
  const head = <SettingsHeading onClose={close} explain={explain} onExplain={setExplain} />
  if (st.error && !s) return <div className="mx-auto grid w-full max-w-3xl gap-3">{head}<Empty title="Cannot reach the daemon">{st.error.message}</Empty></div>
  if (!s) return <div className="mx-auto grid w-full max-w-3xl gap-3">{head}<div className="px-1 text-fg-muted">loading…</div></div>
  const owner = !isPairedDevice()
  return (
    <div className="flex w-full justify-center gap-6">
    <SettingsNav root={page} />
    <div ref={page} data-settings-explain={explain ? 'on' : 'off'} className="grid w-full max-w-3xl gap-3">
      {head}
      {/* Problems first: each one means something is not being captured or
        * cannot be started, and none of them is a preference. */}
      <Problems s={s} />
      {/* The phone first, then Telegram beside it, everywhere: in the app
        * it was eighth of eleven and the owner could not find it from the
        * sidebar's "phone, Telegram" (2026-10-13). #/settings/phone and
        * #/settings/telegram land on them. */}
      {owner && <Pairing />}
      {owner && <PhoneAlerts />}
      {owner && <TelegramChatSection />}
      {/* The other computers this one reaches (ADR-067): the sidebar's
        * "+ Add a machine" and #/settings/computers land here. */}
      {owner && <Computers />}
      {/* After the phone and Telegram, in the desktop app what you change
        * while working: how a new agent starts, how the window and terminal
        * look, which editor opens. */}
      {isAppMode() && (
        <>
          {owner && <SpawnModeSetting />}
          {owner && <KeepAwakeSetting />}
          <AgentCloseSetting />
          {owner && <SavedPromptsSetting />}
          {owner && <TemplatesSetting />}
          <AppearanceSection />
          <TerminalSettings />
          {isTauri() && <BrowserSetting />}
          {owner && <StatuslineSetting />}
          {owner && <EditorSetting />}
          {owner && <DefaultFolderSetting />}
          {owner && <WorktreeCleanupSetting />}
          {owner && <SubscriptionsSetting />}
          {owner && <CustomAgentsSection />}
          {owner && isTauri() && <DesktopNotifications />}
          {owner && isTauri() && <GlobalHotkey />}
          <GitHubSettings />
          {owner && <PlanSection />}
          {owner && <WindowStopSection />}
        </>
      )}
      {!isAppMode() && (
        <>
          {owner && isTauri() && <DesktopNotifications />}
          {owner && <PlanSection />}
          {owner && <WindowStopSection />}
          <AppearanceSection />
          {owner && <SpawnModeSetting />}
          {owner && <KeepAwakeSetting />}
          {owner && <SavedPromptsSetting />}
          {owner && <TemplatesSetting />}
          {owner && <StatuslineSetting />}
          {owner && <EditorSetting />}
          {owner && <DefaultFolderSetting />}
          {owner && <WorktreeCleanupSetting />}
          {owner && <SubscriptionsSetting />}
          {owner && <CustomAgentsSection />}
          <GitHubSettings />
          {owner && isTauri() && <GlobalHotkey />}
        </>
      )}
      {owner && <UpdatesSetting />}
      {owner && <PrivacySection />}
      {owner && <MemorySection />}
      {owner && <BrainSection />}
      <StoragePanel />
      <AboutSection s={s} />
    </div>
    </div>
  )
}

function PlanSection() {
  const [plan, savePlan] = usePlan()
  // More than one Claude Code sign-in: a plan per account (AccountPlan).
  const accounts = signIns(subscriptionsFor(useSubscriptionList().all, 'claude'))
  if (!plan) return null
  const current = planText(plan, fmtUSD) || 'not set'
  return (
    <Section title="Plan & licence">
      {accounts.length > 1 ? (
        <div className="grid gap-2">
          <p className="text-[12px] leading-relaxed text-fg-muted">
            How you pay for each Claude Code account, so Caprock can set its sessions&rsquo; usage against the right plan. It cannot detect this, so it asks. An account with no plan of its own uses the main one, your own sign-in&rsquo;s.
          </p>
          <AccountPlans list={accounts} main={plan} saveMain={savePlan} />
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-fg">Your plan:</span>
            <span className={`mono ${plan.plan_kind ? 'text-fg' : 'text-accent'}`}>{current}</span>
          </div>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            How you pay for Claude Code, so Caprock can set your usage against it. It cannot detect this, so it asks.
          </p>
          <div className="max-w-sm rounded-md border border-border p-1.5">
            <PlanOptions plan={plan} onSave={savePlan} />
          </div>
        </div>
      )}
      <div className="border-t border-border pt-3">
        <LicenseField plan={plan} save={savePlan} />
      </div>
    </Section>
  )
}

/** The plan-window stop (Premium): live with a licence, behind glass without
 *  one — the control in the place it will be, with this machine's figures. */
function WindowStopSection() {
  return (
    <Locked feature="window" title="Pause Caprock's sessions before the plan limit">
      <WindowStopSetting />
    </Locked>
  )
}

/** Talking to the agents from Telegram (Premium, ADR-047): live with a
 *  licence, behind glass without one, under the free alerts it builds on. */
function TelegramChatSection() {
  return (
    <Locked feature="telegram" title="Talk to your agents from Telegram">
      <TelegramChat />
    </Locked>
  )
}

/** Second Brain built automatically (ADR-063): free for everyone, off
 *  until the user says yes (owner decision, 2026-10-14). */
function BrainSection() {
  return <BrainAutoSetting />
}

/** Custom agents (Premium, ADR-046): live with a licence, behind glass
 *  without one, in the place they will be. */
function CustomAgentsSection() {
  return (
    <Locked feature="agents" title="Add your own coding agents">
      <CustomAgentsSetting />
    </Locked>
  )
}

function AppearanceSection() {
  return (
    <Section title="Appearance">
      {/* The palettes as large swatches, Dark then Light; hovering one tries it on the page. */}
      <ThemePicker size="cards" />
      {isTauri() && <InterfaceSize />}
      <SidebarModeSetting />
      <TodayCardSetting />
      <FaceDefaultSetting />
      <p className="text-[12px] text-fg-muted">Saved in this browser only.</p>
    </Section>
  )
}

/** Projects (Tree) or Tabs (Flat, the tabs' order): lib/sidebarMode.ts. */
function SidebarModeSetting() {
  const [mode, setMode] = useSidebarMode()
  return (
    <div className="space-y-1">
      <Choice<SidebarMode>
        label="Sidebar"
        value={mode}
        options={[{ value: 'tree', label: 'Projects' }, { value: 'flat', label: 'Tabs' }]}
        onChange={setMode}
      />
      <p className="text-[12px] text-fg-muted">
        Projects lists the sessions under their projects; Tabs puts them in one list in the tabs&rsquo; order, each with its tab&rsquo;s key. The same switch sits beside the sidebar&rsquo;s heading.
      </p>
    </div>
  )
}

/** The sidebar's Today card, hidden from its own menu and brought back here (lib/todayCard.ts). */
function TodayCardSetting() {
  const [card, setCard] = useTodayCard()
  return (
    <Toggle
      checked={!card.hidden}
      onChange={(v) => setCard({ hidden: !v })}
      label="Today card in the sidebar"
      hint="Spend, running, waiting and the plan windows above the session list; its chevron folds it to one line. Hidden, what waits on you is counted beside the list's heading."
    />
  )
}

/** The desktop app's zoom; a browser has its own (lib/uiscale). */
function InterfaceSize() {
  const scale = useUiScale()
  const isMac = isMacPlatform()
  return (
    <div className="space-y-1">
      <Choice
        label="Interface size"
        value={String(scale)}
        options={UI_SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }))}
        onChange={(v) => setUiScale(Number(v) as UiScale)}
      />
      <p className="text-[12px] text-fg-muted">
        Or {isMac ? '⌘+ and ⌘−, ⇧⌘0 to reset' : 'Ctrl+Shift+= and Ctrl+Shift+−; reset from ⌘K'}.
      </p>
    </div>
  )
}

function PrivacySection() {
  const [plan] = usePlan()
  if (!plan) return null
  return (
    <Section title="Privacy">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        The release check {plan.update_checks ? 'is on' : 'is off'} (Updates, above): it asks GitHub for the latest version number,
        and with Update automatically the app then downloads that version from GitHub. Apart from it, the Telegram messages you set
        up yourself and GitHub once you connect it, Caprock sends nothing over the internet. Everything else stays on this computer.
      </p>
    </Section>
  )
}

function MemorySection() {
  const [plan, savePlan] = usePlan()
  if (!plan) return null
  const on = plan.memory !== false
  return (
    <Section title="Memory between sessions">
      {/* Says what Claude gets, not how: "a new session" was our jargon, and
        * "remind Claude" read as an instruction to the reader. */}
      <Toggle
        checked={on}
        onChange={(v) => savePlan({ memory: v })}
        label="Claude knows what you did here last time"
        hint="When you start Claude in a folder, it is handed the last thing a session there wrote — a few paragraphs, from the past two weeks. Quick chats are skipped."
      />
      {on && (
        <Details summary="Experiments">
          <Toggle
            checked={(plan.memory_holdout_pct ?? 0) > 0}
            onChange={(v) => savePlan({ memory_holdout_pct: v ? 25 : 0 })}
            label="Measure whether it helps"
            hint="One new session in four starts without it, and the Memory screen compares how fast each kind gets to its first edit."
          />
        </Details>
      )}
    </Section>
  )
}

/** Things that are wrong, each with the one action that fixes it. */
function Problems({ s }: { s: Status }) {
  const missingHooks = s.hooks ? (s.hooks.missing ?? []) : []
  return (
    <>
      {/* A dead tailer meant nothing was being captured while every other row
        * on this screen looked healthy. */}
      {s.ingest_error && (
        <Section title="Nothing new is being recorded" explained>
          <p className="text-fg-muted">
            <span className="mono text-fg break-all">{s.ingest_error}</span>. Check that
            <span className="mono text-fg"> ~/.claude</span> is readable, then restart with
            <span className="mono text-fg"> caprock down &amp;&amp; caprock up</span>.
          </p>
        </Section>
      )}
      {!s.claude_available && (
        <Section title="Claude Code was not found" explained>
          <p className="text-fg-muted">
            Caprock cannot start sessions for you, but it still records every session you start yourself. Install
            Claude Code, or make sure <span className="mono">claude</span> is on the PATH Caprock was started with.
          </p>
        </Section>
      )}
      {missingHooks.length > 0 && (
        <Section title="Live activity is a few seconds late" explained>
          <p className="text-fg-muted">
            Some Claude Code hooks are missing (<span className="mono break-all">{missingHooks.join(', ')}</span>). Run{' '}
            <span className="mono text-fg">caprock hooks install</span> to see activity as it happens.
          </p>
        </Section>
      )}
    </>
  )
}

/** The daemon's own figures — for a bug report, not for deciding anything. */
function AboutSection({ s }: { s: Status }) {
  const rows: [string, string][] = [
    ['version', s.version],
    ['url', s.url],
    ['pid', String(s.pid)],
    ['uptime', fmtDuration(s.uptime_s * 1000)],
    ['data dir', s.data_dir],
    ['pricing', `${s.pricing.version} · ${s.pricing.models} models · fetched ${s.pricing.fetched_at}${s.pricing.user_override ? ' · user override' : ''}`],
    ['pricing source', s.pricing.source],
    ['loop rule', `≥ ${s.loop_k} same-tool calls in ${s.loop_t_minutes} min · ${s.active_loops} active`],
    ['events stored', `${s.events.toLocaleString()}${s.retention_days > 0 ? ` · pruned after ${s.retention_days}d` : ' · kept forever (see Storage)'}`],
    ['orchestration', s.orchestration ? 'on (--hive)' : 'off'],
    // A feature that acts before you type is one nobody can see working. This
    // says whether it can, and for how much — and names the screen to look at.
    ['memory', s.memory && s.memory.repos > 0
      ? `on in ${s.memory.repos} ${s.memory.repos === 1 ? 'folder' : 'folders'}${s.memory.held ? `, held since ${s.memory.held}` : ''} — search it under Memory`
      : 'nothing to carry over yet — it starts once a session leaves something behind'],
    // Spawning needs the binary. When it is missing every spawn control is
    // disabled and nothing anywhere said why.
    ['claude', s.claude_available
      ? 'found on PATH — Caprock can start sessions for you'
      : 'not found on PATH — Caprock cannot start sessions, but still observes every session you start yourself'],
    ['dashboard', s.ui_built ? 'embedded build' : 'dev server / placeholder'],
  ]
  if (s.hooks) rows.push(['hooks', `${(s.hooks.installed ?? []).length}/${(s.hooks.installed ?? []).length + (s.hooks.missing ?? []).length} events registered in ${s.hooks.settings_path}${s.hooks.shim_exists ? '' : ' (shim missing)'}`])
  if (s.desktop) {
    // Percentages of a plan window, not tokens or cost — the file holds nothing
    // else, and implying otherwise would be an invented number. The app only
    // samples while it is running, so a stale reading says so.
    const d = s.desktop
    rows.push([
      'claude desktop',
      `${d.five_hour_pct}% of the 5-hour window · ${d.seven_day_pct}% of the 7-day${d.stale ? ' · last seen ' + new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', app closed since' : ' · now'}`,
    ])
  }
  // A distinct key: React renders these rows keyed by name, and the live
  // ingest row below uses 'ingest'.
  if (s.ingest_error) rows.push(['ingest error', `STOPPED: ${s.ingest_error} — nothing is being captured`])
  if (s.ingest) rows.push(['ingest', `${s.ingest.files_known} transcripts · ${s.ingest.events_stored} events stored · ${s.ingest.events_deduped} deduped · ${s.ingest.lines_malformed} malformed lines · backfill ${s.ingest.backfill_done ? 'done' : 'running'}`])
  return (
    <Section title="About this install">
      <p className="text-fg-muted">
        Caprock <span className="mono text-fg">{s.version}</span> · running for {fmtDuration(s.uptime_s * 1000)} ·{' '}
        <span className="num text-fg">{s.events.toLocaleString()}</span> events recorded
      </p>
      <CaprockItself owner={!isPairedDevice()} />
      <Details summary="Details">
        {/* Scrolls inside itself on a narrow screen rather than pushing the
          * page sideways — the fault on a phone is a body that scrolls
          * horizontally, not a table that is cut off. */}
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-b border-border/60 last:border-0">
                  <td className="w-32 py-1 pr-3 align-top text-fg-muted">{k}</td>
                  <td className="mono break-all py-1">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Details>
    </Section>
  )
}
