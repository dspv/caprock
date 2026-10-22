/**
 * The model a Claude Code session's subagents run on: sent as `subagent_model`
 * on POST /v1/agents, which the daemon turns into CLAUDE_CODE_SUBAGENT_MODEL.
 * "" is Same as the session: nothing is sent and subagents follow it.
 */
export type SubagentModel = '' | 'haiku' | 'sonnet' | 'opus'

export const SUBAGENT_MODELS: { value: SubagentModel; label: string }[] = [
  { value: '', label: 'Same as the session' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
]

export function isSubagentModel(v: unknown): v is SubagentModel {
  return SUBAGENT_MODELS.some((m) => m.value === v)
}

/** "Haiku", or '' for a session whose subagents follow it. */
export function subagentModelLabel(v: string | undefined): string {
  return SUBAGENT_MODELS.find((m) => m.value === v && m.value !== '')?.label ?? ''
}

/**
 * Remembered per project in this browser, like the sign-in a project runs on.
 * A project with no choice of its own starts on the default for new agents
 * (the Week screen's *Start new agents with Haiku subagents*); a project whose
 * choice differs from that default keeps it, and *Same as the session* is
 * stored as `same` so a Haiku default cannot override it.
 */
const key = (project: string) => `caprock.subagentmodel.${project || '-'}`
const DEFAULT_KEY = 'caprock.subagentmodel-default'
const SAME = 'same'

/** The model new agents' subagents start on where a project chose nothing. */
export function defaultSubagentModel(): SubagentModel {
  try {
    const v = localStorage.getItem(DEFAULT_KEY)
    return isSubagentModel(v) ? v : ''
  } catch {
    return ''
  }
}

export function setDefaultSubagentModel(v: SubagentModel): void {
  try {
    if (!v) localStorage.removeItem(DEFAULT_KEY)
    else localStorage.setItem(DEFAULT_KEY, v)
  } catch {
    // Not remembering is fine.
  }
}

export function rememberedSubagentModel(project: string): SubagentModel {
  try {
    const v = localStorage.getItem(key(project))
    if (v === SAME) return ''
    return isSubagentModel(v) ? v : defaultSubagentModel()
  } catch {
    return ''
  }
}

export function rememberSubagentModel(project: string, v: SubagentModel): void {
  try {
    if (v === defaultSubagentModel()) localStorage.removeItem(key(project))
    else localStorage.setItem(key(project), v || SAME)
  } catch {
    // Not remembering is fine.
  }
}
