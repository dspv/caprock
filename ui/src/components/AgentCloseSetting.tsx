/**
 * Settings → Closing a tab: what closing the tab of an agent Caprock started
 * does (lib/agentClose.ts). Ask is the default; the sheet's *Don't ask
 * again* sets one of the others, and this is the way back. An agent another
 * terminal started only ever loses its tab.
 */
import { useAgentClose, type AgentClose } from '@/lib/agentClose'
import { Choice, Section } from './SettingsParts'

export function AgentCloseSetting() {
  const [value, setValue] = useAgentClose()
  return (
    <Section title="Closing a tab">
      <Choice<AgentClose>
        label="Agent's tab"
        value={value}
        options={[
          { value: 'ask', label: 'Ask' },
          { value: 'keep', label: 'Keep it running' },
          { value: 'end', label: 'End the agent' },
        ]}
        onChange={setValue}
      />
      <p className="text-[12px] text-fg-muted">
        For an agent Caprock started. Kept running, it stays in the sidebar under Running, no tab; ended, its conversation is kept and can be continued. An agent started in your own terminal is never ended from here: closing its tab only closes the tab. Saved in this browser only.
      </p>
    </Section>
  )
}
