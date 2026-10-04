/**
 * What Caprock for Teams gives a lead — shown, then said in four lines.
 *
 * The previous dialog was a wall of text: a paragraph and eight bullets under
 * two headings, and the owner called it bad. A lead decides from a picture of
 * the thing, so the dialog now opens with one: the Week card at team scale —
 * laptops, pull requests, cost per PR, the share spent re-reading context —
 * with the same characters and an agent and repository strip. Every figure in
 * it is an example and the picture is tagged "Example team" (rule 6); nothing
 * on it is anyone's data.
 *
 * Then the reader's own number when there is one (this machine alone), four
 * benefits with icons, one line on trust and one on the price's shape.
 *
 * The trust line claims exactly what the team page and .ai/17-teams.md claim:
 * it runs on the team's own infrastructure and receives counters only —
 * prompts and code never leave a laptop. The price is a shape, not a figure:
 * one flat price for the whole team, never per seat, with a link to the
 * pricing page. A figure copied here would eventually contradict that page.
 *
 * Rule 11: the team version is presented as the product. Nothing here says
 * pilot, coming soon or not built.
 */
import { fmtUSD } from '@/lib/format'
import { AgentCharacter, type Character } from './Characters'
import { Benefit, Icon, MiniCard, UpsellDialog } from './UpsellDialog'

const TEAMS = 'https://caprock.dev/teams'
const BOOK = 'https://caprock.dev/book/'
const PRICING = 'https://caprock.dev/pricing/'

export interface TeamsFact {
  costUSD: number
  projects: number
  /** How the window reads in a sentence: "in the last 30 days", "all time". */
  window: string
}

/** The example team. Illustrative figures, consistent with each other. */
const EXAMPLE = {
  laptops: 8,
  prs: 412,
  perPR: '≈$2.90',
  reread: '61%',
  agents: [
    { who: 'lead' as Character, name: 'Claude Code', cost: '$830' },
    { who: 'crowd' as Character, name: 'Subagents', cost: '$240' },
    { who: 'codex' as Character, name: 'Codex', cost: '$125' },
  ],
  repos: [
    { name: 'api', share: 46 },
    { name: 'web', share: 31 },
    { name: 'infra', share: 23 },
  ],
}

function TeamPicture() {
  const e = EXAMPLE
  return (
    <MiniCard tag="Example team" label={`Example team week: ${e.laptops} laptops, ${e.prs} PRs, ${e.perPR} per PR, ${e.reread} of the cost re-reading context. Illustrative figures.`}>
      <p className="wk-eyebrow" style={{ fontSize: 11 }}>{e.laptops} laptops · one week</p>
      <p className="mt-1 text-[24px] font-extrabold leading-[1.05] tracking-[-0.025em] text-fg">
        The team shipped <span className="text-accent">{e.prs} PRs</span>.
      </p>
      <div className="mt-2.5 grid grid-cols-2 gap-x-4 border-y border-border py-2">
        <p><span className="font-mono text-[20px] font-bold text-fg">{e.perPR}</span> <span className="text-[11.5px] text-fg-muted">per PR</span></p>
        <p><span className="font-mono text-[20px] font-bold text-fg">{e.reread}</span> <span className="text-[11.5px] text-fg-muted">re-reading context</span></p>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        {e.agents.map((a) => (
          <div key={a.name} className="flex items-center gap-1.5 rounded-[9px] border border-border bg-panel-2/70 px-1.5 py-1">
            <AgentCharacter who={a.who} size={26} />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[11px] font-semibold text-fg">{a.name}</p>
              <p className="font-mono text-[10.5px] text-fg-muted">{a.cost}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex h-2 overflow-hidden rounded-full">
        {e.repos.map((r, i) => (
          <div key={r.name} style={{ width: `${r.share}%`, opacity: 1 - i * 0.28 }} className="bg-accent" />
        ))}
      </div>
      <p className="mt-1 flex gap-3 font-mono text-[10.5px] text-fg-muted">
        {e.repos.map((r) => <span key={r.name}>{r.name} {r.share}%</span>)}
      </p>
    </MiniCard>
  )
}

export function TeamsModal({ fact, onClose }: { fact?: TeamsFact; onClose: () => void }) {
  const measured = !!fact && fact.costUSD > 0 && fact.projects > 0
  return (
    <UpsellDialog
      label="Caprock for Teams"
      eyebrow="Caprock for Teams"
      title="This dashboard, across every laptop on your team"
      onClose={onClose}
      picture={<TeamPicture />}
      actions={
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <a href={BOOK} target="_blank" rel="noreferrer" onClick={onClose}
            className="rounded-md bg-accent px-3 py-2.5 text-center text-[14px] font-semibold text-panel no-underline hover:bg-accent-strong">
            Book a demo
          </a>
          <a href={TEAMS} target="_blank" rel="noreferrer"
            className="rounded-md border border-border-strong px-3 py-2.5 text-center text-[14px] text-fg no-underline hover:border-accent hover:text-accent">
            See the team page
          </a>
        </div>
      }
      footer={
        <div className="flex items-center gap-3">
          <a href={PRICING} target="_blank" rel="noreferrer" className="whitespace-nowrap text-fg-muted no-underline hover:text-fg">Pricing</a>
          <span className="whitespace-nowrap text-fg-faint">links open a new tab</span>
          <button type="button" onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">Close</button>
        </div>
      }
    >
      {measured && (
        /* The reader's own number, before any claim. */
        <p className="mb-3 rounded-md border border-border bg-panel-2 px-3 py-2 text-[13px] leading-snug text-fg-muted">
          On this machine alone: <span className="num text-fg">{fmtUSD(fact!.costUSD)}</span> across{' '}
          <span className="num text-fg">{fact!.projects}</span> {fact!.projects === 1 ? 'project' : 'projects'}{' '}
          {fact!.window}. Your team has one of these on every laptop.
        </p>
      )}
      <ul className="space-y-2">
        <Benefit icon={Icon.pie}>Which repository and service is eating the budget</Benefit>
        <Benefit icon={Icon.loop}>Loops flagged on every machine, for anyone on the team to see</Benefit>
        <Benefit icon={Icon.stack}>Claude Code, Codex and the rest in one total, split by agent and model</Benefit>
        <Benefit icon={Icon.pr}>What the money bought: pull requests, and cost per PR</Benefit>
      </ul>
      <div className="mt-3 space-y-1 border-t border-border pt-3 text-[12.5px] leading-snug text-fg-muted">
        <p className="flex items-start gap-2">
          <span aria-hidden className="mt-[1px] text-ok">{Icon.shield}</span>
          <span>Runs on your own infrastructure and receives counters only — prompts and code never leave a laptop.</span>
        </p>
        <p className="flex items-start gap-2">
          <span aria-hidden className="mt-[1px] text-accent">{Icon.coin}</span>
          <span>One flat price for the whole team — never per seat, never a share of spend. Every developer keeps the free Caprock.</span>
        </p>
      </div>
    </UpsellDialog>
  )
}
