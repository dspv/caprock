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
import { useEffect } from 'react'
import { useLightTone, useTheme } from '@/lib/theme'
import { api, isPairedDevice, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration, fmtUSD } from '@/lib/format'
import { Empty } from '@/components/ui'
import { PlanOptions, usePlan } from '@/components/PlanPicker'
import { LicenseField } from '@/components/LicenseField'
import { Pairing } from '@/components/Pairing'
import { PhoneAlerts } from '@/components/PhoneAlerts'
import { DesktopNotifications } from '@/components/DesktopNotifications'
import { StoragePanel } from '@/components/Storage'
import { Choice, Details, Section, Toggle } from '@/components/SettingsParts'
import { GlobalHotkey } from '@/components/GlobalHotkey'
import { isAppMode, isTauri } from '@/lib/appmode'
import { TerminalSettings } from '@/components/TerminalSettings'
import { EditorSetting } from '@/components/EditorSetting'
import { DefaultFolderSetting } from '@/components/DefaultFolderSetting'
import { SpawnModeSetting } from '@/components/SpawnModeSetting'
import { GitHubSettings } from '@/components/GitHubSettings'
import { WindowStopSetting } from '@/components/WindowStopSetting'
import { Locked } from '@/components/Locked'
import { CloseButton, dialogOpen } from '@/components/Dialog'
import { escapeLeavesPage, useCloseSettings } from '@/lib/settingsClose'

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

function SettingsHeading({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-3 px-1 pt-1">
      <h1 className="min-w-0 flex-1 text-[20px] font-medium text-fg">Settings</h1>
      <CloseButton onClick={onClose} label="Close settings" title="Close settings (Esc)" />
    </div>
  )
}

export function StatusScreen() {
  const close = useCloseSettings()
  useSettingsEscape(close)
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 5000 })
  const s = st.data
  const head = <SettingsHeading onClose={close} />
  if (st.error && !s) return <div className="mx-auto grid w-full max-w-3xl gap-3">{head}<Empty title="Cannot reach the daemon">{st.error.message}</Empty></div>
  if (!s) return <div className="mx-auto grid w-full max-w-3xl gap-3">{head}<div className="px-1 text-fg-muted">loading…</div></div>
  const owner = !isPairedDevice()
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-3">
      {head}
      {/* Problems first: each one means something is not being captured or
        * cannot be started, and none of them is a preference. */}
      <Problems s={s} />
      {/* In the desktop app, what you change while working comes first: how
        * a new agent starts, how the window and terminal look, which editor
        * opens. The phone and Telegram are set up once. On a phone or in a
        * browser the phone comes first, as before. */}
      {isAppMode() && (
        <>
          {owner && <SpawnModeSetting />}
          <AppearanceSection />
          <TerminalSettings />
          {owner && <EditorSetting />}
          {owner && <DefaultFolderSetting />}
          {owner && isTauri() && <DesktopNotifications />}
          {owner && isTauri() && <GlobalHotkey />}
          <GitHubSettings />
          {owner && <Pairing />}
          {owner && <PhoneAlerts />}
          {owner && <PlanSection />}
          {owner && <WindowStopSection />}
        </>
      )}
      {!isAppMode() && (
        <>
          {owner && <Pairing />}
          {owner && isTauri() && <DesktopNotifications />}
          {owner && <PhoneAlerts />}
          {owner && <PlanSection />}
          {owner && <WindowStopSection />}
          <AppearanceSection />
          {owner && <SpawnModeSetting />}
          {owner && <EditorSetting />}
          {owner && <DefaultFolderSetting />}
          <GitHubSettings />
          {owner && isTauri() && <GlobalHotkey />}
        </>
      )}
      {owner && <PrivacySection />}
      {owner && <MemorySection />}
      <StoragePanel />
      <AboutSection s={s} />
    </div>
  )
}

function PlanSection() {
  const [plan, savePlan] = usePlan()
  if (!plan) return null
  const current =
    plan.plan_kind === 'metered'
      ? `${plan.plan_label || 'API'} · billed per token`
      : plan.plan_kind === 'flat'
        ? `${plan.plan_label || 'plan'} · ${fmtUSD(plan.plan_usd_per_month)}/mo`
        : 'not set'
  return (
    <Section title="Plan & licence">
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

function AppearanceSection() {
  const [theme, , setTheme] = useTheme()
  const [tone, setTone] = useLightTone()
  return (
    <Section title="Appearance">
      <Choice
        label="Theme"
        value={theme}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]}
        onChange={setTheme}
      />
      <Choice
        label="Light theme"
        value={tone}
        options={[
          { value: 'paper', label: 'Paper' },
          { value: 'white', label: 'White' },
        ]}
        onChange={(t) => {
          setTone(t)
          // Choosing a light tone while dark is showing would change nothing
          // visible, which reads as a broken control.
          if (theme !== 'light') setTheme('light')
        }}
      />
      <p className="text-[12px] text-fg-muted">Saved in this browser only.</p>
    </Section>
  )
}

function PrivacySection() {
  const [plan, savePlan] = usePlan()
  if (!plan) return null
  return (
    <Section title="Privacy">
      <Toggle
        checked={plan.update_checks}
        onChange={(on) => savePlan({ update_checks: on })}
        label="Tell me when a new version is out"
        hint="At most every 6 hours, asks GitHub for the latest version number. Nothing about you is sent, and nothing goes to us."
      />
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Apart from the Telegram messages you set up yourself and GitHub once you connect it, that is the only thing
        Caprock ever sends over the internet. Everything else stays on this computer.
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
        <Section title="Nothing new is being recorded">
          <p className="text-fg-muted">
            <span className="mono text-fg break-all">{s.ingest_error}</span>. Check that
            <span className="mono text-fg"> ~/.claude</span> is readable, then restart with
            <span className="mono text-fg"> caprock down &amp;&amp; caprock up</span>.
          </p>
        </Section>
      )}
      {!s.claude_available && (
        <Section title="Claude Code was not found">
          <p className="text-fg-muted">
            Caprock cannot start sessions for you, but it still records every session you start yourself. Install
            Claude Code, or make sure <span className="mono">claude</span> is on the PATH Caprock was started with.
          </p>
        </Section>
      )}
      {missingHooks.length > 0 && (
        <Section title="Live activity is a few seconds late">
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
