import { useEffect, useRef, useState } from 'react'
import type { Account, Address, Draft } from './mailApi'
import { api } from './mailApi'
import { bytes, parseAddresses, people, validAddress } from './format'
import { Icon } from './icons'
import { K } from './keymap'

export type ComposeInit = {
  accountId: number
  to: Address[]
  cc: Address[]
  subject: string
  text: string
  inReplyTo: number
  aiFor?: number // message id the AI can draft a reply to
}

type File64 = { filename: string; type: string; data: string; size: number }

function AddressField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [sug, setSug] = useState<Address[]>([])
  const [hi, setHi] = useState(0)
  const last = value.split(/[,;]/).pop()?.trim() ?? ''
  useEffect(() => {
    if (last.length < 2) {
      setSug([])
      return
    }
    let live = true
    const t = setTimeout(() => api.contacts(last).then((s) => live && (setSug(s), setHi(0))).catch(() => {}), 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [last])
  const pick = (a: Address) => {
    const parts = value.split(/[,;]/)
    parts.pop()
    const head = parts.map((p) => p.trim()).filter(Boolean)
    head.push(a.name ? `${a.name} <${a.addr}>` : a.addr)
    onChange(head.join(', ') + ', ')
    setSug([])
  }
  return (
    <label className="cfield">
      <span>{label}</span>
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTimeout(() => setSug([]), 150)}
        onKeyDown={(e) => {
          if (!sug.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % sug.length) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi - 1 + sug.length) % sug.length) }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sug[hi]!) }
          else if (e.key === 'Escape') { e.stopPropagation(); setSug([]) }
        }}
        spellCheck={false}
      />
      {sug.length > 0 && (
        <div className="suggest">
          {sug.map((s, i) => (
            <div key={s.addr} className={i === hi ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(s) }}>
              <b>{s.name || s.addr}</b> {s.name && <span className="muted">{s.addr}</span>}
            </div>
          ))}
        </div>
      )}
    </label>
  )
}

export function Composer({ init, accounts, aiOn, onClose, onSent }: {
  init: ComposeInit
  accounts: Account[]
  aiOn: boolean
  onClose: () => void
  onSent: () => void
}) {
  const [accountId, setAccountId] = useState(init.accountId || accounts[0]?.id || 0)
  const [to, setTo] = useState(people(init.to))
  const [cc, setCc] = useState(people(init.cc))
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(init.cc.length > 0)
  const [subject, setSubject] = useState(init.subject)
  const acct = accounts.find((a) => a.id === accountId)
  const sig = acct?.signature ? `\n\n-- \n${acct.signature}` : ''
  const [text, setText] = useState(init.text.startsWith('\n') ? sig + init.text : init.text + sig)
  const [files, setFiles] = useState<File64[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [instr, setInstr] = useState('')
  const body = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (init.to.length > 0) {
      body.current?.focus()
      body.current?.setSelectionRange(0, 0)
    }
  }, [init])

  const addFiles = async (list: FileList | null) => {
    if (!list) return
    const out: File64[] = []
    for (const f of Array.from(list)) {
      const buf = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      out.push({ filename: f.name, type: f.type || 'application/octet-stream', data: btoa(bin), size: f.size })
    }
    setFiles((fs) => [...fs, ...out])
  }

  const send = async () => {
    const d: Draft = {
      account_id: accountId,
      to: parseAddresses(to),
      cc: parseAddresses(cc),
      bcc: parseAddresses(bcc),
      subject,
      text,
      in_reply_to: init.inReplyTo,
      attachments: files.map(({ filename, type, data }) => ({ filename, type, data })),
    }
    const all = [...d.to, ...d.cc, ...d.bcc]
    if (all.length === 0) return setErr('Add a recipient.')
    const bad = all.find((a) => !validAddress(a.addr))
    if (bad) return setErr(`"${bad.addr}" is not an email address.`)
    setBusy(true)
    setErr('')
    try {
      await api.send(d)
      onSent()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const draftWithAI = async () => {
    if (!init.aiFor) return
    setAiBusy(true)
    setErr('')
    try {
      const r = await api.draft(init.aiFor, instr)
      setText((t) => r.text + t.replace(/^\s*/, '\n\n'))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="composer" role="dialog" aria-label="New message"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
        if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey) && aiOn && init.aiFor) { e.preventDefault(); draftWithAI() }
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      }}>
      <div className="chead">
        <b>{init.inReplyTo ? 'Reply' : subject.startsWith('Fwd:') ? 'Forward' : 'New message'}</b>
        <button className="icon withkey" onClick={onClose} title="Close"><Icon name="close" /> <K k="close" /></button>
      </div>
      {accounts.length > 1 && (
        <label className="cfield">
          <span>From</span>
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
          </select>
        </label>
      )}
      <AddressField label="To" value={to} onChange={setTo} autoFocus={init.to.length === 0} />
      {showCc ? (
        <>
          <AddressField label="Cc" value={cc} onChange={setCc} />
          <AddressField label="Bcc" value={bcc} onChange={setBcc} />
        </>
      ) : (
        <button className="link small ccbtn" onClick={() => setShowCc(true)}>Cc / Bcc</button>
      )}
      <label className="cfield">
        <span>Subject</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      {aiOn && init.aiFor ? (
        <div className="aibar">
          <Icon name="sparkle" />
          <input placeholder="What should the reply say? (optional)" value={instr} onChange={(e) => setInstr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey) { e.preventDefault(); draftWithAI() } }} />
          <button className="btn" disabled={aiBusy} onClick={draftWithAI}>{aiBusy ? 'Writing…' : 'Draft reply'} <K k="draft" /></button>
        </div>
      ) : null}
      <textarea ref={body} className="cbody" value={text} onChange={(e) => setText(e.target.value)}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }} />
      {files.length > 0 && (
        <div className="chips">
          {files.map((f, i) => (
            <span key={i} className="chip">
              <Icon name="clip" size={13} /> {f.filename} <span className="muted">{bytes(f.size)}</span>
              <button className="icon tiny" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="cfoot">
        <button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send'} <K k="send" /></button>
        <label className="icon" title="Attach files">
          <Icon name="clip" />
          <input type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </label>
      </div>
    </div>
  )
}

