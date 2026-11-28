/**
 * Talks (ADR-110, .ai/27-talks.md, .ai/04-ui.md § Talks): your agent and a
 * person's agent talk for you two, and either of you can type in.
 *
 * - **Talks** (#/talks): the people linked for them — each with Talk, a
 *   safety code to compare if you want to, and Remove — the Talks, newest
 *   change first, Invite someone (a link to send them) and Accept an
 *   invitation (paste the link they sent). #/talks?with=<id> opens a new
 *   Talk with one person, its goal field focused.
 * - **One Talk** (#/talks/<id>): the chat's frame (screens/Chat) with three
 *   voices — your agent, theirs, and the two of you — the hold card (Send,
 *   Edit, Drop; Continue and End at a cap or a failed turn; Accept for one
 *   they started), a field to type into it, and *What left this machine*:
 *   every message this side sent, exactly as it left.
 *
 * Trusted pairs are the point: a linked person is two actions from a Talk
 * (Talk, then the goal and Enter), a new one five (Invite, they paste and
 * Accept, Talk, goal).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errText, isPairedDevice } from '@/lib/api'
import { caughtText, fmtTalkUSD, howText, inviteKeyOf, looksLikeInvite, needsMe, stateLine, talksApi, voiceOf, type Talk, type TalkEntry, type TalkInvite, type TalkPerson, type TalkView } from '@/lib/talks'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useFillViewport, useNarrowScreen } from '@/lib/phone'
import { useNow } from '@/lib/useNow'
import { live } from '@/lib/live'
import { copyText } from '@/lib/mdreader'
import { fmtAgo } from '@/lib/format'
import { ChatSheet } from '@/components/ChatStart'
import { ChatIcon, ChevronIcon, CopyIcon, ListIcon, MoreIcon, SendIcon } from '@/components/AppIcons'
import { Prose } from '@/components/Prose'
import { Empty } from '@/components/ui'

/** Reads again whenever the daemon says a Talk changed (the `talks` frame), and every few seconds besides. */
function useTalkFrames(refresh: () => void, id?: string) {
  const fn = useRef(refresh)
  fn.current = refresh
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'talks' && (!id || f.data.id === id)) fn.current()
  }), [id])
}

const BTN = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-[14px] font-medium disabled:opacity-60'
const PRIMARY = `${BTN} bg-accent text-bg`
const QUIET = `${BTN} border border-border-strong bg-bg text-fg hover:border-accent`
const DANGER = `${BTN} border border-border-strong bg-bg text-danger`
const FIELD = 'min-h-11 w-full rounded-[10px] border border-border-strong bg-bg px-3 text-[16px] text-fg outline-none placeholder:text-fg-faint focus:border-accent'

// ---------------------------------------------------------------- the list

export function TalksScreen({ with: withId }: { with?: string }) {
  const phone = useNarrowScreen()
  const owner = !isPairedDevice()
  const canControl = useCanControl()
  const now = useNow(15000)
  const people = useApi(() => talksApi.people(), [], { intervalMs: 5000 })
  const list = useApi(() => talksApi.list(), [], { intervalMs: 4000 })
  useTalkFrames(() => { list.refresh() })
  const [starting, setStarting] = useState<string>(withId ?? '')
  useEffect(() => { if (withId) setStarting(withId) }, [withId])
  const talks = list.data ?? []
  const waiting = talks.filter(needsMe)
  const rest = talks.filter((t) => !needsMe(t))
  const folks = people.data ?? []
  const noFeature = (people.error as { status?: number } | undefined)?.status === 501

  if (noFeature) return <Empty title="Talks are not in this build">Update Caprock to talk with someone through your agents.</Empty>
  return (
    <div className="mx-auto grid w-full max-w-[760px] gap-4">
      <div className="grid gap-1">
        <h1 className={`${phone ? 'text-[24px]' : 'text-[20px]'} font-semibold tracking-tight`}>Talks</h1>
        <p className="max-w-[64ch] text-[13.5px] leading-relaxed text-fg-muted">
          Your agent and someone else&rsquo;s talk for you two, and either of you can type in. Each message goes through your never-share list before it leaves; one that names something on it waits for you.
        </p>
      </div>
      {waiting.length > 0 && (
        <section aria-label="Waiting for you" className="grid gap-2">
          <h2 className="text-[13px] font-medium text-accent">Waiting for you <span className="num">· {waiting.length}</span></h2>
          <ul className="overflow-hidden rounded-[12px] border border-accent/60 bg-panel">
            {waiting.map((t) => <TalkRow key={t.id} t={t} now={now} />)}
          </ul>
        </section>
      )}
      <section aria-label="People" className="grid gap-2">
        <h2 className="text-[13px] font-medium text-fg-muted">People {folks.length > 0 && <span className="num text-fg-faint">· {folks.length}</span>}</h2>
        {folks.length === 0 && people.data && (
          <p className="rounded-[12px] border border-border bg-panel px-3 py-3 text-[13.5px] text-fg-muted">
            Nobody yet. Invite someone with a link, or paste the link someone sent you.
          </p>
        )}
        {folks.length > 0 && (
          <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
            {folks.map((p) => (
              <PersonRow key={p.id} p={p} owner={owner} canStart={canControl} open={starting === p.id}
                onTalk={() => setStarting(starting === p.id ? '' : p.id)}
                onRemoved={() => { people.refresh(); list.refresh() }} />
            ))}
          </ul>
        )}
        {owner && <LinkSomeone onLinked={() => people.refresh()} />}
      </section>
      <section aria-label="Every Talk" className="grid gap-2">
        <h2 className="text-[13px] font-medium text-fg-muted">{waiting.length > 0 ? 'Every other Talk' : 'Every Talk'} {rest.length > 0 && <span className="num text-fg-faint">· {rest.length}</span>}</h2>
        {list.error && !list.data && <p role="alert" className="text-[14px] text-danger">{errText(list.error)}</p>}
        {rest.length === 0 && list.data ? (
          <div className="grid justify-items-center gap-2 rounded-[12px] border border-border bg-panel px-4 py-6 text-center">
            <ChatIcon size={20} className="text-fg-faint" />
            <p className="text-[14px] text-fg-muted">{talks.length > 0 ? 'None besides those waiting for you.' : 'No Talks yet.'}</p>
          </div>
        ) : rest.length > 0 && (
          <ul className="overflow-hidden rounded-[12px] border border-border bg-panel">
            {rest.map((t) => <TalkRow key={t.id} t={t} now={now} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function TalkRow({ t, now }: { t: Talk; now: number }) {
  const me = needsMe(t)
  return (
    <li className="border-b border-border last:border-b-0">
      <a href={href({ name: 'talk', id: t.id })} data-talk-row={t.id} className="flex min-h-[56px] items-center gap-3 px-3 py-2 text-fg no-underline hover:bg-panel-2 active:bg-panel-2">
        <span className="grid min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-medium">{t.person_name || 'Someone'}</span>
            <span className="truncate text-[13px] text-fg-muted">{t.goal}</span>
          </span>
          <span className={`truncate text-[12.5px] ${me ? 'text-accent' : 'text-fg-faint'}`}>{stateLine(t)} · {t.sent}/{t.max_messages}</span>
        </span>
        <span className="shrink-0 text-[12px] text-fg-faint">{fmtAgo(t.updated_at, now)}</span>
      </a>
    </li>
  )
}

/** Twelve digits as three groups of four: easier to read out. */
function grouped(code: string): string {
  return code.replace(/(\d{4})(?=\d)/g, '$1 ')
}

function PersonRow({ p, owner, canStart, open, onTalk, onRemoved }: { p: TalkPerson; owner: boolean; canStart: boolean; open: boolean; onTalk: () => void; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const online = p.status === 'online'
  const remove = async () => {
    setBusy(true)
    setError('')
    try { await talksApi.remove(p.id); onRemoved() } catch (e) { setError(errText(e)); setBusy(false) }
  }
  return (
    <li className="border-b border-border last:border-b-0" data-person={p.name}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-fg-faint'}`} />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[15px] font-medium text-fg">{p.name || 'Someone'}</span>
          <span className="flex flex-wrap gap-x-1.5 text-[12px] text-fg-faint" title="The same twelve digits show on their side. Compare them if you want to be sure it is them; it is never a step.">
            <span>{online ? 'online' : p.last_seen ? `seen ${fmtAgo(p.last_seen)}` : 'offline'} ·</span>
            <span className="whitespace-nowrap">safety code <span className="mono num text-fg-muted" data-safety-code>{grouped(p.safety_code)}</span></span>
          </span>
        </span>
        {canStart && <button type="button" className={open ? QUIET : PRIMARY} onClick={onTalk} data-talk-with={p.name}>{open ? 'Cancel' : 'Talk'}</button>}
        {owner && (!confirm ? (
          <button type="button" className="min-h-10 px-2 text-[13px] text-fg-muted hover:text-danger" onClick={() => setConfirm(true)}>Remove</button>
        ) : (
          <button type="button" disabled={busy} className={DANGER} onClick={() => void remove()}>{busy ? 'Removing…' : `Remove ${p.name || 'them'} on both sides`}</button>
        ))}
      </div>
      {open && <StartTalk person={p} />}
      {error && <p role="alert" className="px-3 pb-2 text-[13px] text-danger">{error}</p>}
    </li>
  )
}

/** The goal of a new Talk, and Enter starts it: the second of two actions for a linked person. */
function StartTalk({ person }: { person: TalkPerson }) {
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async () => {
    const g = goal.trim()
    if (!g) return
    setBusy(true)
    setError('')
    try {
      const t = await talksApi.start(person.id, g)
      navigate({ name: 'talk', id: t.id })
    } catch (e) { setError(errText(e)); setBusy(false) }
  }
  return (
    <form className="grid gap-1.5 px-3 pb-3" onSubmit={(e) => { e.preventDefault(); void start() }}>
      <div className="flex gap-2">
        <input autoFocus value={goal} maxLength={500} onChange={(e) => setGoal(e.target.value)} aria-label={`What should your agent and ${person.name}'s work out?`}
          placeholder={`What should your agents work out? e.g. a time for a call next week`} className={FIELD} data-talk-goal />
        <button type="submit" disabled={busy || !goal.trim()} className={`${PRIMARY} shrink-0`}>{busy ? 'Starting…' : 'Start'}</button>
      </div>
      <p className="text-[12px] text-fg-faint">{person.name || 'They'} see{person.name ? 's' : ''} this goal. Your agent opens; at most your cap in messages, then it stops and asks you.</p>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </form>
  )
}

/** Invite someone (a link to send, valid a day) and Accept an invitation (paste the link they sent). */
function LinkSomeone({ onLinked }: { onLinked: () => void }) {
  const [inv, setInv] = useState<TalkInvite | null>(null)
  const [copied, setCopied] = useState(false)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState<'' | 'invite' | 'accept'>('')
  const [error, setError] = useState('')
  const [joined, setJoined] = useState('')
  const state = useApi(() => (inv ? talksApi.inviteState() : Promise.resolve(null)), [inv?.key], { live: false, intervalMs: inv ? 1500 : 60_000 })
  const st = state.data?.state
  useEffect(() => {
    if (st === 'joined' && inv) {
      setJoined(state.data?.joiner || 'They')
      setInv(null)
      onLinked()
    }
  }, [st, inv, state.data?.joiner, onLinked])
  const invite = async () => {
    setBusy('invite')
    setError('')
    setJoined('')
    try {
      const i = await talksApi.invite()
      setInv(i)
      setCopied(await copyText(i.link))
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }
  const accept = async () => {
    setBusy('accept')
    setError('')
    try {
      const p = await talksApi.acceptInvite(inviteKeyOf(pasted))
      setPasted('')
      setJoined(p.name || 'They')
      onLinked()
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }
  const ok = looksLikeInvite(pasted)
  return (
    <div className="grid gap-3 rounded-[12px] border border-border bg-panel px-3 py-3">
      {joined && <p role="status" className="text-[13.5px] text-ok" data-talk-linked>{joined} and you are linked. Talk to start one.</p>}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={inv ? QUIET : PRIMARY} disabled={busy !== ''} onClick={() => void invite()} data-talk-invite>
            {busy === 'invite' ? 'Making a link…' : inv ? 'New link' : 'Invite someone'}
          </button>
          {inv && (
            <button type="button" className={QUIET} onClick={() => void copyText(inv.link).then(setCopied)}>
              <CopyIcon size={14} /> {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {inv && <button type="button" className="min-h-10 px-2 text-[13px] text-fg-muted hover:text-fg" onClick={() => { void talksApi.withdrawInvite(); setInv(null) }}>Withdraw</button>}
        </div>
        {inv ? (
          <>
            <code data-talk-link className="mono block select-all break-all rounded-[8px] bg-bg px-2 py-1.5 text-[12px] text-fg-muted">{inv.link}</code>
            <p className="text-[12px] text-fg-faint">
              {copied ? 'On your clipboard. ' : ''}Send it to the one person you mean, as you would a message. It works once, for a day; {st === 'joining' ? 'they are joining now…' : 'waiting for them to paste it.'}
              {inv.turned_on_remote ? ' Access from anywhere is now on here: that is how their Caprock reaches yours.' : ''}
            </p>
          </>
        ) : (
          <p className="text-[12px] text-fg-faint">A link for one person: once they paste it in their Caprock, your agents can talk. Nothing about your work goes with it.</p>
        )}
      </div>
      <form className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (ok) void accept() }}>
        <div className="flex gap-2">
          <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste a link someone sent you" aria-label="An invitation link" className={FIELD} data-talk-paste />
          <button type="submit" disabled={!ok || busy !== ''} className={`${PRIMARY} shrink-0`} data-talk-accept>{busy === 'accept' ? 'Linking…' : 'Accept'}</button>
        </div>
        {pasted.trim() && !ok && <p className="text-[12px] text-warn">That is not a Talks link: it reads caprock.dev/talk# and a long key.</p>}
      </form>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- one Talk

export function TalkScreen({ id }: { id: string }) {
  const phone = useNarrowScreen()
  const canControl = useCanControl()
  const now = useNow(15000)
  const view = useApi(() => talksApi.get(id), [id], { intervalMs: 2500 })
  useTalkFrames(() => { view.refresh() }, id)
  const [sheet, setSheet] = useState<null | 'log' | 'more'>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fill = useFillViewport<HTMLDivElement>(true, phone ? 0 : 12, false)
  const v = view.data
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await fn(); view.refresh() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  if (view.error && !v) {
    const gone = (view.error as { status?: number }).status === 404
    return <Empty title={gone ? 'Talk not found' : 'Cannot load the Talk'}>{gone ? <a href={href({ name: 'talks' })}>All Talks</a> : view.error.message}</Empty>
  }
  const name = v?.person_name || 'Someone'
  const ended = v?.state === 'ended'
  const canType = !!v && canControl && !ended && v.state !== 'invited'
  return (
    <div className="mx-auto grid w-full max-w-[900px] grid-cols-1">
      <div ref={fill} data-talk={id} data-talk-state={v?.state ?? ''} className={`flex min-h-0 flex-col overflow-hidden bg-panel ${phone ? '' : 'rounded-[12px] border border-border'}`}>
        <header data-chat-header className={`flex min-h-12 shrink-0 items-center gap-1 border-b border-border px-1.5 ${phone ? 'pt-[env(safe-area-inset-top)]' : ''}`}>
          <a href={href({ name: 'talks' })} aria-label="All Talks" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-muted no-underline hover:text-fg">
            <span className="rotate-180"><ChevronIcon size={18} /></span>
          </a>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-[16px] font-semibold leading-tight text-fg">Talk with {name}</h1>
            <span className="block truncate text-[12.5px] text-fg-faint" data-talk-line>{v ? `${v.goal} · ${stateLine(v, v.offline)}` : ' '}</span>
          </div>
          <button type="button" onClick={() => setSheet('log')} aria-label="What left this machine" title="What left this machine" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] text-fg-muted hover:text-fg" data-talk-log-open>
            <ListIcon size={16} /> {phone ? '' : 'What left'}
          </button>
          {v && canControl && !ended && (
            <button type="button" aria-label="More" onClick={() => setSheet('more')} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-muted hover:text-fg">
              <MoreIcon size={18} />
            </button>
          )}
        </header>
        {v && <TalkMeta v={v} />}
        {error && <p role="alert" className="shrink-0 px-3 py-1.5 text-[13px] text-danger">{error}</p>}
        {!v ? <p className="px-3 py-4 text-[14px] text-fg-muted">Reading the Talk…</p> : (
          <Transcript v={v} now={now} phone={phone}>
            <HoldCard v={v} canControl={canControl} busy={busy} act={act} />
          </Transcript>
        )}
        {v && canType && <TalkComposer id={id} name={name} phone={phone} onSent={view.refresh} />}
        {v && !canControl && !ended && (
          <p className="shrink-0 border-t border-border px-3 py-2.5 text-[13px] text-fg-muted">This device can read Caprock. To answer here, allow control in Settings → Use on your phone on your computer.</p>
        )}
      </div>
      {sheet === 'log' && v && <LeftLog v={v} onClose={() => setSheet(null)} />}
      {sheet === 'more' && v && (
        <ChatSheet title={`Talk with ${name}`} onClose={() => setSheet(null)}>
          <div className="grid gap-2">
            <button type="button" data-talk-end disabled={busy} className="min-h-12 w-full rounded-[12px] border border-border-strong bg-bg px-4 text-left text-[16px] font-medium text-danger disabled:opacity-60"
              onClick={() => void act(() => talksApi.end(id)).then(() => setSheet(null))}>
              End this Talk — on both sides
            </button>
            <p className="text-[13px] leading-snug text-fg-muted">Neither agent writes again. The conversation stays here, and with {name}.</p>
          </div>
        </ChatSheet>
      )}
    </div>
  )
}

/** The caps and the spend, one quiet line under the header. */
function TalkMeta({ v }: { v: TalkView }) {
  const theirs = v.their_cost_usd !== undefined ? ` · ${v.person_name || 'theirs'}: ${fmtTalkUSD(v.their_cost_usd)}` : ''
  return (
    <p data-talk-meta className="shrink-0 truncate border-b border-border px-3 py-1 text-[12px] text-fg-faint" title={`Brief: ${v.brief}`}>
      your agent: {v.sent} of {v.max_messages} messages, {fmtTalkUSD(v.cost_usd)} of {fmtTalkUSD(v.max_usd)}{theirs}{v.agent ? ` · ${v.agent}${v.model ? ` ${v.model}` : ''}` : ''}
    </p>
  )
}

const VOICE: Record<ReturnType<typeof voiceOf>['who'], { row: string; bubble: string; label: string }> = {
  // Your agent: your side, on the right, tinted.
  mine: { row: 'items-end', bubble: 'rounded-br-[4px] border border-accent/40 bg-accent/10', label: 'text-accent' },
  // Theirs: on the left, outlined.
  theirs: { row: 'items-start', bubble: 'rounded-bl-[4px] border border-border-strong bg-bg', label: 'text-fg-muted' },
  // The two people: filled, on their own side.
  me: { row: 'items-end', bubble: 'rounded-br-[4px] bg-panel-2', label: 'text-fg' },
  partner: { row: 'items-start', bubble: 'rounded-bl-[4px] bg-panel-2', label: 'text-fg' },
}

function Transcript({ v, now, phone, children }: { v: TalkView; now: number; phone: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const n = v.transcript.length
  const [stuck, setStuck] = useState(true)
  useEffect(() => {
    const el = box.current
    if (el && stuck) el.scrollTop = el.scrollHeight
  }, [n, v.state, stuck])
  const name = v.person_name || 'They'
  const shown = v.transcript.filter((e) => e.kind !== 'state' || e.envelope.state === 'ended')
  return (
    <div ref={box} onScroll={(e) => { const el = e.currentTarget; setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }}
      className="min-h-0 flex-1 overflow-y-auto px-[max(12px,calc((100%-780px)/2))] py-3" data-talk-transcript>
      <p className="py-1 text-center text-[12.5px] text-fg-faint" data-talk-opened>
        {v.started_by === 'me' ? 'You' : name} started this Talk{v.created_at ? ` · ${fmtAgo(v.created_at, now)}` : ''}: <span className="text-fg-muted">{v.goal}</span>
      </p>
      {shown.map((e) => e.kind === 'state'
        ? <p key={`${e.side}-${e.seq}`} className="py-1 text-center text-[12.5px] text-fg-faint">{e.side === 'me' ? 'You' : name} ended the Talk</p>
        : <TalkMessage key={`${e.side}-${e.seq}`} e={e} partner={v.person_name} phone={phone} />)}
      {v.state === 'my_turn' && <p className="py-2 text-[13px] text-fg-faint" data-talk-writing>Your agent is writing…</p>}
      {v.state === 'waiting' && <p className="py-2 text-[13px] text-fg-faint">{v.offline ? `${name}'s Caprock is offline. ${v.waiting === 1 ? 'Your message goes' : `${v.waiting} messages go`} when it is back.` : `Waiting for ${name}'s agent…`}</p>}
      {v.state === 'finished' && <p className="py-2 text-center text-[13px] text-fg-muted" data-talk-finished>Both agents are done.{v.note ? '' : ' Type to carry it on.'}</p>}
      {v.note && v.state !== 'held' && <p className="my-1 rounded-[10px] border border-border bg-bg px-3 py-2 text-[13px] text-fg-muted"><span className="font-medium text-fg">Your agent, to you only:</span> {v.note}</p>}
      {children}
    </div>
  )
}

function TalkMessage({ e, partner, phone }: { e: TalkEntry; partner: string; phone: boolean }) {
  const voice = voiceOf(e, partner)
  const c = VOICE[voice.who]
  return (
    <div className={`flex flex-col py-1.5 ${c.row}`} data-voice={voice.who} data-seq={e.seq}>
      <span className={`mb-0.5 px-1 text-[11.5px] font-medium ${c.label}`}>{voice.label}</span>
      <div className={`max-w-[85%] min-w-0 rounded-[12px] px-3 py-2 text-fg [overflow-wrap:anywhere] ${c.bubble} ${phone ? 'text-[16px] leading-[1.5]' : 'text-[14px] leading-relaxed'} [&_div]:text-fg`}>
        {e.kind === 'human' ? <span className="whitespace-pre-wrap">{e.envelope.body}</span> : <Prose text={e.envelope.body} />}
      </div>
      {e.side === 'me' && e.how && e.how !== 'auto' && e.how !== 'typed' && <span className="mt-0.5 px-1 text-[11px] text-fg-faint">{howText(e.how)}</span>}
    </div>
  )
}

/** What waits on you in a Talk: a held message, a cap, a failed turn, or one they started. */
function HoldCard({ v, canControl, busy, act }: { v: TalkView; canControl: boolean; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null)
  const name = v.person_name || 'They'
  if (v.state === 'invited') {
    return (
      <Card title={`${name}'s agent wants to talk`} kind="invited">
        <p className="text-[13.5px] text-fg-muted">About: <span className="text-fg">{v.goal}</span>. Accept and your agent answers, up to {v.max_messages} messages and {fmtTalkUSD(v.max_usd)}.</p>
        {canControl && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void act(() => talksApi.accept(v.id))} data-talk-accept-talk>Accept</button>
            <button type="button" className={QUIET} disabled={busy} onClick={() => void act(() => talksApi.end(v.id))}>Decline</button>
          </div>
        )}
      </Card>
    )
  }
  if (v.state !== 'held') return null
  if (v.hold === 'cap' || v.hold === 'error') {
    return (
      <Card title={v.hold === 'cap' ? 'Stopped at your cap' : 'Your agent’s turn failed'} kind={v.hold}>
        <p className="text-[13.5px] text-fg-muted">
          {v.hold === 'cap'
            ? `Your agent has sent ${v.sent} of ${v.max_messages} messages and spent ${fmtTalkUSD(v.cost_usd)} of ${fmtTalkUSD(v.max_usd)}. Continue gives it as much again.`
            : (v.last_error || 'The agent did not answer.')}
        </p>
        {canControl && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void act(() => talksApi.carryOn(v.id))} data-hold-continue>{v.hold === 'cap' ? 'Continue' : 'Try again'}</button>
            <button type="button" className={DANGER} disabled={busy} onClick={() => void act(() => talksApi.end(v.id))}>End the Talk</button>
          </div>
        )}
      </Card>
    )
  }
  const asks = v.hold === 'needs_owner'
  const leaving = v.draft_redacted ?? v.draft ?? ''
  return (
    <Card title={asks ? 'Your agent asks you first' : 'Held: it names something on your never-share list'} kind={v.hold || 'redaction'}>
      {asks && v.note && <p className="text-[13.5px] text-fg"><span className="text-fg-muted">To you only:</span> {v.note}</p>}
      {!asks && v.draft_caught && <p className="text-[13px] text-fg-muted">Caught: {caughtText(v.draft_caught)}. Send sends it as below, with that part taken out.</p>}
      {editing === null ? (
        <div className="rounded-[10px] border border-border bg-bg px-3 py-2 text-[14px] text-fg [overflow-wrap:anywhere]" data-held-text>
          <span className="mb-0.5 block text-[11.5px] text-fg-faint">As it would leave</span>
          <span className="whitespace-pre-wrap">{leaving}</span>
        </div>
      ) : (
        <textarea autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} rows={4} aria-label="Your version" className="w-full rounded-[10px] border border-accent bg-bg px-3 py-2 text-[15px] text-fg outline-none" data-held-edit />
      )}
      {canControl && (
        <div className="flex flex-wrap gap-2">
          {editing === null ? (
            <>
              <button type="button" className={PRIMARY} disabled={busy || !leaving} onClick={() => void act(() => talksApi.sendHeld(v.id))} data-hold-send>Send</button>
              <button type="button" className={QUIET} disabled={busy} onClick={() => setEditing(leaving)} data-hold-edit>Edit</button>
              <button type="button" className={QUIET} disabled={busy} onClick={() => void act(() => talksApi.dropHeld(v.id))} data-hold-drop>Drop</button>
            </>
          ) : (
            <>
              <button type="button" className={PRIMARY} disabled={busy || !editing.trim()} onClick={() => void act(() => talksApi.editHeld(v.id, editing)).then(() => setEditing(null))} data-hold-send-edited>Send yours</button>
              <button type="button" className={QUIET} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            </>
          )}
        </div>
      )}
      <p className="text-[12px] text-fg-faint">Drop: nothing leaves, and your agent takes its turn again.</p>
    </Card>
  )
}

function Card({ title, kind, children }: { title: string; kind: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} data-hold={kind} className="my-2 grid gap-2 rounded-[12px] border border-accent/60 bg-panel-2 px-3 py-3">
      <h2 className="text-[14.5px] font-semibold text-fg">{title}</h2>
      {children}
    </div>
  )
}

function TalkComposer({ id, name, phone, onSent }: { id: string; name: string; phone: boolean; onSent: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    const t = text.trim()
    if (!t) return
    setBusy(true)
    setError('')
    try { await talksApi.say(id, t); setText(''); onSent() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <form className="shrink-0 border-t border-border px-2 py-2" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <div className="flex items-end gap-2">
        <textarea value={text} rows={1} onChange={(e) => setText(e.target.value)} placeholder={`Write to ${name} and both agents…`} aria-label="Your message"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
          className={`max-h-40 min-h-11 flex-1 resize-none rounded-[12px] border border-border-strong bg-bg px-3 py-2.5 ${phone ? 'text-[16px]' : 'text-[14px]'} text-fg outline-none placeholder:text-fg-faint focus:border-accent`} data-talk-say />
        <button type="submit" aria-label="Send" disabled={busy || !text.trim()} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-bg disabled:opacity-50"><SendIcon size={16} /></button>
      </div>
      {error && <p role="alert" className="px-1 pt-1 text-[13px] text-danger">{error}</p>}
      <p className="px-1 pt-1 text-[11.5px] text-fg-faint">Goes through your never-share list too; one that names something on it is not sent.</p>
    </form>
  )
}

/** What left this machine: every message this side sent, exactly as it left, and how. */
function LeftLog({ v, onClose }: { v: TalkView; onClose: () => void }) {
  const mine = v.transcript.filter((e) => e.side === 'me')
  const name = v.person_name || 'them'
  return (
    <ChatSheet title="What left this machine" onClose={onClose} wide>
      <div className="grid gap-3" data-talk-log>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          Everything this Talk sent to {name}, word for word, through access from anywhere&rsquo;s end-to-end channel. Nothing else goes: no files, no folders, no tools — your agent answers from the conversation, the goal, your brief and what 2nd Brain keeps.
        </p>
        {mine.length === 0 && <p className="text-[13.5px] text-fg-faint">Nothing yet.</p>}
        <ol className="grid gap-2">
          {mine.map((e) => (
            <li key={e.seq} className="grid gap-1 rounded-[10px] border border-border bg-bg px-3 py-2" data-left={e.seq}>
              <span className="flex flex-wrap gap-x-2 text-[11.5px] text-fg-faint">
                <span className="num">#{e.seq}</span>
                <span>{new Date(e.at).toLocaleString()}</span>
                <span>{e.kind === 'state' ? 'the Talk’s state' : howText(e.how)}</span>
                {e.caught && <span className="text-warn">caught: {caughtText(e.caught)}</span>}
                {e.cost_usd ? <span>{fmtTalkUSD(e.cost_usd)}</span> : null}
                <span>{e.delivered_at ? `taken by ${name}` : 'waiting to go'}</span>
              </span>
              <span className="whitespace-pre-wrap text-[13.5px] text-fg [overflow-wrap:anywhere]">{e.kind === 'state' ? (e.envelope.state === 'ended' ? 'Ended' : `Opened: ${e.envelope.body || v.goal}`) : e.envelope.body}</span>
            </li>
          ))}
        </ol>
      </div>
    </ChatSheet>
  )
}
