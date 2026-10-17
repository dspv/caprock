/**
 * New agent (⇧⌘N): which agent, which model, what it may do without asking,
 * where — the project's checkout, one of its worktrees, or a new worktree —
 * and, optionally, what to say first. The same `POST /v1/agents` the
 * dashboard's dialog and the phone use; the tab opens on success.
 *
 * Filled entirely from the keyboard (owner, 2026-10-07): focus opens on the
 * Project search (owner, 2026-10-10: a native select had no search), with the
 * current project first, so Enter keeps it and a second Enter starts; typing
 * finds a project, a recent folder or a repository under the default folder,
 * and picking one that is not a project yet adds it (ProjectSearch.tsx).
 * Tab and ⇧Tab walk Project, Where, Agent, Model, Subscription (when there
 * is more than one, ADR-048), Permissions,
 * First message, Cancel, Start in that order; ↑ and ↓ change a select in
 * place; ⌘↩ starts from anywhere in the sheet, the buttons included; Esc
 * cancels. The keys are named in the footer and on Start itself.
 *
 * Where is worded for someone who has never heard of a git worktree (owner,
 * 2026-10-09: "existing or new — totally unclear"): *This folder* is the
 * project's own checkout, *Existing copy* a worktree already there, *New copy
 * on its own branch* a new one, explained in a line under the name field.
 *
 * *Attempts* (ADR-052), under a new copy: 1 to 4 agents on the same first
 * message, each in a copy of its own from the same branch, to compare and
 * keep one. Not remembered: every start is one agent unless asked.
 *
 * *From GitHub* (when the project's remote is on github.com and GitHub is
 * connected, or when asked for by ⌘K → New agent from issue…): pick an open
 * issue or pull request (GitHubItemPicker). An issue prefills a new copy's
 * name (`issue-123-short-slug`) and the first message (its title, link and
 * text, trimmed); a pull request does the same and starts the copy at the
 * pull request's head, fetched from the remote (`worktree_pr`), a fork's
 * too. Everything stays editable before Start.
 *
 * Where it starts is in sight (owner, 2026-10-14): a multi-repo project's
 * members are named under Project ("3 repos: api, web, infra"); *New
 * project…* beside it opens the New project wizard and comes back here on
 * it; and what the agent will be told — Caprock's instructions and the
 * repository's own CLAUDE.md / AGENTS.md — is a block of its own, each
 * "Set · 12 lines" or "None", a click from being read or edited.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { AgentPicker, isCustomAgent, startable, useAgentCatalog, useAgentChoice } from './AgentPicker'
import { AgentObservedNote, AgentSetupNote } from './AgentSetup'
import { DEFAULT_MODE, DEFAULT_MODELS, GEMINI_MAPPED, ModelField, modeNotes, modeOptions } from './SpawnDialog'
import { useInitialMode } from '@/lib/permissionMode'
import type { SpawnAgent } from './AgentPicker'
import { projectsApi, type BranchInfo, type Project } from '@/lib/projects'
import { ProjectCombobox } from './ProjectSearch'
import { BranchPicker } from './BranchPicker'
import type { Candidate } from '@/lib/projectSearch'
import { ProjectSetupCommand } from './ProjectSetupCommand'
import { ProjectInstructions } from './ProjectInstructions'
import { repoChoices } from '@/lib/multirepo'
import { Sheet, SheetButton, SheetField } from './Sheet'
import { stepSelect } from '@/lib/selectKeys'
import { BypassConsentNote, useBypassConsent } from './BypassConsent'
import { defaultWorktreeName, WORKTREE_NAME } from '@/lib/slug'
import { isMacPlatform } from '@/lib/appmode'
import { SubscriptionNote, SubscriptionPicker, subscriptionsFor, useSubscriptionList } from './SubscriptionPicker'
import { chosenId, preferredId, rememberedSubscription, rememberSubscription } from '@/lib/subscriptions'
import { useGitHubStatus } from '@/lib/github'
import { githubRepoOf, itemBranchName, itemPrompt, type GitHubItem } from '@/lib/fromGitHub'
import { GitHubItemPicker } from './GitHubItemPicker'
import { extTitle } from '@/lib/externalLinks'

const NEW_WORKTREE = '__new__'

/** What the Where select says of a worktree, for a tooltip: the plain words
 *  in the options are "copy", and this is where the git term lives. */
export const WHERE_TOOLTIP = 'A copy is a git worktree: a second folder of the same repository, checked out on its own branch.'

/** The last segment of a path, either separator. */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function NewAgentSheet({
  projects,
  projectId,
  cwd: initialCwd,
  prompt: initialPrompt = '',
  worktree: initialWorktree,
  here = false,
  fromGitHub = false,
  onClose,
  onSetup,
  onProjectAdded,
  onNewProject,
  onStarted,
  onAttempts,
}: {
  projects: Project[]
  projectId?: string
  /** A worktree's folder, when the sheet was opened from one. */
  cwd?: string
  /** A first message already typed (the palette's "new task"). */
  prompt?: string
  /** A new worktree's name, proposed: the sheet opens on "New worktree…" with it filled in. */
  worktree?: string
  /** Open on `cwd` itself — This folder when it is the project's root — rather than the way to start remembered from last time. */
  here?: boolean
  /** Open on the From GitHub picker (⌘K → New agent from issue…). */
  fromGitHub?: boolean
  onClose: () => void
  /** Opens a shell tab in `home` with an agent's install or sign-in typed, not run (ADR-046). */
  onSetup?: (command: string, home?: string) => void
  /** A repository picked in the search was added as a project. */
  onProjectAdded?: (projectId: string) => void
  /** New project…: the wizard, handed the first message typed so far; it comes back here on the new project. */
  onNewProject?: (prompt: string) => void
  onStarted: (sessionId: string, projectId: string, title: string) => void
  /** Several attempts started (ADR-052): their sessions in order, and why any after the first did not start. */
  onAttempts?: (sessionIds: string[], projectId: string, title: string, error?: string) => void
}) {
  // Which OpenCode is installed decides what a mode becomes in it.
  const status = useApi(() => api.status(), [], { live: false })
  // Every agent Caprock knows, installed or not (ADR-046): the ones that can
  // start are the choices, and the rest are listed after them so the way to
  // set one up is a pick away.
  const catalog = useAgentCatalog()
  const agents = useMemo(() => startable(catalog.entries), [catalog.entries])
  const checking = !catalog.loaded
  const [agent, setAgent, agentDefault] = useAgentChoice(agents)
  const entry = catalog.entries.find((e) => e.id === agent)
  const canStart = entry ? entry.installed && !entry.locked : agents.includes(agent)
  const custom = isCustomAgent(agent)
  const [pid, setPid] = useState(projectId ?? projects[0]?.id ?? '')
  // Projects added from the search while the sheet is open, until the
  // caller's list catches up.
  const [added, setAdded] = useState<Project[]>([])
  const [adding, setAdding] = useState(false)
  const allProjects = useMemo(() => [...projects, ...added.filter((a) => !projects.some((p) => p.id === a.id))], [projects, added])
  const project = allProjects.find((p) => p.id === pid)
  // A project of several repositories asks which one (ADR-077): the home
  // repository (or a folder project's folder) first, or the one the sheet
  // was opened from.
  const choices = useMemo(() => repoChoices(project), [project])
  const [repoPick, setRepoPick] = useState(initialCwd && choices.some((c) => c.path === initialCwd) ? initialCwd : '')
  const repoDir = choices.some((c) => c.path === repoPick) ? repoPick : choices[0]?.path ?? ''
  // Copies and branches are the project's root checkout's: a member's own
  // are not listed, and a new copy of it starts from its checked-out commit.
  const atRoot = !repoDir || repoDir === project?.root
  const repoBranch = atRoot ? project?.branch : project?.repos?.find((r) => r.path === repoDir)?.branch
  const worktrees = useMemo(() => (atRoot ? (project?.worktrees ?? []).filter((w) => w.path !== project?.root) : []), [project, atRoot])
  // A new copy is remembered as the way to start: someone who starts every
  // agent from a fresh main should not pick it every time (owner, 2026-10-10).
  const [where, setWhereRaw] = useState(initialWorktree ? NEW_WORKTREE : initialCwd && initialCwd !== project?.root && !choices.some((c) => c.path === initialCwd) ? initialCwd : here && initialCwd ? '' : readWhere())
  const setWhere = (v: string) => { setWhereRaw(v); writeWhere(v === NEW_WORKTREE ? NEW_WORKTREE : '') }
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [base, setBase] = useState('')
  const [pull, setPullRaw] = useState(readPull)
  const setPull = (v: boolean) => { setPullRaw(v); writePull(v) }
  useEffect(() => {
    if (where !== NEW_WORKTREE || !project || !atRoot) return
    let alive = true
    setBranchesLoading(true)
    projectsApi.branches(project.id).then((list) => {
      if (!alive) return
      setBranches(list)
      setBase((b) => (b && list.some((x) => x.name === b) ? b : list.find((x) => x.default)?.name ?? list[0]?.name ?? ''))
    }).catch(() => { if (alive) setBranches([]) }).finally(() => { if (alive) setBranchesLoading(false) })
    return () => { alive = false }
  }, [where, project?.id, atRoot])
  const [newBranch, setNewBranch] = useState(initialWorktree ?? '')
  // From GitHub: the picked issue or pull request, and whether the picker is open.
  const github = useGitHubStatus()
  const ghRepo = githubRepoOf(project?.remote_url)
  const [ghOpen, setGhOpen] = useState(fromGitHub)
  const [ghItem, setGhItem] = useState<GitHubItem | null>(null)
  const fromPR = where === NEW_WORKTREE && ghItem?.pr ? ghItem.number : 0
  const pickItem = (it: GitHubItem) => {
    setGhItem(it)
    setGhOpen(false)
    setError('')
    setWhereRaw(NEW_WORKTREE) // for this start only: the remembered way to start stays
    setNewBranch(itemBranchName(it))
    setPrompt(itemPrompt(it))
  }
  const [attempts, setAttempts] = useState(1)
  const several = where === NEW_WORKTREE && attempts > 1
  const [models, setModels] = useState<Record<SpawnAgent, string>>(DEFAULT_MODELS)
  const [mode, setMode, rememberMode] = useInitialMode(DEFAULT_MODE)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const consent = useBypassConsent(agent, mode)
  // The sign-in it runs on (ADR-048): remembered per project; a pick from
  // the near-limit note holds for this session only.
  const subscriptions = useSubscriptionList()
  const subList = subscriptionsFor(subscriptions.all, agent)
  const subKey = `${agent}|${pid}`
  const [subPick, setSubPick] = useState<Record<string, string>>({})
  const subWanted = subPick[subKey] ?? rememberedSubscription(agent, pid)
  const subId = chosenId(subList, subWanted)
  // Picking the default remembers nothing, so a later Make default reaches this project too.
  const chooseSub = (id: string) => { rememberSubscription(agent, pid, id === preferredId(subList) ? '' : id); setSubPick((p) => ({ ...p, [subKey]: id })) }
  const pickSubOnce = (id: string) => setSubPick((p) => ({ ...p, [subKey]: id }))
  // The name is optional: left empty, it comes from the first message.
  const worktreeName = newBranch.trim() || defaultWorktreeName(prompt)
  const nameBad = !!newBranch.trim() && !WORKTREE_NAME.test(newBranch.trim())

  // ⌘↩ from anywhere in the sheet — a select, the footer's buttons — not only
  // from the fields' grid. A ref keeps the listener on the latest state.
  const startRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      startRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const start = async () => {
    if (!project) { setError('Pick a project first.'); return }
    if (where === NEW_WORKTREE && nameBad) return
    if (several && !prompt.trim()) { setError('Attempts need a first message: it is what each one works on.'); return }
    setBusy(true)
    setError('')
    try {
      if (consent.needed) await consent.accept()
      const req: Parameters<typeof api.spawn>[0] = { cwd: where && where !== NEW_WORKTREE && atRoot ? where : repoDir || project.root }
      if (agent !== 'claude') req.agent = agent
      // Named whenever there is a choice: "default" is the own sign-in, and
      // leaving it out would mean the one made the default.
      if (subList.length > 1) req.subscription = subId
      const model = models[agent]?.trim()
      if (model) req.model = model
      // A custom agent's flags are its own; Caprock maps no mode onto them.
      if (mode && !custom) req.permission_mode = mode
      if (where === NEW_WORKTREE) {
        req.worktree = worktreeName
        if (fromPR) req.worktree_pr = fromPR
        else if (base && atRoot) { req.worktree_base = base; req.worktree_pull = pull }
      }
      if (prompt.trim()) req.prompt = prompt.trim()
      if (several) req.attempts = attempts
      const res = await api.spawn(req)
      rememberMode()
      const title = prompt.trim().slice(0, 60) || 'new session'
      if (several && res.session_ids && onAttempts) onAttempts(res.session_ids, project.id, title, res.error)
      else onStarted(res.session_id, project.id, title)
      onClose()
    } catch (e) {
      if (!consent.noteRefusal(e)) setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // A pick from the project search: a project is chosen; a recent folder or a
  // repository under the default folder is added first, then chosen.
  const pickProject = async (c: Candidate) => {
    setError('')
    if (c.projectId !== pid) setGhItem(null)
    if (c.projectId) { setPid(c.projectId); setWhereRaw((w) => (w === NEW_WORKTREE ? NEW_WORKTREE : '')); return }
    setAdding(true)
    try {
      const res = await projectsApi.add({ path: c.path })
      if (!('project' in res)) return
      setAdded((cur) => [...cur, res.project])
      setPid(res.project.id)
      setWhereRaw((w) => (w === NEW_WORKTREE ? NEW_WORKTREE : ''))
      onProjectAdded?.(res.project.id)
    } catch (e) {
      setError(`Could not add ${c.name}: ${errText(e)}`)
    } finally {
      setAdding(false)
    }
  }

  startRef.current = () => { if (!busy && !adding && canStart) void start() }
  const startKey = isMacPlatform() ? '⌘↩' : 'Ctrl+↵'

  return (
    <Sheet
      label="New agent"
      title="New agent"
      onClose={onClose}
      width={600}
      footer={
        <>
          {error
            ? <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>
            : (
              <p className="mr-auto min-w-0 truncate text-[12.5px] text-fg-muted" aria-label="Keys: Tab moves, arrows change a choice">
                {/* Start and Cancel carry their own keys on the buttons. */}
                <span className="mono">Tab</span> moves · <span className="mono">↑↓</span> change
              </p>
            )}
          <SheetButton onClick={onClose} aria-keyshortcuts="Escape" title="Cancel (Esc)" keyHint="Esc">Cancel</SheetButton>
          <SheetButton
            primary
            disabled={busy || !canStart}
            onClick={() => void start()}
            aria-keyshortcuts={isMacPlatform() ? 'Meta+Enter' : 'Control+Enter'}
            title={`Start (${startKey})`}
            keyHint={busy ? undefined : startKey}
          >
            {busy ? 'Starting…' : consent.needed ? 'Accept and start' : several ? `Start ${attempts}` : 'Start'}
          </SheetButton>
        </>
      }
    >
      {checking ? (
        <div className="h-[320px]" />
      ) : catalog.entries.length === 0 ? (
        <p className="px-5 py-5 text-[13px] text-fg-muted">
          No agent Caprock can start was found on this machine — not <span className="mono">claude</span>, <span className="mono">codex</span>, <span className="mono">opencode</span>, <span className="mono">gemini</span> or <span className="mono">grok</span>.
        </p>
      ) : (
        <div className="grid gap-4 px-5 py-4" onKeyDown={(e) => { stepSelect(e) }}>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-1.5">
              <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
                Project
                {onNewProject && (
                  <button type="button" onClick={() => onNewProject(prompt)} className="ml-auto text-[12px] font-normal text-accent hover:underline">New project…</button>
                )}
              </span>
              <ProjectCombobox projects={allProjects} value={pid} busy={adding} autoFocus onPick={(c) => void pickProject(c)} onSubmit={() => startRef.current()} onNewProject={onNewProject && (() => onNewProject(prompt))} />
              {choices.length > 0 ? (
                <select aria-label="Repository" className="input mono" title={choices.map((c) => c.path).join('\n')} value={repoDir} onChange={(e) => { setRepoPick(e.target.value); if (where && where !== NEW_WORKTREE) setWhereRaw('') }}>
                  {choices.map((c) => <option key={c.path} value={c.path}>{c.label}</option>)}
                </select>
              ) : null}
            </div>
            <SheetField label="Where">
              <select className="input" title={WHERE_TOOLTIP} value={where} onChange={(e) => setWhere(e.target.value)}>
                <option value={NEW_WORKTREE}>New copy from a branch</option>
                <option value="">{repoBranch ? `This folder · ${repoBranch}` : 'This folder'}</option>
                {worktrees.map((w) => <option key={w.path} value={w.path}>Existing copy · {w.branch || w.name}</option>)}
                {atRoot && initialCwd && initialCwd !== project?.root && !choices.some((c) => c.path === initialCwd) && !worktrees.some((w) => w.path === initialCwd) && <option value={initialCwd}>Existing copy · {baseName(initialCwd)}</option>}
              </select>
            </SheetField>
          </div>
          {project && ghItem ? (
            <div className="flex min-w-0 items-center gap-2 rounded-[8px] border border-border px-2.5 py-1.5 text-[12.5px]" aria-label="Started from GitHub">
              <span className="shrink-0 text-fg-muted">{ghItem.pr ? 'Pull request' : 'Issue'} <span className="mono">#{ghItem.number}</span></span>
              <a href={ghItem.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-fg hover:underline" title={extTitle(ghItem.title)}>{ghItem.title}</a>
              <button type="button" className="shrink-0 text-[12px] text-accent hover:underline" onClick={() => setGhOpen(true)}>Change</button>
              <button type="button" className="shrink-0 text-[12px] text-fg-muted hover:text-fg" aria-label="Not from GitHub" title="Not from GitHub: keep the fields as they are" onClick={() => { setGhItem(null); setGhOpen(false) }}>×</button>
            </div>
          ) : null}
          {project && ghOpen ? (
            <GitHubItemPicker key={`github-${project.id}`} projectId={project.id} onPick={pickItem} onClose={() => setGhOpen(false)} />
          ) : project && !ghItem && ghRepo && github.status?.connected ? (
            <button type="button" className="justify-self-start text-[12.5px] text-accent hover:underline" onClick={() => setGhOpen(true)}>
              From a GitHub issue or pull request…
            </button>
          ) : null}
          {where === NEW_WORKTREE && (
            <div className="grid min-w-0 gap-2">
              <div className="grid grid-cols-2 gap-3">
                {fromPR ? (
                  <div className="grid min-w-0 gap-1.5">
                    <span className="text-[12px] font-medium text-fg-muted">From</span>
                    <span className="input truncate text-fg-muted" title="The pull request's head commit, fetched from the remote when it starts">pull request <span className="mono">#{fromPR}</span>, its head</span>
                  </div>
                ) : !atRoot ? (
                  <div className="grid min-w-0 gap-1.5">
                    <span className="text-[12px] font-medium text-fg-muted">From</span>
                    <span className="input truncate text-fg-muted" title="A copy of this repository from the commit it has checked out">{repoBranch ? <span className="mono">{repoBranch}</span> : 'its checkout'}, as it is now</span>
                  </div>
                ) : (
                  <div className="grid min-w-0 gap-1.5">
                    <span className="text-[12px] font-medium text-fg-muted">From branch</span>
                    <BranchPicker branches={branches} value={base} onChange={setBase} loading={branchesLoading} />
                  </div>
                )}
                <SheetField
                  label="New branch name"
                  hint={nameBad ? <span className="text-danger">letters, digits, dot and dash only</span> : 'optional'}
                >
                  <input className="input" aria-invalid={nameBad || undefined} placeholder={worktreeName} value={newBranch} onChange={(e) => setNewBranch(e.target.value)} spellCheck={false} />
                </SheetField>
              </div>
              {!fromPR && atRoot && base && branches.find((b) => b.name === base)?.remote && (
                <label className="flex items-center gap-2 text-[13px] text-fg">
                  <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
                  Pull the latest <span className="mono">{base}</span> from {branches.find((b) => b.name === base)?.remote} first
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <SheetField label="Attempts" hint={several ? 'one copy each' : 'compare and keep one'}>
                  <select className="input" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
                    {ATTEMPT_CHOICES.map((n) => <option key={n} value={n}>{n === 1 ? '1 agent' : `${n} agents, same message`}</option>)}
                  </select>
                </SheetField>
              </div>
              {several ? (
                <p className="text-[12px] leading-snug text-fg-faint" title={WHERE_TOOLTIP}>
                  {attempts} separate folders, one agent each, all from {fromPR ? <>pull request <span className="mono text-fg-muted">#{fromPR}</span>’s head</> : base ? <span className="mono text-fg-muted">{base}</span> : 'the same commit'}: <span className="mono text-fg-muted">caprock/{worktreeName}-1</span> to <span className="mono text-fg-muted">-{attempts}</span>. Compare what each changed and cost, then keep the one you want.
                </p>
              ) : (
                <p className="text-[12px] leading-snug text-fg-faint" title={WHERE_TOOLTIP}>
                  A separate folder, so this agent doesn’t collide with others: <span className="mono text-fg-muted">caprock/{worktreeName}</span>{fromPR ? <> at pull request <span className="mono text-fg-muted">#{fromPR}</span>’s head, fetched from the remote</> : base ? <> from <span className="mono text-fg-muted">{base}</span></> : null}.
                </p>
              )}
              {project && <ProjectSetupCommand key={project.id} project={project} />}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {catalog.entries.length > 1 ? <AgentPicker value={agent} agents={agents} entries={catalog.entries} onChange={setAgent} dflt={agentDefault} /> : <div />}
            {canStart && (
              <SheetField label="Model">
                <ModelField agent={agent} value={models[agent] ?? ''} onChange={(v) => setModels((m) => ({ ...m, [agent]: v }))} entry={entry} />
              </SheetField>
            )}
            {/* Under Agent, on a row of its own: a third column cut both
              * selects' text off at the sheet's width. */}
            {canStart && <SubscriptionPicker list={subList} value={subId} onChange={chooseSub} />}
          </div>
          {canStart && <SubscriptionNote list={subList} value={subId} onUse={pickSubOnce} />}
          {entry?.setup && <AgentSetupNote entry={entry} onSetup={onSetup && ((cmd) => { onSetup(cmd, catalog.home); onClose() })} />}
          {entry?.locked && (
            <p role="note" className="text-[12.5px] text-fg-muted">Custom agents are a Premium feature; add a licence key in Settings → Plan &amp; licence to start {entry.label}.</p>
          )}
          {canStart && <AgentObservedNote entry={entry} />}
          {canStart && !custom && <SheetField label="Permissions" hint="kept for the next agent">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {modeOptions(mode).map(([v, label]) => (
                <option key={v} value={v}>
                  {agent === 'gemini' && !GEMINI_MAPPED.has(v) ? `${label} · Gemini asks instead` : modeNotes(agent, status.data?.opencode_version)?.[v] ?? label}
                </option>
              ))}
            </select>
          </SheetField>}
          {consent.needed && <BypassConsentNote />}
          {project && <ProjectInstructions key={project.id} project={project} agent={agent} />}
          <SheetField label="First message" hint={entry && !entry.prompt ? "not sent: this agent's arguments have no {prompt}" : 'optional'}>
            <textarea
              className="input min-h-[84px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed"
              placeholder="What should it do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </SheetField>
        </div>
      )}
    </Sheet>
  )
}

/** How many attempts one start may make; the daemon allows the same (attemptsMax). */
const ATTEMPT_CHOICES = [1, 2, 3, 4]

const WHERE_KEY = 'caprock.newAgent.where'
const PULL_KEY = 'caprock.newAgent.pull'
function readWhere(): string {
  try { return localStorage.getItem(WHERE_KEY) === NEW_WORKTREE ? NEW_WORKTREE : '' } catch { return '' }
}
function writeWhere(v: string): void {
  try { localStorage.setItem(WHERE_KEY, v) } catch { /* remembered for this sheet only */ }
}
function readPull(): boolean {
  try { return localStorage.getItem(PULL_KEY) !== '0' } catch { return true }
}
function writePull(v: boolean): void {
  try { localStorage.setItem(PULL_KEY, v ? '1' : '0') } catch { /* remembered for this sheet only */ }
}
