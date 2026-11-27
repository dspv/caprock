/**
 * Settings → Agents: coding agents the user adds by command (ADR-046).
 *
 * The owner, 2026-10-10 (translated): "I'd also let people add new agents
 * themselves." Free, with no licence, since 2026-11-27 (owner decision:
 * parity with Orca; it was Premium until then). An agent is a name, a
 * program, its arguments —
 * one per line, with `{prompt}` where the first message goes and `{model}`
 * where the model goes — and, optionally, the models to offer. It then appears
 * in New agent and Quick chat and opens in a Caprock tab like the built-ins.
 * Caprock does not read its turns or cost unless it is an agent Caprock
 * already reads, and the section says so.
 */
import { useEffect, useState } from 'react'
import { api, errText, type CustomAgent } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section } from './SettingsParts'

const EMPTY: CustomAgent = { name: '', command: '', args: [], models: [] }

/** Arguments are one per line, so an argument may hold spaces and nothing is
 *  split by shell rules; models are comma-separated. */
export function parseArgs(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}
export function parseModels(text: string): string[] {
  return text.split(',').map((m) => m.trim()).filter(Boolean)
}

export function CustomAgentsEditor() {
  const loaded = useApi(() => api.customAgents(), [], { live: false })
  const [list, setList] = useState<CustomAgent[]>([])
  const [draft, setDraft] = useState(EMPTY)
  const [argsText, setArgsText] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [state, setState] = useState<'' | 'saved' | string>('')
  const [busy, setBusy] = useState(false)
  // The stored list, until the first save here: an answer that arrives after
  // a save is older than what the save returned.
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (loaded.data && !saved) setList(loaded.data.agents) }, [loaded.data, saved])

  const save = async (next: CustomAgent[]) => {
    setBusy(true)
    setState('')
    try {
      const res = await api.saveCustomAgents(next)
      setSaved(true)
      setList(res.agents)
      setState('saved')
      return true
    } catch (e) {
      setState(errText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const agent: CustomAgent = { name: draft.name.trim(), command: draft.command.trim(), args: parseArgs(argsText), models: parseModels(modelsText) }
    if (!agent.name || !agent.command) { setState('Give it a name and a command.'); return }
    if (await save([...list, agent])) {
      setDraft(EMPTY)
      setArgsText('')
      setModelsText('')
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Any terminal coding agent, by its command. It appears in <span className="text-fg">New agent</span> and <span className="text-fg">Quick chat</span> and opens in a tab like the built-in ones. Caprock keeps its sessions in your list but does not read its turns or cost.
      </p>
      {list.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Custom agents">
          {list.map((a) => (
            <li key={a.id ?? a.name} className="flex min-w-0 items-center gap-3 rounded-[8px] border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">{a.name}</p>
                <p className="mono truncate text-[11.5px] text-fg-muted" title={[a.command, ...(a.args ?? [])].join(' ')}>{[a.command, ...(a.args ?? [])].join(' ')}</p>
                {(a.models?.length ?? 0) > 0 && <p className="truncate text-[11.5px] text-fg-faint">models: {a.models!.join(', ')}</p>}
              </div>
              <button type="button" disabled={busy} onClick={() => void save(list.filter((x) => x !== a))} className="shrink-0 text-[12px] text-fg-muted hover:text-danger disabled:opacity-50">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 rounded-[8px] border border-border p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1">
            <span className="text-[12px] text-fg-muted">Name</span>
            <input className="input" placeholder="Aider" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="text-[12px] text-fg-muted">Command</span>
            <input className="input mono" placeholder="aider" spellCheck={false} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          </label>
        </div>
        <label className="grid min-w-0 gap-1">
          <span className="text-[12px] text-fg-muted">Arguments <span className="text-fg-faint">· one per line; <span className="mono">{'{prompt}'}</span> is the first message, <span className="mono">{'{model}'}</span> the model</span></span>
          <textarea className="input mono min-h-[76px] resize-y text-[12.5px]" spellCheck={false} placeholder={'--model\n{model}\n--message\n{prompt}'} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        </label>
        <label className="grid min-w-0 gap-1">
          <span className="text-[12px] text-fg-muted">Models <span className="text-fg-faint">· optional, comma-separated</span></span>
          <input className="input mono" spellCheck={false} placeholder="gpt-5.5, sonnet" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
        </label>
        <p className="text-[11.5px] leading-snug text-fg-faint">
          An argument whose placeholder has no value is left out, with the flag before it: no model picked, no <span className="mono">--model</span>.
        </p>
        <div className="flex items-center gap-3">
          <button type="button" disabled={busy} onClick={() => void add()} className="h-[28px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50">
            Add agent
          </button>
          {state === 'saved' && <span className="text-[12px] text-fg-muted">Saved.</span>}
          {state && state !== 'saved' && <span role="alert" className="min-w-0 truncate text-[12px] text-danger" title={state}>{state}</span>}
        </div>
      </div>
    </div>
  )
}

/** The section, as Settings shows it (Status.tsx). */
export function CustomAgentsSetting() {
  return (
    <Section title="Custom agents">
      <CustomAgentsEditor />
    </Section>
  )
}
