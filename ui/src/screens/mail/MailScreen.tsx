import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Folder, Message, Settings, State } from './mailApi'
import { api } from './mailApi'
import type { ComposeInit } from './Composer'
import { Composer } from './Composer'
import { Reader } from './Reader'
import { SettingsPanel } from './Setup'
import { FirstRun, SampleBanner, type AddChoice, type ProviderId, type Step } from './Onboarding'
import { hue, initials, quote, replySubject, sender, shortDate } from './format'
import { Icon } from './icons'
import './mail.css'
import { markAnswered } from '@/lib/prompts'
import { GO, K, KeySheet, type MailKey } from './keymap'
import { ThemeButton, ThemePick } from './ThemePick'

export type Sel = { view: string; account?: number; folder?: number }

// A list row is a conversation: the newest message of a thread in this view.
export type Row = { m: Message; ids: number[]; count: number; unread: boolean; flagged: boolean; attach: boolean }

export function groupThreads(ms: Message[]): Row[] {
  const rows: Row[] = []
  const byKey = new Map<string, Row>()
  for (const m of ms) {
    const key = m.account_id + ':' + (m.thread_key || 'id:' + m.id)
    const r = byKey.get(key)
    if (r) {
      r.ids.push(m.id)
      r.count++
      r.unread ||= !m.seen
      r.flagged ||= m.flagged
      r.attach ||= m.has_attach
      continue
    }
    const row = { m, ids: [m.id], count: 1, unread: !m.seen, flagged: m.flagged, attach: m.has_attach }
    byKey.set(key, row)
    rows.push(row)
  }
  return rows
}

const VIEWS: { view: string; label: string; icon: string; k: MailKey }[] = [
  { view: 'inbox', label: 'Inbox', icon: 'inbox', k: 'inbox' },
  { view: 'unread', label: 'Unread', icon: 'unread', k: 'unreadView' },
  { view: 'flagged', label: 'Starred', icon: 'star', k: 'starred' },
  { view: 'sent', label: 'Sent', icon: 'send', k: 'sent' },
  { view: 'drafts', label: 'Drafts', icon: 'draft', k: 'drafts' },
  { view: 'archive', label: 'Archive', icon: 'archive', k: 'archiveView' },
  { view: 'junk', label: 'Spam', icon: 'spam', k: 'spamView' },
  { view: 'trash', label: 'Trash', icon: 'trash', k: 'trashView' },
]

const ACCOUNT_COLORS = ['#2f6fdf', '#e0702a', '#1e9e6a', '#b5479b', '#c9a227', '#5b5bd6']
export const acctColor = (accounts: Account[], id: number) => ACCOUNT_COLORS[Math.max(0, accounts.findIndex((a) => a.id === id)) % ACCOUNT_COLORS.length]

const MOVES = new Set(['archive', 'trash', 'spam', 'inbox', 'move'])

function folderLabel(f: Folder) {
  const parts = f.name.split(f.delim || '/')
  return parts[parts.length - 1] || f.name
}

/**
 * Left the sample in this window (*Exit sample*, *Add account*): Mail then
 * opens on the first run, not on the sample again, until the page reloads.
 */
let sampleLeft = false
/** For tests: forget that the sample was left. */
export function resetSampleLeft() { sampleLeft = false }

/**
 * Caprock Mail: every inbox the user added, in one place (#/mail, and the
 * app's Mail tab). With no account it opens straight on the sample inbox
 * (owner, 2026-10-14, translated: "button → something opens at once"), with a
 * line on top that says so and leads to adding an account. `fill`: the
 * screen is its own tab and fills it, edge to edge.
 */
export function MailScreen({ fill = false }: { fill?: boolean } = {}) {
  const [st, setSt] = useState<State | null>(null)
  const [settings, setSettings] = useState<Settings>({})
  const [sel, setSel] = useState<Sel>({ view: 'inbox' })
  const [q, setQ] = useState('')
  const [msgs, setMsgs] = useState<Message[]>([])
  const [more, setMore] = useState(true)
  const [cur, setCur] = useState<number | null>(null) // selected row's newest message id
  const [compose, setCompose] = useState<ComposeInit | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [toast, setToast] = useState('')
  const [syncing, setSyncing] = useState(false)
  // Where the first-run card opens: its choices, or straight at the provider
  // tiles when the sample banner's "Add my account" brought the user here.
  const [firstStep, setFirstStep] = useState<{ step: Step; provider?: ProviderId }>({ step: 'choose' })
  // Import everything stays on screen while it walks its sign-ins, though
  // the first account it connects would otherwise swap in the inbox.
  const [importing, setImporting] = useState(false)
  // The `?` sheet, and the keys that act inside the reader (v opens Move,
  // i summarises): the time of the press, which the reader watches.
  const [help, setHelp] = useState(false)
  const [themes, setThemes] = useState(false)
  const [moveKick, setMoveKick] = useState(0)
  const [sumKick, setSumKick] = useState(0)
  // The sample is being started because no account exists: say so, not a form.
  const [starting, setStarting] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(false)
  // The screen fills the window below Caprock's header, whatever its height.
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(600)
  useEffect(() => {
    if (fill) return
    const fit = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 60
      setHeight(Math.max(420, window.innerHeight - top - 12))
    }
    fit()
    window.addEventListener('resize', fit)
    const t = setTimeout(fit, 50)
    return () => { window.removeEventListener('resize', fit); clearTimeout(t) }
  })

  const flash = (s: string) => {
    setToast(s)
    setTimeout(() => setToast((t) => (t === s ? '' : t)), 2600)
  }

  const loadState = useCallback(() => api.state().then(setSt).catch(() => {}), [])
  /** The first state: with no account, the sample starts at once. */
  const firstState = useCallback(async () => {
    let s: State
    try { s = await api.state() } catch { return }
    if ((s.accounts ?? []).length === 0 && !s.sample && !sampleLeft) {
      setStarting(true)
      try {
        await api.sample(true)
        s = await api.state()
      } catch { /* an older daemon, or the sample refused: the first run */ }
      setStarting(false)
    }
    setSt(s)
    listRef2.current(false).catch(() => {})
  }, [])

  const query = useMemo(() => ({
    view: q ? (sel.view === 'folder' ? 'folder' : 'all') : sel.view,
    account: sel.account,
    folder: sel.folder,
    q,
  }), [sel, q])

  const loadList = useCallback(async (append = false) => {
    const last = append ? msgs[msgs.length - 1] : undefined
    const page = await api.list({ ...query, limit: 150, before: last?.date, before_id: last?.id })
    setMore(page.length === 150)
    setMsgs((old) => (append ? [...old, ...page] : page))
  }, [query, msgs])

  // Refetch the first page when the view changes; keep it fresh on events.
  const listRef2 = useRef(loadList)
  listRef2.current = loadList
  useEffect(() => {
    const t = setTimeout(() => listRef2.current(false).catch((e) => flash(e.message)), q ? 120 : 0)
    return () => clearTimeout(t)
  }, [query, q])

  // While the screen is open, a cheap poll of the change counter; the list is
  // fetched again only when something changed. Hidden tab: no polling.
  const version = useRef(-1)
  useEffect(() => {
    // Having opened Mail answers the offer on Now for good.
    markAnswered('mail-done', Date.now())
    void firstState()
    api.settings().then(setSettings).catch(() => {})
  }, [firstState])
  // Every 4 s; every 400 ms while the inbox is still filling (the sample's
  // first sync, an account just added), so the mail shows as it lands.
  const ready = !!st
  const filling = !!st && (st.accounts ?? []).length > 0 && msgs.length === 0 && !q && sel.view === 'inbox'
  useEffect(() => {
    if (!ready) return
    const tick = () => {
      if (document.hidden) return
      api.state().then((s) => {
        setSt(s)
        if (version.current !== -1 && s.version !== version.current) listRef2.current(false).catch(() => {})
        version.current = s.version
      }).catch(() => {})
    }
    let n = 0
    const t = setInterval(() => {
      // A filling inbox asks for its list too: the version moves while the
      // first sync runs, and an empty first answer must not stick.
      if (filling && n++ < 40) listRef2.current(false).catch(() => {})
      tick()
    }, filling ? 400 : 4000)
    return () => clearInterval(t)
  }, [ready, filling])

  const rows = useMemo(() => groupThreads(msgs), [msgs])
  const curRow = rows.find((r) => r.m.id === cur) ?? null
  const accounts = st?.accounts ?? []
  const aiOn = settings.ai_enabled === '1'

  const select = (r: Row | null) => {
    setCur(r?.m.id ?? null)
    if (r && r.unread) {
      const ids = msgs.filter((m) => r.ids.includes(m.id) && !m.seen).map((m) => m.id)
      setMsgs((ms) => ms.map((m) => (ids.includes(m.id) ? { ...m, seen: true } : m)))
      api.action(ids, 'read').then(loadState).catch(() => {})
    }
  }

  const act = async (action: string, row = curRow, folder = 0) => {
    if (!row) return
    const ids = row.ids
    if (MOVES.has(action)) {
      const i = rows.indexOf(row)
      const next = rows[i + 1] ?? rows[i - 1] ?? null
      setMsgs((ms) => ms.filter((m) => !ids.includes(m.id)))
      setCur(next ? next.m.id : null)
    } else {
      const patch: Partial<Message> =
        action === 'read' ? { seen: true } : action === 'unread' ? { seen: false } :
        action === 'flag' ? { flagged: true } : action === 'unflag' ? { flagged: false } : {}
      setMsgs((ms) => ms.map((m) => (ids.includes(m.id) ? { ...m, ...patch } : m)))
    }
    try {
      await api.action(ids, action, folder)
      if (action === 'archive') flash('Archived')
      if (action === 'trash') flash(sel.view === 'trash' ? 'Deleted for good' : 'Moved to Trash')
      if (action === 'spam') flash('Marked as spam')
    } catch (e) {
      flash('Failed: ' + (e as Error).message)
      listRef2.current(false)
    }
    loadState()
  }

  const startReply = (m: Message, all: boolean) => {
    const acct = accounts.find((a) => a.id === m.account_id)
    const me = acct?.email.toLowerCase()
    const to = [{ name: m.from_name, addr: m.reply_to || m.from_addr }]
    const cc = all ? [...(m.to ?? []), ...(m.cc ?? [])].filter((a) => a.addr.toLowerCase() !== me && a.addr !== to[0]!.addr) : []
    setCompose({ accountId: m.account_id, to, cc, subject: replySubject(m.subject, 'Re'), text: quote(m), inReplyTo: m.id, aiFor: m.id })
  }
  const startForward = (m: Message) => {
    const head = `\n\n---------- Forwarded message ----------\nFrom: ${sender(m)} <${m.from_addr}>\nSubject: ${m.subject}\n\n`
    setCompose({ accountId: m.account_id, to: [], cc: [], subject: replySubject(m.subject, 'Fwd'), text: head + (m.body_text ?? ''), inReplyTo: 0 })
  }
  const startCompose = () => setCompose({ accountId: sel.account ?? accounts[0]?.id ?? 0, to: [], cc: [], subject: '', text: '', inReplyTo: 0 })

  // Keyboard: single keys like Gmail, ignored while typing.
  const threadRef = useRef<Message[]>([])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]') || compose || showSettings) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (themes) return // ThemePick holds the keys while open
      if (help) {
        if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); setHelp(false) }
        return
      }
      const i = curRow ? rows.indexOf(curRow) : -1
      const k = e.key
      if (gPending.current) {
        gPending.current = false
        if (k === 'r') { e.preventDefault(); checkMail(); return }
        if (GO[k]) { e.preventDefault(); setSel({ view: GO[k]! }); setQ(''); setCur(null) }
        return
      }
      const last = threadRef.current[threadRef.current.length - 1] ?? curRow?.m
      switch (k) {
        case 'j': case 'ArrowDown': select(rows[Math.min(i + 1, rows.length - 1)] ?? null); break
        case 'k': case 'ArrowUp': select(rows[Math.max(i - 1, 0)] ?? null); break
        case 'e': act('archive'); break
        case '#': case 'Delete': case 'Backspace': act('trash'); break
        case '!': act('spam'); break
        case 's': curRow && act(curRow.flagged ? 'unflag' : 'flag'); break
        case 'u': curRow && act(curRow.unread ? 'read' : 'unread'); break
        case 'r': last && startReply(last, false); break
        case 'a': last && startReply(last, true); break
        case 'f': last && startForward(last); break
        case 'c': startCompose(); break
        case '/': searchRef.current?.focus(); break
        case 'v': curRow && setMoveKick(Date.now()); break
        case 'i': curRow && setSumKick(Date.now()); break
        case ',': setShowSettings(true); break
        case '?': setHelp(true); break
        case 't': setThemes(true); break
        case 'g': gPending.current = true; setTimeout(() => (gPending.current = false), 1200); break
        case 'Escape': setCur(null); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Keep the selected row in view.
  useEffect(() => {
    listRef.current?.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  const reload = () => { loadState(); listRef2.current(false).catch(() => {}) }
  const checkMail = () => { setSyncing(true); api.sync().finally(() => setTimeout(() => setSyncing(false), 1200)) }
  const sample = async (on: boolean, then: { step: Step; provider?: ProviderId } = { step: 'choose' }) => {
    if (!on) sampleLeft = true
    await api.sample(on)
    setFirstStep(then)
    setCur(null)
    setSel({ view: 'inbox' })
    setQ('')
    reload()
  }

  const box = 'cm' + (fill ? ' fill' : '')
  const boxStyle = fill ? undefined : { height }
  if (!st || starting) {
    return (
      <div className={box} ref={rootRef} style={boxStyle}>
        <div className="boot"><span><span className="pulse" /> {starting ? 'Opening a sample inbox…' : 'Loading mail…'}</span></div>
      </div>
    )
  }
  if (((st.accounts ?? []).length === 0 && !st.sample) || importing) {
    return (
      <div className={box} ref={rootRef} style={boxStyle}>
        <div className="welcome"><FirstRun key={firstStep.step + (firstStep.provider ?? '')} initial={firstStep.step} provider={firstStep.provider} onDone={reload} onSample={() => sample(true)} onBusy={setImporting} /></div>
      </div>
    )
  }
  /** The banner's *Add account*: leave the sample, open that way in. */
  const addFrom = (c: AddChoice) => sample(false, c === 'import' ? { step: 'import' } : c === 'other' ? { step: 'add' } : { step: 'add', provider: c })

  const foldersBy = (a: Account) => st.folders.filter((f) => f.account_id === a.id && !['noselect', 'all', 'flagged', 'important'].includes(f.role))
  const roleFolder = (a: Account, role: string) => st.folders.find((f) => f.account_id === a.id && f.role === role)
  const title = q ? `Search: ${q}` : sel.view === 'folder'
    ? folderLabel(st.folders.find((f) => f.id === sel.folder) ?? ({ name: '', delim: '/' } as Folder))
    : (VIEWS.find((v) => v.view === sel.view)?.label ?? '') + (sel.account ? ' — ' + (accounts.find((a) => a.id === sel.account)?.email ?? '') : '')
  const errAcct = accounts.find((a) => a.last_error)

  return (
    <div className={box + (st.sample ? ' withbar' : '')} ref={rootRef} style={boxStyle}>
    {st.sample && <SampleBanner onExit={() => sample(false).catch((e) => flash(e.message))} onAdd={(c) => addFrom(c).catch((e) => flash(e.message))} />}
    <div className="app">
      <aside className="side">
        <div className="sidetop">
          <button className="btn primary compose" onClick={startCompose}><Icon name="compose" /> Compose <K k="compose" /></button>
        </div>
        <nav>
          {VIEWS.map((v) => {
            const n = v.view === 'inbox' ? st.counts.unread : v.view === 'flagged' ? st.counts.flagged : 0
            return (
              <button key={v.view} className={'nav' + (!q && sel.view === v.view && !sel.account ? ' on' : '')}
                onClick={() => { setSel({ view: v.view }); setQ(''); setCur(null) }}>
                <Icon name={v.icon} /> <span>{v.label}</span> {n > 0 && <em>{n}</em>} <K k={v.k} />
              </button>
            )
          })}
          {accounts.map((a) => (
            <div key={a.id} className="acct">
              <div className="accthead" title={a.last_error || a.email}>
                <span className="dot" style={{ background: acctColor(accounts, a.id) }} />
                {a.email}
                {a.last_error && <span className="err" title={a.last_error}> !</span>}
              </div>
              <button className={'nav sub' + (!q && sel.view === 'inbox' && sel.account === a.id ? ' on' : '')}
                onClick={() => { setSel({ view: 'inbox', account: a.id }); setQ(''); setCur(null) }}>
                <Icon name="inbox" /> <span>Inbox</span> {(roleFolder(a, 'inbox')?.unread ?? 0) > 0 && <em>{roleFolder(a, 'inbox')!.unread}</em>}
              </button>
              {foldersBy(a).filter((f) => f.role === '').map((f) => (
                <button key={f.id} className={'nav sub' + (!q && sel.view === 'folder' && sel.folder === f.id ? ' on' : '')}
                  onClick={() => { setSel({ view: 'folder', folder: f.id, account: a.id }); setQ(''); setCur(null) }}>
                  <Icon name="folder" /> <span>{folderLabel(f)}</span> {f.unread > 0 && <em>{f.unread}</em>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidefoot">
          <button className="icon withkey" title="Check mail" onClick={checkMail}>
            <Icon name="sync" className={syncing ? 'spin' : ''} /> <K k="sync" />
          </button>
          <button className="icon withkey" title="Settings" onClick={() => setShowSettings(true)}><Icon name="gear" /> <K k="settings" /></button>
          <ThemeButton onOpen={() => setThemes(true)} />
          <span className="grow" />
          <button className="link small keyshelp" onClick={() => setHelp(true)}>Shortcuts <K k="help" /></button>
        </div>
      </aside>

      <section className="list">
        <div className="listhead">
          <div className="searchbox">
            <Icon name="search" />
            <input ref={searchRef} placeholder="Search all mail" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() }
                if (e.key === 'Enter' || e.key === 'ArrowDown') { (e.target as HTMLInputElement).blur(); select(rows[0] ?? null) }
              }} />
            {!q && <K k="search" />}
          </div>
          <div className="listtitle">{title}</div>
        </div>
        {errAcct && <div className="banner warn">{errAcct.email}: {errAcct.last_error}</div>}
        <div className="rows" ref={listRef} onScroll={(e) => {
          const el = e.currentTarget
          if (more && el.scrollTop + el.clientHeight > el.scrollHeight - 400) {
            setMore(false)
            loadList(true).catch(() => {})
          }
        }}>
          {rows.length === 0 && <div className="empty">{q ? 'Nothing found.' : 'No messages.'}</div>}
          {rows.map((r) => {
            const m = r.m
            const name = sel.view === 'sent' ? 'To: ' + (m.to?.[0]?.name || m.to?.[0]?.addr || '') : sender(m)
            return (
              <div key={m.id} className={'row' + (r.unread ? ' unread' : '') + (cur === m.id ? ' on' : '')} onClick={() => select(r)}>
                <div className="avatar" style={{ background: `hsl(${hue(m.from_addr)} 45% 55%)` }}>{initials(m.from_name || m.from_addr)}</div>
                <div className="rowmain">
                  <div className="rowtop">
                    <span className="from">{name}</span>
                    {r.count > 1 && <span className="count">{r.count}</span>}
                    <span className="grow" />
                    {r.attach && <Icon name="clip" size={13} className="muted" />}
                    {r.flagged && <Icon name="star" size={13} className="star" />}
                    <span className="date">{shortDate(m.date)}</span>
                  </div>
                  <div className="subject">{m.subject || '(no subject)'}</div>
                  <div className="snippet">{m.snippet}</div>
                </div>
                {accounts.length > 1 && <span className="acctbar" style={{ background: acctColor(accounts, m.account_id) }} />}
                <div className="hoveracts" onClick={(e) => e.stopPropagation()}>
                  <button className="icon" title="Archive (e)" onClick={() => act('archive', r)}><Icon name="archive" size={15} /></button>
                  <button className="icon" title="Delete (#)" onClick={() => act('trash', r)}><Icon name="trash" size={15} /></button>
                  <button className="icon" title={r.unread ? 'Mark read' : 'Mark unread (u)'} onClick={() => act(r.unread ? 'read' : 'unread', r)}><Icon name="unread" size={15} /></button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <main className="reader">
        {curRow ? (
          <Reader key={curRow.m.id} row={curRow} view={sel.view} aiOn={aiOn} settings={settings}
            moveKick={moveKick} sumKick={sumKick} onSettings={setSettings}
            folders={st.folders.filter((f) => f.account_id === curRow.m.account_id && f.role !== 'noselect')}
            onThread={(t) => (threadRef.current = t)}
            onAct={(a, folder) => act(a, curRow, folder)}
            onReply={startReply} onForward={startForward}
            onMailto={(addr) => setCompose({ accountId: curRow.m.account_id, to: [{ name: '', addr }], cc: [], subject: '', text: '', inReplyTo: 0 })} />
        ) : (
          <div className="nothing">
            <Icon name="mail" size={40} />
            <div>{rows.length} conversation{rows.length === 1 ? '' : 's'}</div>
            <div className="muted small keyline"><K k="down" /> <K k="up" /> move · <K k="compose" /> compose · <K k="search" /> search · <K k="help" /> every shortcut</div>
          </div>
        )}
      </main>

      {compose && (
        <Composer init={compose} accounts={accounts} aiOn={aiOn} onClose={() => setCompose(null)}
          onSent={() => { setCompose(null); flash('Sent') }} />
      )}
      {showSettings && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setShowSettings(false)}>
          <SettingsPanel accounts={accounts} settings={settings} onSettings={setSettings}
            onClose={() => setShowSettings(false)} onChanged={() => { loadState(); listRef2.current(false) }}
            onAddAccount={st.sample ? () => { setShowSettings(false); sample(false, { step: 'add' }).catch((e) => flash(e.message)) } : undefined} />
        </div>
      )}
      {help && <KeySheet onClose={() => setHelp(false)} />}
      {themes && <ThemePick onClose={() => setThemes(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
    </div>
  )
}
