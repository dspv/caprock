/**
 * One look for every credential Caprock keeps: the DeepSeek key, the Telegram
 * bot token, a pasted GitHub token. The owner, 2026-10-13 (translated): the
 * input must look like one for a protected key, not an ordinary field, so it
 * is obvious it goes to secure storage, with an (i) that explains it.
 *
 * Three states. **Empty**: a field with a lock inside, a green "secure"
 * frame, masked monospace text. **Typing**: the same, with an eye that shows
 * what was typed — only while typing; nothing saved can be shown again.
 * **Saved**: no text field at all, a locked pill with the hint ("sk-…1a2b")
 * and where it is kept, with Replace and Remove.
 *
 * The (i) opens a short dialog: where the secret is kept on this computer,
 * what it is sent to and when, that Caprock never shows or logs it, how
 * backups treat it, how to remove it here and revoke it at the provider.
 * The daemon decides where it is kept (internal/secret, ADR-024 amendment);
 * this only says so.
 */
import { useState, type ReactNode } from 'react'
import type { SecretWhere } from '@/lib/api'
import { isMacPlatform } from '@/lib/appmode'
import { CloseButton, DialogBackdrop } from './Dialog'

/** Who the secret is for: the dialog's "sent to" and "revoke it" lines. */
export interface SecretProvider {
  /** "DeepSeek", "Telegram", "GitHub". */
  name: string
  /** The only host it is sent to, e.g. "api.deepseek.com". */
  host: string
  /** When it is sent, in a short sentence. */
  sentWhen: string
  /** Where the provider lists and revokes keys, shown as text. */
  revokeAt: string
  /** How to revoke there, one short sentence. */
  revokeHow: string
}

/** "Stored in your macOS login keychain" and the like: one line, plain. */
export function whereText(where: SecretWhere | undefined, mac = isMacPlatform()): string {
  if (where?.kind === 'keychain') return 'Stored in your macOS login keychain'
  if (where?.kind === 'file') return `Stored in a file only your user can read: ${where.path ?? 'the data directory'}`
  if (where?.kind === 'config') return 'Still in config.json; Caprock moves it to secure storage on its next start'
  return mac ? 'Will be stored in your macOS login keychain' : 'Will be stored in a file only your user can read, in the data directory'
}

/** The short form for the saved pill. */
function whereShort(where: SecretWhere | undefined): string {
  if (where?.kind === 'keychain') return 'in macOS Keychain'
  if (where?.kind === 'file') return 'in a private file'
  if (where?.kind === 'config') return 'in config.json'
  return 'stored'
}

function LockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  )
}

/**
 * The secure input on its own: lock inside, green frame, masked monospace,
 * an eye while there is text. GitHub's paste field uses it directly.
 */
export function SecretInput({ value, onChange, onEnter, label, placeholder, size = 'sm', autoFocus }: {
  value: string
  onChange: (v: string) => void
  onEnter?: () => void
  label: string
  placeholder?: string
  size?: 'sm' | 'lg'
  autoFocus?: boolean
}) {
  const [shown, setShown] = useState(false)
  const typing = value.length > 0
  const h = size === 'lg' ? 'h-11 text-[14px]' : 'h-[30px] text-[12.5px]'
  return (
    <span
      data-secret-input=""
      className={`relative flex min-w-[12rem] flex-1 items-center rounded-[7px] border border-ok/45 bg-[color-mix(in_srgb,var(--color-ok)_6%,var(--color-panel-2))] focus-within:border-ok focus-within:outline focus-within:outline-1 focus-within:outline-ok/60 ${h}`}
    >
      <LockIcon className="pointer-events-none absolute left-2.5 text-ok" />
      <input
        className="mono h-full w-full min-w-0 bg-transparent pl-8 pr-8 text-fg placeholder:text-fg-faint focus:outline-none"
        type={typing && shown ? 'text' : 'password'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
          if (!e.target.value) setShown(false)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && onEnter) { e.preventDefault(); onEnter() } }}
      />
      {typing && (
        <button
          type="button"
          aria-label={shown ? 'Hide what you typed' : 'Show what you typed'}
          aria-pressed={shown}
          title={shown ? 'Hide' : 'Show what you typed'}
          onClick={() => setShown((v) => !v)}
          className="absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:text-fg"
        >
          <EyeIcon open={!shown} />
        </button>
      )}
    </span>
  )
}

/** A saved secret: a locked pill with its hint and where it is kept; no text to edit. */
export function SecretPill({ hint, where }: { hint?: string; where?: SecretWhere }) {
  return (
    <span
      data-secret-saved=""
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ok/45 bg-ok/[0.08] px-2.5 py-1 text-[12.5px]"
      title={whereText(where)}
    >
      <LockIcon className="shrink-0 text-ok" />
      <span className="mono text-fg">{hint || '••••'}</span>
      <span className="truncate text-fg-muted">· {whereShort(where)}</span>
    </span>
  )
}

/** The one line under a secret: where it is kept, where it goes, Remove. */
export function SecretNote({ where, host, removeLabel }: { where?: SecretWhere; host: string; removeLabel?: string }) {
  const from = where?.kind === 'file' ? 'the file' : where?.kind === 'config' ? 'config.json' : 'the keychain'
  return (
    <p className="text-[12px] leading-snug text-fg-muted" data-keep>
      {whereText(where)}. Sent only to <span className="mono">{host}</span>; Caprock shows only the hint and never logs it.
      {removeLabel ? ` ${removeLabel} deletes it from ${from}.` : ''}
    </p>
  )
}

/** The (i) button and the dialog it opens. */
export function SecretInfo({ what, provider, where }: { what: string; provider: SecretProvider; where?: SecretWhere }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`How the ${what} is kept`}
        title={`How the ${what} is kept`}
        onClick={() => setOpen(true)}
        className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[var(--app-hairline-strong)] text-[11px] font-semibold italic text-fg-muted hover:border-accent hover:text-accent"
      >
        i
      </button>
      {open && <SecretInfoDialog what={what} provider={provider} where={where} onClose={() => setOpen(false)} />}
    </>
  )
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-fg-faint">{title}</dt>
      <dd className="text-[13px] leading-snug text-fg">{children}</dd>
    </div>
  )
}

export function SecretInfoDialog({ what, provider, where, onClose }: { what: string; provider: SecretProvider; where?: SecretWhere; onClose: () => void }) {
  const mac = isMacPlatform()
  const inKeychain = where ? where.kind === 'keychain' : mac
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-4 pt-[12vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`How your ${what} is kept`}
        className="w-full max-w-[460px] rounded-[var(--radius-panel)] border border-border-strong bg-panel shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 pb-2 pt-3">
          <LockIcon className="text-ok" />
          <span className="text-[14px] font-medium text-fg">How your {what} is kept</span>
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
        </div>
        <dl className="grid gap-3 px-4 py-3">
          <Row title="Where">
            {whereText(where, mac)}.{' '}
            {inKeychain ? 'Other apps cannot read it without your permission.' : 'Other users on this computer cannot read it.'}
            {where?.note && <span className="mt-1 block text-[12px] text-warn">{where.note}</span>}
          </Row>
          <Row title="Sent to">
            Only <span className="mono">{provider.host}</span>, {provider.sentWhen} Never to Caprock or anyone else.
          </Row>
          <Row title="Shown and logged">
            Never. After saving, Caprock shows only its first and last few characters. It is not in config.json, the database or any log.
          </Row>
          <Row title="Backups">
            {inKeychain
              ? 'Time Machine backs up the login keychain encrypted. It syncs to iCloud Keychain only if you move it there yourself.'
              : 'Time Machine and other backups copy the file like any file in your home folder.'}
          </Row>
          <Row title="Remove it">
            Remove here deletes it from {inKeychain ? 'the keychain' : 'the file'}. To make it useless everywhere, revoke it at{' '}
            <span className="mono">{provider.revokeAt}</span>: {provider.revokeHow}
          </Row>
        </dl>
      </div>
    </DialogBackdrop>
  )
}

/**
 * The whole field: saved pill with Replace and Remove, or the secure input
 * with Save. `onSave('')` is never called; `onRemove` is.
 */
export function SecretField({ label, what, set, hint, where, provider, placeholder, saveLabel = 'Save', busyLabel = 'Saving…', removeLabel = 'Remove', size = 'sm', onSave, onRemove, footer }: {
  /** The input's accessible name, e.g. "DeepSeek API key". */
  label: string
  /** How the dialog names it: "DeepSeek key", "bot token". */
  what: string
  set: boolean
  hint?: string
  where?: SecretWhere
  provider: SecretProvider
  placeholder?: string
  saveLabel?: string
  busyLabel?: string
  removeLabel?: string
  size?: 'sm' | 'lg'
  onSave: (value: string) => Promise<void>
  onRemove?: () => Promise<void>
  /** Extra controls on the input row (a Cancel, a link). */
  footer?: ReactNode
}) {
  const [draft, setDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (f: () => Promise<void>, after?: () => void) => {
    setBusy(true)
    setError('')
    try {
      await f()
      after?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const v = draft.trim()
    if (!v) return
    void act(() => onSave(v), () => { setDraft(''); setReplacing(false) })
  }
  const btn = size === 'lg'
    ? 'h-11 rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50'
    : 'h-[30px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50'
  const link = 'text-[12.5px] text-fg-muted hover:text-fg disabled:opacity-50'

  return (
    <div className="grid gap-1.5" data-secret-field="">
      {set && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <SecretPill hint={hint} where={where} />
          <SecretInfo what={what} provider={provider} where={where} />
          <button type="button" disabled={busy} onClick={() => setReplacing(true)} className={link}>Replace</button>
          {onRemove && (
            <button type="button" disabled={busy} onClick={() => void act(onRemove)} className="text-[12.5px] text-fg-muted hover:text-danger disabled:opacity-50">
              {busy ? 'Removing…' : removeLabel}
            </button>
          )}
          {footer}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SecretInput value={draft} onChange={setDraft} onEnter={save} label={label} placeholder={placeholder ?? (replacing ? 'Paste the new one' : undefined)} size={size} autoFocus={replacing} />
          <SecretInfo what={what} provider={provider} where={where} />
          <button type="button" disabled={busy || !draft.trim()} onClick={save} className={btn}>{busy ? busyLabel : saveLabel}</button>
          {replacing && (
            <button type="button" onClick={() => { setReplacing(false); setDraft(''); setError('') }} className={link}>Cancel</button>
          )}
          {footer}
        </div>
      )}
      <SecretNote where={where} host={provider.host} removeLabel={set ? removeLabel : undefined} />
      {error && <p role="alert" className="text-[12px] text-danger [overflow-wrap:anywhere]">{error}</p>}
    </div>
  )
}
