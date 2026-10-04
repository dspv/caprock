/**
 * The Week card: what this machine's agents did in seven days, made to be
 * posted. Two layouts at their export sizes — 1200x675 for X and LinkedIn,
 * 1080x1350 for Instagram and Telegram — rendered here at full size and scaled
 * by the screen, so the PNG is exactly what is on screen.
 *
 * Every figure comes from GET /v1/week. A figure the week did not measure is
 * left off rather than shown as zero, and every estimate carries "≈". No
 * repository, path, prompt or session title can appear: the endpoint does not
 * send them.
 */
import { forwardRef, type ReactNode } from 'react'
import type { Week } from '@/lib/api'
import {
  biggestSentence, crew, dayBars, eyebrow, headline, loopSentence, money, rangeLabel,
  sideStats, tally, weekdaySpan, type CrewMember, type Headline, type SideStat, type TallyItem,
} from '@/lib/week'
import { AgentCharacter, CaprockMark } from './Characters'
import './WeekCard.css'

export type CardLayout = 'land' | 'port'

export const CARD_SIZE: Record<CardLayout, { w: number; h: number }> = {
  land: { w: 1200, h: 675 },
  port: { w: 1080, h: 1350 },
}

interface Props {
  week: Week
  layout: CardLayout
  /** "this week" or "that week". */
  when: string
}

export const WeekCard = forwardRef<HTMLElement, Props>(function WeekCard({ week, layout, when }, ref) {
  const h = headline(week, when)
  const items = tally(week, h.led)
  const stats = sideStats(week)
  const members = crew(week)
  const loop = week.loop ? loopSentence(week.loop) : null
  const big = biggestSentence(week)
  const range = rangeLabel(week.start, week.end)
  const label = `${h.lead} ${h.figure} ${h.tail} ${range}.`

  const top = (
    <div className="wk-top">
      <div className="wk-brand"><CaprockMark size={layout === 'land' ? 26 : 28} /><span>cap<b>rock</b></span></div>
      <div className="wk-eyebrow wk-date">{range}</div>
    </div>
  )
  const foot = (
    <div className="wk-foot">
      <span>measured locally with <b>Caprock</b> · <span className="wk-url">caprock.dev</span></span>
      <span>{week.prs_merged > 0 ? 'merged = merges the agents ran · ' : ''}≈ = estimate · API list prices</span>
    </div>
  )

  if (layout === 'land') {
    // Room for three characters beside one callout. The loop is the funnier
    // story; the biggest session stands in when there was no loop.
    const shown = members.slice(0, loop || big ? 3 : 4)
    const callout = loop ? <LoopCallout week={week} short /> : big ? <BiggestCallout week={week} /> : null
    return (
      <section ref={ref} className="wk-card wk-land" role="img" aria-label={label}>
        {top}
        <div className="wk-main">
          <div>
            <div className="wk-eyebrow">{eyebrow(week)}</div>
            <Head h={h} />
            {items.length > 0 && <Tally items={items} />}
          </div>
          {stats.length > 0 && (
            <div className="wk-side">
              {stats.map((s) => <Stat key={s.label} s={s} />)}
            </div>
          )}
        </div>
        {(shown.length > 0 || callout) && (
          <div className={`wk-bottom${shown.length === 0 || !callout ? ' wk-solo' : ''}`}>
            {shown.length > 0 && (
              <div className="wk-crew">
                {shown.map((m) => (
                  <div className="wk-who" key={m.name}>
                    <AgentCharacter who={m.who} size={62} />
                    <div>
                      <div className="wk-name">{m.name}</div>
                      <div className="wk-nums">{nums(m)}</div>
                      <div className="wk-bit">{m.bit}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {callout}
          </div>
        )}
        {foot}
      </section>
    )
  }

  const bars = dayBars(week)
  return (
    <section ref={ref} className="wk-card wk-port" role="img" aria-label={label}>
      {top}
      <div className="wk-eyebrow">{eyebrow(week)}</div>
      <Head h={h} />
      {items.length > 0 && <Tally items={items} />}
      {stats.length > 0 && (
        <div className="wk-grid">
          {stats.map((s) => <Stat key={s.label} s={s} />)}
        </div>
      )}
      {bars.values.some((v) => v > 0) && (
        <div className="wk-bars">
          <div className="wk-cap"><span>{bars.label}</span><span>{weekdaySpan(week)}</span></div>
          <Bars values={bars.values} days={week.days.map((d) => d.day)} format={bars.format} />
        </div>
      )}
      {members.length > 0 && (
        <div className="wk-crew">
          {members.slice(0, 3).map((m) => (
            <div className="wk-who" key={m.name}>
              <AgentCharacter who={m.who} size={72} />
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
          {big && <BiggestCallout week={week} />}
        </div>
      )}
      {foot}
    </section>
  )
})

function nums(m: CrewMember): string {
  return `${new Intl.NumberFormat('en-US').format(m.turns)} turns · ${money(m.cost)}`
}

function Head({ h }: { h: Headline }) {
  return (
    <h1 className="wk-headline">
      {h.lead} <em>{h.figure}</em>{h.tail ? ` ${h.tail}` : ''}
    </h1>
  )
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

function LoopCallout({ week, short }: { week: Week; short?: boolean }) {
  const l = week.loop!
  const s = loopSentence(l)
  const tax = l.tax_usd && l.tax_usd > 0 ? money(l.tax_usd) : null
  return (
    <div className="wk-callout">
      <div className="wk-k">Longest loop</div>
      <div className="wk-t">
        {s.what}{short ? <br /> : ' '}
        <span className="wk-amber">{s.count}</span>
        {tax && <> <span className="wk-dim">·</span> <span className="wk-c">≈{tax}</span>{short ? ' of context' : ' re-reading context'}</>}
      </div>
    </div>
  )
}

function BiggestCallout({ week }: { week: Week }) {
  const b = biggestSentence(week)!
  return (
    <div className="wk-callout">
      <div className="wk-k">Biggest session</div>
      <div className="wk-t">{b.lead} <span className="wk-amber">{b.cost}</span>. {b.share}</div>
    </div>
  )
}

/** Seven columns, the tallest day the brightest. Zero days get a stub.
 *
 * Plain boxes rather than an SVG: the PNG is drawn from a clone with computed
 * styles inlined, and SVG fills given by a theme variable came out black in
 * the file while looking right on screen. */
function Bars({ values, days, format }: { values: number[]; days: string[]; format: (v: number) => string }) {
  const max = Math.max(...values, 1)
  return (
    <div className="wk-barrow" aria-hidden="true">
      {values.map((v, i) => {
        const tone = v <= 0 ? 'wk-bar-zero' : v === max ? 'wk-bar-top' : v >= max / 2 ? 'wk-bar-mid' : 'wk-bar-low'
        const h = v <= 0 ? 3 : Math.max(6, Math.round((v / max) * 96))
        return (
          <div className="wk-barcol" key={days[i] ?? i}>
            <div className="wk-barval">{v > 0 ? format(v) : ''}</div>
            <div className={`wk-bar ${tone}`} style={{ height: h }} />
            <div className="wk-barday">{days[i] ? Number(days[i].slice(8)) : ''}</div>
          </div>
        )
      })}
    </div>
  )
}
