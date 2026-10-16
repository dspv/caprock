/**
 * New project from a template (ADR-065; owner, 2026-10-15, translated: "I
 * have a template repo, Corpus. I create a repo from it, feed it to an agent
 * with a brief, and it builds the project — docs first. Build it into
 * Caprock so I use it and it doesn't get in other people's way."). Three
 * steps, in the New project wizard's look:
 *
 *  1. **Template.** The saved ones as cards, or another: a GitHub template
 *     repository (looked up through the person's own gh, on the click) or a
 *     folder on this computer. Where the brief goes and the first message
 *     come from its TEMPLATE.md, or a guess, and can be changed.
 *  2. **Project.** Its name and where it lives, private or public on
 *     GitHub, and one line saying how it will be made with the gh this
 *     machine has. A GitHub template with gh signed out is never quietly
 *     made locally: the person asks for that.
 *  3. **Brief.** Pasted, or a .md or .txt file dropped on the field; and,
 *     always in sight, what Create will do and what leaves the machine
 *     (rule 4).
 *
 * After Create the operation's frames drive the footer. Esc hides the sheet;
 * the app keeps the job (screens/AppShell.tsx) and still starts the agent
 * when the project is made, saves the template then, and says so in a toast.
 * Nothing here is built in: with no template saved, nothing changes for
 * anyone who never opens it.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { isTauri } from '@/lib/appmode'
import { keys } from '@/lib/appkeys'
import { shell } from '@/lib/shell'
import { newOpId, type Project } from '@/lib/projects'
import { tildePath } from '@/lib/projectSearch'
import { expandTilde, placeChips, trimSlash } from '@/lib/projectWizard'
import { DROP_PATHS_EVENT } from '@/lib/xtermInput'
import {
  baseOf, failureView, fillPrompt, howMade, howMadeLine, isBriefFile, MAX_BRIEF_BYTES, nameProblem, normalizeGitHub, planLines, progressLine, suggestName,
  type GHStatus, type Inspection, type PlanLine, type Template, type TemplateJob, type TemplateOp, type Visibility,
} from '@/lib/templates'
import { AgentPicker, agentLabel, startable, useAgentCatalog, useAgentChoice, type SpawnAgent } from './AgentPicker'
import { StepsHeader } from './ProjectWizard'
import { Sheet, SheetButton } from './Sheet'
import { extTitle } from '@/lib/externalLinks'

type Step = 'template' | 'project' | 'brief'
const STEPS: { key: Step; label: string }[] = [
  { key: 'template', label: 'Template' },
  { key: 'project', label: 'Project' },
  { key: 'brief', label: 'Brief' },
]

const BIG_FIELD = { fontSize: 16, padding: '0 14px', borderRadius: 8 } as const
const PROSE_FIELD = { fontFamily: 'var(--font-sans)', fontSize: 14, padding: '10px 12px', borderRadius: 8 } as const

/** The template the person chose: a saved one, or one just looked up. */
interface Chosen {
  savedId?: string
  name: string
  github?: string
  folder?: string
  brief_path: string
  prompt: string
  agent?: string
  /** A clone of the GitHub template in the default folder (inspect). */
  localFolder?: string
  suggestedName?: string
}

export const EMPTY_TEMPLATES = 'No templates yet. A template is a GitHub template repository or a folder on this computer. Caprock copies it into a new project, puts your brief in it and starts an agent there.'

export function TemplateProjectSheet({
  projects,
  job,
  op,
  onClose,
  onSubmitted,
  onOp,
  onStartAgent,
  onReset,
}: {
  projects: readonly Project[]
  /** The operation in flight, kept by the app while the sheet is hidden. */
  job: TemplateJob | null
  /** Its newest frame. */
  op?: TemplateOp
  /** Esc, ×: hides the sheet; a job in flight carries on. */
  onClose: () => void
  /** Create was accepted: the app keeps the job from here. */
  onSubmitted: (job: TemplateJob, op: TemplateOp) => void
  /** A newer frame of the job's operation (Retry's answer). */
  onOp: (op: TemplateOp) => void
  /** The project is made but its agent did not start: New agent, prefilled. */
  onStartAgent: (job: TemplateJob) => void
  /** Forget a failed job and start the form again. */
  onReset: () => void
}) {
  const list = useApi(() => api.templates(), [], { live: false })
  const settings = useApi(() => api.settings(), [], { live: false })
  const local = useApi(() => api.localRepos(), [], { live: false })
  const home = local.data?.home
  const gh = list.data?.gh
  const templates = list.data?.templates ?? []
  const defaultFolder = settings.data?.default_folder

  if (job) {
    return <JobView job={job} op={op} home={home} onClose={onClose} onOp={onOp} onStartAgent={onStartAgent} onReset={onReset} />
  }
  return (
    <TemplateForm
      projects={projects}
      templates={templates}
      loaded={!!list.data || !!list.error}
      listError={list.error ? errText(list.error) : ''}
      gh={gh}
      onCheckAgain={() => list.refresh()}
      home={home}
      defaultFolder={defaultFolder}
      onClose={onClose}
      onSubmitted={onSubmitted}
    />
  )
}

function TemplateForm({
  projects, templates, loaded, listError, gh, onCheckAgain, home, defaultFolder, onClose, onSubmitted,
}: {
  projects: readonly Project[]
  templates: readonly Template[]
  loaded: boolean
  listError: string
  gh?: GHStatus
  onCheckAgain: () => void
  home?: string
  defaultFolder?: string
  onClose: () => void
  onSubmitted: (job: TemplateJob, op: TemplateOp) => void
}) {
  const catalog = useAgentCatalog()
  const agents = useMemo(() => startable(catalog.entries), [catalog.entries])
  const [agent, setAgent, dflt] = useAgentChoice(agents)

  const [step, setStep] = useState<Step>('template')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Step 1: a saved template, or another one being added.
  const [clickedId, setPickedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Until a card is clicked the first one is chosen. Derived, not set from an
  // effect: an effect that picked the first card could run after a click that
  // landed before it, and overwrite the card the user chose.
  const pickedId = clickedId ?? templates[0]?.id ?? null
  const showForm = adding || (loaded && templates.length === 0)
  // The list arrives after the sheet took focus (its footer's Cancel, then):
  // once it is here, focus the chosen card, or the field of an empty list,
  // so Enter moves on rather than cancelling.
  const stepOne = useRef<HTMLDivElement>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!loaded || focused.current || step !== 'template') return
    const el = stepOne.current?.querySelector<HTMLElement>('[aria-pressed="true"], input')
    if (!el) return
    focused.current = true
    el.focus()
  })
  const [draft, setDraft] = useState<Chosen | null>(null)
  const [save, setSave] = useState(true)
  const saved = templates.find((t) => t.id === pickedId)
  const chosen: Chosen | null = showForm
    ? draft
    : saved ? { savedId: saved.id, name: saved.name, github: saved.github, folder: saved.folder, brief_path: saved.brief_path, prompt: saved.prompt, agent: saved.agent } : null
  // A saved template's own agent, when this machine has it.
  useEffect(() => {
    if (saved?.agent && agents.includes(saved.agent as SpawnAgent) && !showForm) setAgent(saved.agent as SpawnAgent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id, agents.join(','), showForm])

  // A GitHub template without gh: the daemon looks for a clone of it in the
  // default folder (inspect runs no gh then, so nothing leaves the machine).
  const [localFor, setLocalFor] = useState<Record<string, string>>({})
  const localFolder = chosen?.localFolder ?? (chosen?.github ? localFor[chosen.github] : undefined)

  // Step 2.
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const chips = useMemo(() => placeChips(projects.map((p) => p.root), { home, defaultFolder }), [projects, home, defaultFolder])
  const [parent, setParent] = useState('')
  const [parentTouched, setParentTouched] = useState(false)
  useEffect(() => {
    if (parentTouched) return
    const start = defaultFolder ? tildePath(trimSlash(defaultFolder), home) : chips[0]
    if (start) setParent(start)
  }, [defaultFolder, chips, home, parentTouched])
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [local, setLocal] = useState(false)
  const how = chosen ? howMade({ github: chosen.github, folder: chosen.folder, localFolder }, gh, local) : null
  const cleanParent = trimSlash(parent.trim() || '~')
  const dest = `${cleanParent}/${name.trim() || 'my-project'}`
  const [exists, setExists] = useState('')
  useEffect(() => {
    setExists('')
    const n = name.trim()
    if (step !== 'project' || !n || nameProblem(n)) return
    let alive = true
    const t = setTimeout(() => {
      api.browseStat(expandTilde(`${cleanParent}/${n}`, home))
        .then((st) => { if (alive && st.exists && !(st.is_dir && st.empty)) setExists(`${tildePath(st.path, home)} already exists; pick another name.`) })
        .catch(() => { /* outside the browse root, or an older daemon: the daemon says so on Create */ })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [name, cleanParent, step, home])

  // Step 3.
  const [brief, setBrief] = useState('')
  const [dropNote, setDropNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const label = agentLabel(agent, catalog.entries)

  const toProject = async () => {
    if (!chosen) { setError('Choose a template.'); return }
    if (!chosen.brief_path.trim()) { setError('Say where the brief goes.'); return }
    if (!chosen.prompt.trim()) { setError('Write the first message to the agent.'); return }
    setError('')
    setBusy(true)
    try {
      if (chosen.github && !chosen.folder && !(gh?.installed && gh.logged_in) && localFor[chosen.github] === undefined && chosen.localFolder === undefined) {
        try {
          const insp = await api.inspectTemplate({ github: chosen.github })
          setLocalFor((m) => ({ ...m, [chosen.github!]: insp.local_folder ?? '' }))
        } catch { /* no clone known */ }
      }
      if (!nameTouched) {
        let suggested = chosen.suggestedName
        if (!suggested) {
          const taken = new Set<string>()
          try {
            const listing = await api.browse(expandTilde(cleanParent, home))
            for (const e of listing.entries) taken.add(e.name)
          } catch { /* the daemon refuses a taken name on Create */ }
          suggested = suggestName(baseOf(chosen), taken)
        }
        setName(suggested)
      }
      setStep('project')
    } finally {
      setBusy(false)
    }
  }

  const nameErr = name.trim() ? nameProblem(name) : ''
  const projectReady = !!how?.via && !nameErr && !!name.trim() && !exists
  const toBrief = () => {
    if (!name.trim()) { setError('Name it.'); return }
    if (nameErr || exists) { setError(nameErr || exists); return }
    if (!how?.via) { setError('It cannot be made yet: see the line under the name.'); return }
    setError('')
    setStep('brief')
  }

  const plan = chosen && how?.via
    ? planLines({
        via: how.via,
        login: how.kind === 'github' ? how.login : undefined,
        name: name.trim(),
        github: chosen.github,
        folder: how.kind === 'github' ? undefined : (how as { folder?: string }).folder,
        visibility,
        dest,
        briefPath: chosen.brief_path,
        agent: label,
        prompt: chosen.prompt,
      })
    : null

  const create = async () => {
    if (!chosen || !how?.via || !plan) return
    if (!brief.trim()) { setError('Paste the brief, or drop a .md or .txt file.'); return }
    if (new TextEncoder().encode(brief).length > MAX_BRIEF_BYTES) { setError('The brief is over 1 MiB.'); return }
    setError('')
    setBusy(true)
    const opId = newOpId()
    const via = how.via
    const folder = via === 'local' ? (how as { folder?: string }).folder : undefined
    try {
      const { op } = await api.fromTemplate({
        op_id: opId,
        source: via === 'github' ? { github: chosen.github } : { folder },
        via,
        name: name.trim(),
        parent: cleanParent,
        ...(via === 'github' ? { visibility } : {}),
        brief,
        brief_path: chosen.brief_path,
        template_name: chosen.name,
      })
      const job: TemplateJob = {
        op_id: op.op_id || opId,
        name: name.trim(),
        agent,
        agentLabel: label,
        prompt: fillPrompt(chosen.prompt, chosen.brief_path),
        via,
        plan,
        ...(showForm && save && chosen.name.trim()
          ? { save: { name: chosen.name.trim(), github: chosen.github, folder: chosen.folder, brief_path: chosen.brief_path, prompt: chosen.prompt, agent } }
          : {}),
      }
      onSubmitted(job, { ...op, kind: 'template' })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // The brief from a file: an HTML5 drop in a browser, a path from the app's
  // own drop handler in the desktop app (read by the shell, only from that drop).
  const takeText = (text: string, from: string) => {
    if (new TextEncoder().encode(text).length > MAX_BRIEF_BYTES) { setDropNote(`${from} is over 1 MiB.`); return }
    setBrief(text)
    setDropNote(`From ${from}.`)
    setError('')
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    setDragging(false)
    if (files.length === 0) return
    e.preventDefault()
    const f = files[0]!
    if (!isBriefFile(f.name)) { setDropNote('Only a .md or .txt file can be the brief.'); return }
    if (f.size > MAX_BRIEF_BYTES) { setDropNote(`${f.name} is over 1 MiB.`); return }
    const r = new FileReader()
    r.onload = () => takeText(String(r.result ?? ''), f.name)
    r.onerror = () => setDropNote(`${f.name} could not be read.`)
    r.readAsText(f)
  }
  useEffect(() => {
    if (step !== 'brief') return
    const onPaths = (e: Event) => {
      const d = (e as CustomEvent<{ paths?: unknown } | undefined>).detail
      const paths = Array.isArray(d?.paths) ? d.paths.filter((p): p is string => typeof p === 'string') : []
      const p = paths[0]
      if (!p) return
      const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
      if (!isBriefFile(base)) { setDropNote('Only a .md or .txt file can be the brief.'); return }
      shell.readDroppedText(p).then((t) => takeText(t, base), (err) => setDropNote(`${base}: ${errText(err)}`))
    }
    window.addEventListener(DROP_PATHS_EVENT, onPaths)
    return () => window.removeEventListener(DROP_PATHS_EVENT, onPaths)
  }, [step])

  // Enter advances (not in a text box, a button, or a field with its own
  // Enter); ⌘↩ creates from anywhere on the last step.
  const advance = useRef<(mod: boolean) => void>(() => {})
  advance.current = (mod) => {
    if (busy) return
    if (step === 'template') void toProject()
    else if (step === 'project') toBrief()
    else if (mod) void create()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const mod = e.metaKey || e.ctrlKey
      if (!mod && (t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t?.dataset.ownEnter !== undefined)) return
      e.preventDefault()
      e.stopPropagation()
      advance.current(mod)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const createKey = keys('⌘↩')
  const primary = step === 'template'
    ? { label: busy ? 'Looking…' : 'Continue', run: () => void toProject(), disabled: busy || !chosen || !chosen.brief_path.trim() || !chosen.prompt.trim(), hint: keys('↩'), shortcut: 'Enter' }
    : step === 'project'
      ? { label: 'Continue', run: toBrief, disabled: !projectReady, hint: keys('↩'), shortcut: 'Enter' }
      : { label: busy ? 'Creating…' : 'Create', run: () => void create(), disabled: busy || !brief.trim(), hint: createKey, shortcut: 'Meta+Enter' }

  return (
    <Sheet
      label="New project from a template"
      title={<StepsHeader title="From a template" steps={STEPS} step={step} />}
      onClose={onClose}
      width={680}
      footer={(
        <>
          {error ? (
            <p role="alert" className="mr-auto min-w-0 truncate text-[13px] text-danger" title={error}>{error}</p>
          ) : step !== 'template' ? (
            <button type="button" onClick={() => { setStep(step === 'brief' ? 'project' : 'template'); setError('') }} className="mr-auto text-[13px] text-fg-muted hover:text-fg">← Back</button>
          ) : <span className="mr-auto" />}
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)" keyHint="Esc">Cancel</SheetButton>
          <SheetButton primary disabled={primary.disabled} onClick={primary.run} aria-keyshortcuts={primary.shortcut} title={`${primary.label} (${primary.hint})`} keyHint={busy ? undefined : primary.hint}>
            {primary.label}
          </SheetButton>
        </>
      )}
    >
      {step === 'template' && (
        <div ref={stepOne} className="grid gap-5 px-6 py-6">
          <div className="grid gap-1">
            <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-fg">Which template?</h3>
            {listError && <p role="alert" className="text-[13px] text-danger">{listError}</p>}
            {loaded && templates.length === 0 && <p className="text-[14px] leading-snug text-fg-muted">{EMPTY_TEMPLATES}</p>}
          </div>
          {templates.length > 0 && (
            <ul aria-label="Templates" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {templates.map((t) => {
                const on = !adding && pickedId === t.id
                return (
                  <li key={t.id} className="min-w-0">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => { setPickedId(t.id); setAdding(false); setError(''); setNameTouched(false) }}
                      // Enter on the chosen card moves on, as Enter does elsewhere in the sheet.
                      onKeyDown={(e) => { if (e.key === 'Enter' && on && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); void toProject() } }}
                      className={`grid w-full min-w-0 gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left ${on ? 'border-[var(--app-hairline-strong)] bg-[var(--app-row-active)]' : 'border-[var(--app-hairline)] hover:bg-[var(--app-row-hover)]'}`}
                    >
                      <span className="truncate text-[15px] font-medium text-fg">{t.name}</span>
                      <span className="mono truncate text-[12.5px] text-fg-muted">{t.github ? `github.com/${t.github}` : tildePath(t.folder ?? '', home)}</span>
                      <span className="mono truncate text-[12px] text-fg-faint">brief → {t.brief_path}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {templates.length > 0 && !adding && (
            <button type="button" onClick={() => { setAdding(true); setError(''); setNameTouched(false) }} className="justify-self-start text-[13.5px] text-fg-muted hover:text-fg">+ Another template</button>
          )}
          {showForm && (
            <AddTemplate
              home={home}
              gh={gh}
              draft={draft}
              onDraft={(d) => { setDraft(d); setNameTouched(false) }}
              save={save}
              onSave={setSave}
              onCancel={templates.length > 0 ? () => { setAdding(false); setDraft(null) } : undefined}
            />
          )}
          {chosen && (
            <AgentPicker value={agent} agents={agents} entries={catalog.entries} onChange={setAgent} dflt={dflt} />
          )}
        </div>
      )}
      {step === 'project' && chosen && how && (
        <div className="grid gap-5 px-6 py-6">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-fg">Name it</h3>
          <label className="grid min-w-0 gap-1.5">
            <span className="text-[13px] font-medium text-fg-muted">Name</span>
            <input
              aria-label="Name"
              className="input h-[46px] min-w-0"
              style={BIG_FIELD}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="my-project"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); setError('') }}
            />
            {(nameErr || exists) && <span role="alert" className="text-[12.5px] text-danger">{nameErr || exists}</span>}
          </label>
          <div className="grid min-w-0 gap-1.5">
            <label className="grid min-w-0 gap-1.5">
              <span className="text-[13px] font-medium text-fg-muted">In</span>
              <input aria-label="Parent folder" className="input mono h-[38px] min-w-0" spellCheck={false} autoComplete="off" value={parent} onChange={(e) => { setParent(e.target.value); setParentTouched(true) }} />
            </label>
            {chips.length > 0 && (
              <div role="group" aria-label="Places" className="flex min-w-0 flex-wrap gap-2">
                {chips.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={cleanParent === c}
                    onClick={() => { setParent(c); setParentTouched(true) }}
                    className={`mono h-[30px] rounded-full border px-3 text-[13px] ${cleanParent === c ? 'border-[var(--app-hairline-strong)] bg-[var(--app-row-active)] text-fg' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <p aria-label="Path" className="mono truncate text-[13px] text-fg-muted" title={dest}>{dest}</p>
          </div>
          {how.via === 'github' && (
            <div role="radiogroup" aria-label="Visibility" className="flex flex-wrap gap-4 text-[14px] text-fg">
              {(['private', 'public'] as const).map((v) => (
                <label key={v} className="flex items-center gap-2">
                  <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} />
                  {v === 'private' ? 'Private' : 'Public'}
                </label>
              ))}
            </div>
          )}
          <div className={`grid gap-2 rounded-[10px] border px-4 py-3 ${how.via ? 'border-[var(--app-hairline)]' : 'border-danger/50'}`}>
            <p role={how.via ? 'note' : 'alert'} aria-label="How it will be made" className={`text-[14px] leading-snug ${how.via ? 'text-fg' : 'text-danger'}`}>
              <Ticks text={howMadeLine(how, { github: chosen.github, name: name.trim() || 'my-project', dest })} />
            </p>
            {(how.kind === 'signed-out' || how.kind === 'none') && (
              <div className="flex flex-wrap gap-3 text-[13px]">
                <button type="button" onClick={() => { setLocal(false); onCheckAgain() }} className="text-accent hover:underline">Check again</button>
                {how.kind === 'signed-out' && how.folder && !local && (
                  <button type="button" onClick={() => setLocal(true)} className="text-fg-muted hover:text-fg">Make it locally</button>
                )}
                {how.kind === 'signed-out' && local && (
                  <button type="button" onClick={() => setLocal(false)} className="text-fg-muted hover:text-fg">On GitHub after all</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {step === 'brief' && chosen && (
        <div className="grid gap-5 px-6 py-6">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-fg">The brief</h3>
          <label className="grid min-w-0 gap-1.5" onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
            <span className="flex items-baseline gap-2 text-[13px] font-medium text-fg-muted">
              Brief <span className="mono font-normal text-fg-faint">→ {chosen.brief_path}</span>
            </span>
            <textarea
              aria-label="Brief"
              autoFocus
              className={`input min-h-[220px] resize-y leading-relaxed ${dragging ? 'border-accent' : ''}`}
              style={PROSE_FIELD}
              placeholder="Paste it, or drop a .md or .txt file here."
              value={brief}
              onChange={(e) => { setBrief(e.target.value); setDropNote(''); setError('') }}
            />
            {dropNote && <span role="status" className="text-[12.5px] text-fg-muted">{dropNote}</span>}
          </label>
          {plan && <Plan title="When you press Create" plan={plan} />}
        </div>
      )}
    </Sheet>
  )
}

/** `code` in a sentence, shown as code. */
function Ticks({ text }: { text: string }) {
  const parts = text.split('`')
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i} className="mono rounded-[4px] bg-[var(--app-row-hover)] px-1 text-[0.92em]">{p}</code> : <span key={i}>{p}</span>))}</>
}

/** What Create does, in order, and what leaves the machine. Always in sight on the last step. */
function Plan({ title, plan, at = -1, done = false }: { title: string; plan: { steps: PlanLine[]; sent: string }; at?: number; done?: boolean }) {
  return (
    <section aria-label={title} className="grid min-w-0 gap-2 rounded-[10px] border border-[var(--app-hairline)] px-4 py-3">
      <h4 className="text-[13px] font-medium text-fg-muted">{title}</h4>
      <ol className="grid min-w-0 gap-1.5 text-[13.5px] leading-snug text-fg">
        {plan.steps.map((s, i) => (
          <li key={i} className="flex min-w-0 gap-2">
            <span aria-hidden="true" className={`w-[18px] shrink-0 tabular-nums ${at >= 0 && (done || i < at) ? 'text-ok' : i === at ? 'text-accent' : 'text-fg-faint'}`}>
              {at >= 0 && (done || i < at) ? '✓' : `${i + 1}.`}
            </span>
            <span className="min-w-0 break-words">
              {s.code && <><code className="mono rounded-[4px] bg-[var(--app-row-hover)] px-1 text-[12.5px]">{s.code}</code> — </>}
              {s.text}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] text-fg-muted">{plan.sent}</p>
    </section>
  )
}

/** "+ Another template": a GitHub template repository or a folder, looked up on a click. */
function AddTemplate({
  home, gh, draft, onDraft, save, onSave, onCancel,
}: {
  home?: string
  gh?: GHStatus
  draft: Chosen | null
  onDraft: (d: Chosen | null) => void
  save: boolean
  onSave: (v: boolean) => void
  onCancel?: () => void
}) {
  const [kind, setKind] = useState<'github' | 'folder'>('github')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [insp, setInsp] = useState<Inspection | null>(null)
  const repo = kind === 'github' ? normalizeGitHub(typed) : null
  const ghReady = !!(gh?.installed && gh.logged_in)

  const lookUp = async () => {
    setProblem('')
    setInsp(null)
    onDraft(null)
    const src = kind === 'github' ? (repo ? { github: repo } : null) : typed.trim() ? { folder: expandTilde(typed.trim(), home) } : null
    if (!src) { setProblem(kind === 'github' ? 'owner/name, or a github.com link.' : 'A folder on this computer.'); return }
    setBusy(true)
    try {
      const r = await api.inspectTemplate(src)
      setInsp(r)
      const github = r.github
      const folder = kind === 'folder' ? r.folder : undefined
      onDraft({
        name: baseOf({ github, folder }) || 'template',
        github,
        folder,
        brief_path: r.brief_path,
        prompt: r.prompt,
        localFolder: r.local_folder || undefined,
        suggestedName: r.suggested_name || undefined,
      })
    } catch (e) {
      setProblem(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const choose = async () => {
    try {
      const dir = await shell.pickFolder(typed.trim() ? expandTilde(typed.trim(), home) : undefined)
      if (dir) setTyped(tildePath(dir, home))
    } catch (e) {
      setProblem(errText(e))
    }
  }

  const result = insp ? lookupLine(insp, ghReady) : null
  const briefHint = insp ? (insp.brief_from === 'marker' ? 'from TEMPLATE.md' : insp.brief_from === 'mention' ? 'named in TEMPLATE.md or the README' : 'a guess') : ''
  return (
    <section aria-label="Another template" className="grid min-w-0 gap-3 rounded-[10px] border border-[var(--app-hairline)] px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div role="radiogroup" aria-label="Kind" className="flex gap-1 rounded-[8px] bg-[var(--app-row-hover)] p-0.5 text-[13px]">
          {(['github', 'folder'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => { setKind(k); setTyped(''); setInsp(null); setProblem(''); onDraft(null) }}
              className={`h-[28px] rounded-[6px] px-3 ${kind === k ? 'bg-panel text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
            >
              {k === 'github' ? 'GitHub template' : 'A folder'}
            </button>
          ))}
        </div>
        {onCancel && <button type="button" onClick={onCancel} className="ml-auto text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>}
      </div>
      <div className="flex min-w-0 gap-2">
        <input
          aria-label={kind === 'github' ? 'GitHub template' : 'Template folder'}
          data-own-enter=""
          className="input mono h-[38px] min-w-0 flex-1"
          spellCheck={false}
          autoComplete="off"
          placeholder={kind === 'github' ? 'owner/name or a github.com link' : '~/templates/site'}
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setProblem('') }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void lookUp() } }}
        />
        {kind === 'folder' && isTauri() && (
          <button type="button" onClick={() => void choose()} className="h-[38px] shrink-0 rounded-[8px] border border-[var(--app-hairline-strong)] px-3 text-[13.5px] text-fg hover:bg-[var(--app-row-hover)]">Choose…</button>
        )}
        <button type="button" disabled={busy} onClick={() => void lookUp()} className="h-[38px] shrink-0 rounded-[8px] border border-[var(--app-hairline-strong)] px-3 text-[13.5px] text-fg hover:bg-[var(--app-row-hover)] disabled:opacity-50">
          {busy ? 'Looking…' : 'Look up'}
        </button>
      </div>
      <p className="text-[12.5px] text-fg-faint">
        {kind === 'github'
          ? <>Reads TEMPLATE.md and README.md from <span className="mono">github.com/{repo ?? 'owner/name'}</span> with your gh login.</>
          : <>Reads TEMPLATE.md and README.md in that folder. Nothing leaves this computer.</>}
      </p>
      {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
      {result && <p role="status" className={`text-[13.5px] ${result.bad ? 'text-danger' : 'text-fg'}`}>{result.text}</p>}
      {draft && (
        <>
          <label className="grid min-w-0 gap-1">
            <span className="flex items-baseline gap-2 text-[13px] font-medium text-fg-muted">Brief goes to <span className="font-normal text-fg-faint">{briefHint}</span></span>
            <input aria-label="Brief goes to" className="input mono h-[34px]" spellCheck={false} value={draft.brief_path} onChange={(e) => onDraft({ ...draft, brief_path: e.target.value })} />
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="flex items-baseline gap-2 text-[13px] font-medium text-fg-muted">
              First message to the agent
              <span className="font-normal text-fg-faint">{'{brief}'} is the brief’s path{insp?.prompt_from === 'marker' ? ' · from TEMPLATE.md' : ''}</span>
            </span>
            <textarea aria-label="First message to the agent" className="input min-h-[64px] resize-y leading-relaxed" style={PROSE_FIELD} value={draft.prompt} onChange={(e) => onDraft({ ...draft, prompt: e.target.value })} />
          </label>
          <label className="flex min-w-0 items-center gap-2 text-[13.5px] text-fg">
            <input type="checkbox" checked={save} onChange={(e) => onSave(e.target.checked)} />
            <span className="shrink-0">Save as a template:</span>
            <input aria-label="Template name" className="input h-[30px] min-w-0 flex-1" disabled={!save} value={draft.name} onChange={(e) => onDraft({ ...draft, name: e.target.value })} />
          </label>
        </>
      )}
    </section>
  )
}

/** The line under Look up: what GitHub (or the folder) said. */
export function lookupLine(insp: Inspection, ghReady: boolean): { text: string; bad: boolean } | null {
  const md = insp.template_md ? 'has TEMPLATE.md' : 'no TEMPLATE.md'
  if (insp.folder) return { text: `A folder${insp.github ? ` · github.com/${insp.github}` : ''} · ${md}`, bad: false }
  if (insp.is_template === true) return { text: `Template repository · ${insp.visibility ?? 'visibility unknown'} · ${md}`, bad: false }
  if (insp.is_template === false) return { text: `${insp.github} is not a template repository. On GitHub: Settings → Template repository.`, bad: true }
  if (insp.error) {
    if (ghReady) return { text: 'Not found, or your gh login can’t see it.', bad: true }
    return { text: `${insp.error}${insp.local_folder ? ` Read from ${insp.local_folder} instead.` : ''}`, bad: !insp.local_folder }
  }
  return null
}

/** After Create: the plan with its steps ticked off, progress or what went wrong in the footer. */
function JobView({
  job, op, home, onClose, onOp, onStartAgent, onReset,
}: {
  job: TemplateJob
  op?: TemplateOp
  home?: string
  onClose: () => void
  onOp: (op: TemplateOp) => void
  onStartAgent: (job: TemplateJob) => void
  onReset: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [retryErr, setRetryErr] = useState('')
  const failed = op?.state === 'failed'
  const fail = failed && op ? failureView(op, home) : null
  const retry = async () => {
    setBusy(true)
    setRetryErr('')
    try {
      const r = await api.retryOp(job.op_id)
      onOp({ ...r.op, kind: 'template' })
    } catch (e) {
      setRetryErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const at = planStep(job, op)
  const notes = (op?.notes ?? []).filter(Boolean)
  let footer: ReactNode
  if (job.agentError) {
    footer = (
      <>
        <p role="alert" className="mr-auto min-w-0 text-[13px] text-danger">The project is made, but {job.agentLabel} did not start: {job.agentError}</p>
        <SheetButton onClick={onClose}>Close</SheetButton>
        <SheetButton primary onClick={() => onStartAgent(job)}>Start an agent</SheetButton>
      </>
    )
  } else if (fail) {
    footer = (
      <>
        <div className="mr-auto grid min-w-0 gap-1">
          <p role="alert" className="text-[13px] text-danger">{fail.text}</p>
          {retryErr && <p className="text-[12.5px] text-danger">{retryErr}</p>}
        </div>
        <SheetButton onClick={onReset}>Start over</SheetButton>
        {fail.repoUrl && <a href={fail.repoUrl} target="_blank" title={extTitle()} rel="noreferrer" className="inline-flex h-[34px] items-center rounded-[7px] border border-[var(--app-hairline-strong)] px-4 text-[14px] font-medium text-fg hover:bg-[var(--app-row-hover)]">Open on GitHub</a>}
        {fail.retry && (
          <SheetButton primary disabled={busy} onClick={() => void retry()}>
            {op?.step === 'clone' ? 'Try the clone again' : 'Try again'}
          </SheetButton>
        )}
      </>
    )
  } else {
    footer = (
      <>
        <p role="status" aria-live="polite" className="mr-auto min-w-0 truncate text-[13px] text-fg">{progressLine(op, job.agentLabel, job.starting)}</p>
        <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Hide (Esc): it carries on" keyHint="Esc">Hide</SheetButton>
      </>
    )
  }
  return (
    <Sheet label="New project from a template" title={<StepsHeader title="From a template" steps={STEPS} step="brief" />} onClose={onClose} width={680} footer={footer}>
      <div className="grid gap-4 px-6 py-6">
        <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-fg">
          {failed ? `${job.name} was not made` : job.agentError ? `${job.name} is made` : `Making ${job.name}`}
        </h3>
        <Plan title="What happens" plan={job.plan} at={at} done={op?.state === 'done'} />
        {fail?.keep && <p className="text-[13px] text-fg-muted">{fail.keep}</p>}
        {notes.length > 0 && (
          <ul aria-label="Notes" className="grid gap-1 text-[13px] text-fg-muted">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    </Sheet>
  )
}

/** Which line of the plan the operation is on. */
function planStep(job: TemplateJob, op?: TemplateOp): number {
  if (!op) return 0
  if (op.state === 'done') return job.plan.steps.length - 1
  const order = job.via === 'github' ? ['create', 'clone', 'brief', 'start'] : ['copy', 'copy', 'brief', 'start']
  const step = op.step === 'commit' ? 'brief' : op.step === 'add' ? 'brief' : op.step
  const i = order.indexOf(step ?? '')
  return i < 0 ? 0 : i
}
