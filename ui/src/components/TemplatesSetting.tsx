/**
 * Settings → Project templates (ADR-065): the templates New project from a
 * template offers — a GitHub template repository, a folder on this
 * computer, or both, with where the brief goes and the agent's first
 * message. Added from that dialog (Save as a template); here they are
 * changed or taken off the list. Deleting one touches nothing on disk or on
 * GitHub. The daemon keeps them (`project-templates.json`); only this
 * machine reads or changes them.
 */
import { useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { keys } from '@/lib/appkeys'
import { tildePath } from '@/lib/projectSearch'
import { normalizeGitHub, type Template, type TemplateInput } from '@/lib/templates'
import { agentLabel, useAgentCatalog } from './AgentPicker'
import { Section } from './SettingsParts'

export const TEMPLATES_SECTION_ID = 'project-templates'

interface Draft { name: string; github: string; folder: string; brief_path: string; prompt: string; agent: string }

function draftOf(t: Template): Draft {
  return { name: t.name, github: t.github ?? '', folder: t.folder ?? '', brief_path: t.brief_path, prompt: t.prompt, agent: t.agent ?? '' }
}

/** The PATCH for what changed; `""` clears github, folder or agent. Null when the GitHub field is not a repository. */
export function templatePatch(t: Template, d: Draft): TemplateInput | null {
  const out: TemplateInput = {}
  const gh = d.github.trim() ? normalizeGitHub(d.github) : ''
  if (gh === null) return null
  if (d.name.trim() !== t.name) out.name = d.name.trim()
  if (gh !== (t.github ?? '')) out.github = gh
  if (d.folder.trim() !== (t.folder ?? '')) out.folder = d.folder.trim()
  if (d.brief_path.trim() !== t.brief_path) out.brief_path = d.brief_path.trim()
  if (d.prompt !== t.prompt) out.prompt = d.prompt
  if (d.agent !== (t.agent ?? '')) out.agent = d.agent
  return out
}

export function TemplatesEditor() {
  const list = useApi(() => api.templates(), [], { live: false })
  const catalog = useAgentCatalog()
  const home = catalog.home
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [state, setState] = useState('')
  const [busy, setBusy] = useState(false)
  const items = list.data?.templates ?? []

  const edit = (t: Template) => { setEditing(t.id); setDraft(draftOf(t)); setState('') }
  const reset = () => { setEditing(null); setDraft(null) }

  const submit = async (t: Template) => {
    if (!draft) return
    const patch = templatePatch(t, draft)
    if (!patch) { setState('GitHub: owner/name, or a github.com link.'); return }
    if (Object.keys(patch).length === 0) { reset(); return }
    setBusy(true)
    setState('')
    try {
      await api.updateTemplate(t.id, patch)
      list.refresh()
      reset()
      setState('saved')
    } catch (e) {
      setState(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t: Template) => {
    setBusy(true)
    setState('')
    try {
      await api.removeTemplate(t.id)
      if (editing === t.id) reset()
      list.refresh()
    } catch (e) {
      setState(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        What <span className="text-fg">New project from a template…</span> ({keys('⌘K')}, or New project → From a template) offers. Each is a GitHub template repository, made with your own <span className="mono">gh</span>, or a folder on this computer, copied. Add one from that dialog; deleting one here touches nothing on disk or on GitHub.
      </p>
      {list.error && <p role="alert" className="text-[12px] text-danger">{errText(list.error)}</p>}
      {list.data && items.length === 0 && <p data-keep className="text-[12px] text-fg-muted">No templates yet. Add one from New project → From a template….</p>}
      {items.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Project templates">
          {items.map((t) => (
            <li key={t.id} className={`grid min-w-0 gap-2 rounded-[8px] border px-3 py-2 ${editing === t.id ? 'border-accent' : 'border-border'}`}>
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-fg">{t.name} <span className="text-[11.5px] text-fg-faint">· {t.agent ? agentLabel(t.agent, catalog.entries) : 'any agent'}</span></p>
                  <p data-keep className="mono truncate text-[11.5px] text-fg-muted">
                    {[t.github ? `github.com/${t.github}` : '', t.folder ? tildePath(t.folder, home) : ''].filter(Boolean).join(' · ')} · brief → {t.brief_path}
                  </p>
                </div>
                {editing !== t.id && <button type="button" disabled={busy} onClick={() => edit(t)} className="shrink-0 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50">Edit</button>}
                <button type="button" disabled={busy} onClick={() => void remove(t)} aria-label={`Delete ${t.name}`} className="shrink-0 text-[12px] text-fg-muted hover:text-danger disabled:opacity-50">Delete</button>
              </div>
              {editing === t.id && draft && (
                <div className="grid gap-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                    <label className="grid min-w-0 gap-1">
                      <span className="text-[12px] text-fg-muted">Agent</span>
                      <select aria-label="Agent" className="input" value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })}>
                        <option value="">The default</option>
                        {catalog.entries.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </label>
                    <Field label="GitHub" mono placeholder="owner/name" value={draft.github} onChange={(v) => setDraft({ ...draft, github: v })} />
                    <Field label="Folder" mono placeholder="~/templates/site" value={draft.folder} onChange={(v) => setDraft({ ...draft, folder: v })} />
                    <Field label="Brief goes to" mono value={draft.brief_path} onChange={(v) => setDraft({ ...draft, brief_path: v })} />
                  </div>
                  <label className="grid min-w-0 gap-1">
                    <span className="text-[12px] text-fg-muted">First message to the agent <span className="text-fg-faint">· {'{brief}'} is the brief’s path</span></span>
                    <textarea aria-label="First message to the agent" className="input min-h-[64px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
                  </label>
                  <div className="flex items-center gap-3">
                    <button type="button" disabled={busy} onClick={() => void submit(t)} className="h-[28px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50">Save</button>
                    <button type="button" disabled={busy} onClick={reset} className="text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {state === 'saved' && <span className="text-[12px] text-fg-muted">Saved.</span>}
      {state && state !== 'saved' && <p role="alert" className="min-w-0 text-[12px] text-danger">{state}</p>}
    </div>
  )
}

function Field({ label, value, onChange, mono, placeholder }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[12px] text-fg-muted">{label}</span>
      <input aria-label={label} className={`input ${mono ? 'mono' : ''}`} spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function TemplatesSetting() {
  return (
    <Section id={TEMPLATES_SECTION_ID} title="Project templates">
      <TemplatesEditor />
    </Section>
  )
}
