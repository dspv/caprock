/**
 * The Week card: what this machine's agents did, made to be posted. Two
 * layouts at their export sizes — 1200x675 for X and LinkedIn, 1080x1350 for
 * Instagram and Telegram — rendered here at full size and scaled by the
 * screen, so the PNG is exactly what is on screen.
 *
 * One card, two formats (owner, 2026-10-25: the landscape card led with the
 * plan's multiple and the portrait one with PRs, so the format changed the
 * message). Both lead with the same two big figures — the money (the stated
 * flat plan's multiple, else the dollars at API list price) and what it
 * bought (merged PRs) — and the same row under them. Portrait is taller and
 * keeps everything; landscape drops the tally, the agents' one-liners and the
 * callouts, never a headline figure.
 *
 * Every figure comes from GET /v1/week. A figure the week did not measure is
 * left off rather than shown as zero, and every estimate carries "≈". No
 * repository, path, prompt or session title can appear: the endpoint does not
 * send them.
 */
import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import type { Week } from '@/lib/api'
import {
  biggestSentence, crew, dayBars, eyebrow, footNote, headline, heroes, loopSentence, money, rangeLabel,
  sideStats, tally, type CardPlan, type CrewMember, type SideStat, type TallyItem,
} from '@/lib/week'
import { AgentCharacter, CaprockMark } from './Characters'
import type { CardLook } from './ShareCard'
import './WeekCard.css'

export type CardLayout = 'land' | 'port'

export const CARD_SIZE: Record<CardLayout, { w: number; h: number }> = {
  land: { w: 1200, h: 675 },
  port: { w: 1080, h: 1350 },
}

interface Props {
  week: Week
  layout: CardLayout
  /** "this week" or "that week"; "today", "this month", "— all time". */
  when: string
  /** What a share of the cost is "of": "week" unless the card is for another period. */
  noun?: string
  /** The ground it is drawn on; absent, the screen's theme. */
  look?: CardLook
  /** The plan the user stated: a flat one with a price makes the money figure its multiple. */
  plan?: CardPlan
}

export const WeekCard = forwardRef<HTMLElement, Props>(function WeekCard({ week, layout, when, noun = 'week', look, plan }, ref) {
  const h = headline(week, when, noun)
  const [cash, work] = heroes(week, plan)
  // "opened" is in the row under the figures already.
  const items = tally(week, h.led).filter((t) => t.label !== 'opened')
  const stats = sideStats(week, plan)
  const members = crew(week)
  const loop = week.loop ? loopSentence(week.loop) : null
  const big = biggestSentence(week, noun)
  const range = rangeLabel(week.start, week.end)
  const bars = dayBars(week)
  const hasBars = bars.values.length > 1 && bars.values.some((v) => v > 0)
  const whenWords = when.replace(/^— /, '')
  const label = `${cash.figure} ${cash.label}; ${work.approx ? '≈' : ''}${work.figure} ${work.label}, ${whenWords}, ${range}.`

  const top = (
    <div className="wk-top">
      <div className="wk-brand"><CaprockMark size={layout === 'land' ? 26 : 28} /><span>cap<b>rock</b></span></div>
      <div className="wk-eyebrow wk-date">{range}</div>
    </div>
  )
  const heads = (
    <div className="wk-heroes">
      {[cash, work].map((x, i) => (
        <div className="wk-hero" key={i}>
          <div className="wk-fig" style={{ fontSize: heroSize(`${x.approx ? '≈' : ''}${x.figure}`, layout) }}>
            {x.approx && <span className="wk-approx">≈</span>}{x.figure}
          </div>
          <div className="wk-hl">{x.label}</div>
        </div>
      ))}
    </div>
  )
  const statRow = stats.length > 0 && (
    <div className="wk-grid" style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
      {stats.map((s) => <Stat key={s.label} s={s} />)}
    </div>
  )
  const barStrip = hasBars && (
    <div className="wk-bars">
      <div className="wk-cap"><span>{bars.label}</span><span>{bars.span}</span></div>
      <Bars values={bars.values} ticks={bars.ticks} format={bars.format} />
    </div>
  )
  const foot = (
    <div className="wk-foot">
      <span><span className="wk-url">caprock.dev</span> · <b className="wk-ask">What&apos;s yours?</b></span>
      <span>{footNote(week)}</span>
    </div>
  )
  const lead = <div className="wk-eyebrow">{eyebrow(week)} · {whenWords}</div>

  if (layout === 'land') {
    return (
      <section ref={ref} className={`wk-card wk-land${look ? ` wk-look-${look}` : ''}`} role="img" aria-label={label}>
        {top}
        {lead}
        <div className={`wk-main${barStrip ? '' : ' wk-solo'}`}>
          {heads}
          {barStrip}
        </div>
        {statRow}
        {members.length > 0 && (
          <div className="wk-crew">
            {members.slice(0, 3).map((m) => (
              <div className="wk-who" key={m.name}>
                <AgentCharacter who={m.who} size={56} />
                <div className="wk-txt">
                  <div className="wk-name">{m.name}</div>
                  <div className="wk-nums">{nums(m)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {foot}
      </section>
    )
  }

  return (
    <section ref={ref} className={`wk-card wk-port${look ? ` wk-look-${look}` : ''}`} role="img" aria-label={label}>
      {top}
      {lead}
      {heads}
      {items.length > 0 && <Tally items={items} />}
      {statRow}
      {barStrip}
      {members.length > 0 && (
        <div className="wk-crew">
          {members.slice(0, 3).map((m) => (
            <div className="wk-who" key={m.name}>
              <AgentCharacter who={m.who} size={56} />
              <div className="wk-txt">
                <div className="wk-row"><div className="wk-name">{m.name}</div><div className="wk-nums">{nums(m)}</div></div>
                <div className="wk-bit">{m.bitLong}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {(loop || big) && (
        <div className={`wk-callouts${loop && big ? '' : ' wk-solo'}`}>
          {loop && <LoopCallout week={week} />}
          {big && <BiggestCallout week={week} noun={noun} />}
        </div>
      )}
      {foot}
    </section>
  )
})

/** A big figure's size: as large as its half of the card allows, never clipped. */
export function heroSize(figure: string, layout: CardLayout): number {
  const max = layout === 'land' ? 128 : 168
  const column = layout === 'land' ? 300 : 420
  // A digit of the display face at weight 800 is about 0.6 of its size wide;
  // a separator comma about a third of that.
  const width = [...figure].reduce((a, c) => a + (c === ',' || c === '.' ? 0.28 : 0.62), 0)
  return Math.round(Math.min(max, column / Math.max(width, 1)))
}

function nums(m: CrewMember): string {
  return `${new Intl.NumberFormat('en-US').format(m.turns)} turns · ${money(m.cost)}`
}

function Tally({ items }: { items: TallyItem[] }) {
  const out: ReactNode[] = []
  items.forEach((t, i) => {
    if (i > 0) out.push(<i key={`s${i}`}>·</i>)
    out.push(<span key={t.label}><b>{t.approx ? '≈' : ''}{t.value}</b> {t.label}</span>)
  })
  return <div className="wk-tally">{out}</div>
}

function Stat({ s }: { s: SideStat }) {
  return (
    <div className="wk-stat">
      <div className="wk-n">{s.approx && <span className="wk-approx">≈</span>}{s.value}</div>
      <div className="wk-l">{s.label}</div>
    </div>
  )
}

function LoopCallout({ week }: { week: Week }) {
  const l = week.loop!
  const s = loopSentence(l)
  const tax = l.tax_usd && l.tax_usd > 0 ? money(l.tax_usd) : null
  return (
    <div className="wk-callout">
      <div className="wk-k">Longest loop</div>
      <div className="wk-t">
        {s.what}{' '}
        <span className="wk-amber">{s.count}</span>
        {tax && <> <span className="wk-dim">·</span> <span className="wk-c">≈{tax}</span> re-reading context</>}
      </div>
    </div>
  )
}

function BiggestCallout({ week, noun }: { week: Week; noun: string }) {
  const b = biggestSentence(week, noun)!
  return (
    <div className="wk-callout">
      <div className="wk-k">Biggest session</div>
      <div className="wk-t">{b.lead} <span className="wk-amber">{b.cost}</span>. {b.share}</div>
    </div>
  )
}

/** One column per day (or folded week or month), the tallest the brightest.
 * Zero columns get a stub.
 *
 * Plain boxes rather than an SVG: the PNG is drawn from a clone with computed
 * styles inlined, and SVG fills given by a theme variable came out black in
 * the file while looking right on screen. */
function Bars({ values, ticks, format }: { values: number[]; ticks: string[]; format: (v: number) => string }) {
  const max = Math.max(...values, 1)
  return (
    <div className="wk-barrow" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${values.length}, 1fr)` }}>
      {values.map((v, i) => {
        const tone = v <= 0 ? 'wk-bar-zero' : v === max ? 'wk-bar-top' : v >= max / 2 ? 'wk-bar-mid' : 'wk-bar-low'
        const h = v <= 0 ? 3 : Math.max(5, Math.round((v / max) * 72))
        return (
          <div className="wk-barcol" key={`${ticks[i] ?? ''}${i}`}>
            <div className="wk-barval">{v > 0 ? format(v) : ''}</div>
            <div className={`wk-bar ${tone}`} style={{ height: `${h}%` }} />
            <div className="wk-barday">{ticks[i] ?? ''}</div>
          </div>
        )
      })}
    </div>
  )
}
