/**
 * Use Caprock from your agents (MCP, ADR-078): the commands that add
 * `caprock mcp` to Claude Code and Codex, and what it lets them read.
 *
 * Nothing here switches anything on: the user's agent starts the server
 * when it is in that agent's own MCP config, and nothing in Caprock changes.
 * So the section is the command, a copy button, and the line that says what
 * a tool's answer reaches — the agent's conversation, and so the model it
 * runs on — which is the condition of adding it, kept on screen (rule 4).
 */
import { useState } from 'react'
import { Copyable } from '@/components/ui'
import { Details, Section, Toggle } from '@/components/SettingsParts'
import { isTauri } from '@/lib/appmode'

/** What `caprock mcp` offers, in the order tools/list gives them (internal/mcp/tools.go). */
export const MCP_TOOLS: [name: string, what: string][] = [
  ['search_memories', 'search Second Brain'],
  ['get_memory', 'one memory and what it links to'],
  ['memory_topics', 'the topics and projects Second Brain knows'],
  ['next_session_handoff', 'what a new session in this repository is handed'],
  ['recent_sessions', 'recent sessions here, or everywhere'],
  ['session_summary', 'what a session did: files, pull requests, cost'],
  ['session_prose', 'what a session wrote'],
  ['search_prose', 'search what agents wrote, across sessions'],
  ['cost', 'spend and tokens per day and model'],
  ['ci_status', 'GitHub Actions, once GitHub is connected here'],
  ['loop_alerts', 'running sessions repeating a tool call'],
]

/** A path as one shell word: double-quoted when it holds a space or a quote.
 *  Backslashes are left alone: inside double quotes a POSIX shell keeps one
 *  that precedes an ordinary character, and PowerShell and cmd keep them all,
 *  so a Windows path reads the same in each. */
export function shellWord(p: string): string {
  return /[\s"'$`]/.test(p) ? `"${p.replace(/(["$`])/g, '\\$1')}"` : p
}

/** A TOML string: literal (no escapes, so a Windows path stays as written) unless it holds a single quote. */
export function tomlString(p: string): string {
  return p.includes("'") ? `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `'${p}'`
}

export function mcpCommands(exe: string) {
  return {
    claude: `claude mcp add caprock -- ${shellWord(exe)} mcp`,
    codexCli: `codex mcp add caprock -- ${shellWord(exe)} mcp`,
    codexToml: `[mcp_servers.caprock]\ncommand = ${exe === 'caprock' ? '"caprock"' : tomlString(exe)}\nargs = ["mcp"]`,
  }
}

export function McpSetting({ executable }: { executable?: string }) {
  // The desktop app puts no `caprock` on the PATH, so there the full path is
  // the one that works; elsewhere the short name survives a reinstall.
  const [full, setFull] = useState(() => isTauri() && !!executable)
  const exe = full && executable ? executable : 'caprock'
  const cmd = mcpCommands(exe)
  return (
    <Section title="Use Caprock from your agents (MCP)">
      <p className="text-[12.5px] leading-relaxed text-fg-muted" data-keep>
        Your coding agents can ask Caprock what it knows — Second Brain, the recent sessions in their repository and what
        those sessions wrote, cost and tokens, CI and loop alerts. Read-only: no tool can type into a session, start or stop
        one, or change a setting. What a tool returns goes into your agent&rsquo;s conversation, and so to the model it runs
        on; text shaped like a key or token is replaced with [redacted]. It opens no port: it reads this Caprock while it runs.
      </p>
      <div className="grid gap-1.5">
        <span className="text-[14px] text-fg">Claude Code</span>
        <Copyable command={cmd.claude} className="w-fit max-w-full break-all" />
        <span data-help className="text-[12px] text-fg-muted">
          Run it in a project to add it there, or with <span className="mono">--scope user</span> after <span className="mono">add</span> for every project.
        </span>
      </div>
      <div className="grid gap-1.5">
        <span className="text-[14px] text-fg">Codex</span>
        <Copyable command={cmd.codexCli} className="w-fit max-w-full break-all" />
        <span data-help className="text-[12px] text-fg-muted">
          Or add these lines to <span className="mono">~/.codex/config.toml</span>:
        </span>
        <CopyBlock text={cmd.codexToml} label="Copy the Codex config" />
      </div>
      <p data-help className="text-[12px] leading-relaxed text-fg-muted">
        Any other MCP client: a stdio server, command <span className="mono">{shellWord(exe)}</span>, argument <span className="mono">mcp</span>.
      </p>
      {executable && (
        <Toggle
          checked={full}
          onChange={setFull}
          label="Use the full path to caprock"
          hint={<>For when <span className="mono">caprock</span> is not on your PATH, as with the desktop app alone: <span className="mono break-all">{executable}</span></>}
        />
      )}
      <Details summary="What your agents can read">
        <ul className="mt-1.5 grid gap-0.5 text-[12.5px]">
          {MCP_TOOLS.map(([name, what]) => (
            <li key={name}>
              <span className="mono text-fg">{name}</span> <span className="text-fg-muted">— {what}</span>
            </li>
          ))}
        </ul>
      </Details>
    </Section>
  )
}

/** A few lines of config with a copy button. */
function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative w-fit max-w-full">
      <pre className="mono overflow-x-auto rounded-sm border border-border bg-panel-2 py-1.5 pl-2 pr-16 text-[12px] text-fg">{text}</pre>
      <button
        type="button"
        aria-label={label}
        className="absolute right-1.5 top-1.5 rounded-sm border border-border px-1.5 text-[11px] text-fg-muted hover:text-fg"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}
