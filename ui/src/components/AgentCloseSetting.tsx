/**
 * Settings → Closing a tab: what closing the tab of an agent Caprock started
 * does (lib/agentClose.ts). *Ask while it works* is the default: an idle
 * agent ends with its tab, one working or waiting is asked about once.
 * Under it, *Always ask before closing an agent's tab* (off) asks about an
 * idle one too. *Keep it running* and *End the agent* never ask, so the
 * switch shows only beside *Ask while it works*. An agent another terminal
 * started only ever loses its tab.
 */
import { useAgentClose, useAlwaysAsk, type AgentClose } from '@/lib/agentClose'
import { Choice, Section, Toggle } from './SettingsParts'

export function AgentCloseSetting() {
  const [value, setValue] = useAgentClose()
  const [always, setAlways] = useAlwaysAsk()
  return (
    <Section title="Closing a tab">
      <Choice<AgentClose>
        label="Agent's tab"
        value={value}
        options={[
          { value: 'ask', label: 'Ask while it works' },
          { value: 'keep', label: 'Keep it running' },
          { value: 'end', label: 'End the agent' },
        ]}
        onChange={setValue}
      />
      {value === 'ask' && (
        <Toggle
          checked={always}
          onChange={setAlways}
          label="Always ask before closing an agent's tab"
          hint="An idle agent is asked about too, with the same two buttons, instead of ending with its tab."
        />
      )}
      <p className="text-[12px] text-fg-muted">
        For an agent Caprock started. By default an idle agent ends with its tab and one still working is asked about once. Kept running, it stays in the sidebar under Running, no tab; ended, it is asked to stop so its conversation is saved, and it can be continued from History or the sidebar. An agent started in your own terminal is never ended from here: closing its tab only closes the tab. Saved in this browser only.
      </p>
    </Section>
  )
}
