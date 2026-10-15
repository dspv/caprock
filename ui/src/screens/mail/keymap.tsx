import { keys } from '@/lib/appkeys'

/**
 * Mail is used from the keyboard: every action has a key, and the key is
 * shown on the action. This list is the one place they are named — the
 * buttons, the folder list and the `?` sheet all read it, so a key cannot be
 * bound in one place and shown differently in another. Single letters are the
 * same on every OS; chords go through keys() (CLAUDE.md rule 12).
 */
export const MAIL_KEYS = {
  down: 'j', up: 'k',
  compose: 'c', reply: 'r', replyAll: 'a', forward: 'f',
  archive: 'e', trash: '#', spam: '!', notSpam: 'n', move: 'v',
  star: 's', unread: 'u', summarise: 'i',
  search: '/', settings: ',', theme: 't', sync: 'g r', help: '?', close: 'Esc',
  send: '⌘↩', draft: '⌘J',
  inbox: 'g i', unreadView: 'g u', starred: 'g s', sent: 'g t',
  drafts: 'g d', archiveView: 'g a', spamView: 'g !', trashView: 'g #',
  catAll: '1', catImportant: '2', catUpdates: '3', catNewsletter: '4', catSpam: '5',
} as const

export type MailKey = keyof typeof MAIL_KEYS

/** The second key after `g`, by view. */
export const GO: Record<string, string> = {
  i: 'inbox', u: 'unread', s: 'flagged', t: 'sent', d: 'drafts', a: 'archive', '!': 'junk', '#': 'trash',
}

/** How a key reads on this OS: `g i` stays `g i`, `⌘↩` is Ctrl+Enter off macOS. */
export const keyText = (k: MailKey) => {
  const raw = MAIL_KEYS[k]
  return raw.includes('⌘') ? keys(raw) : raw
}

/** The key chip shown on an action. */
export function K({ k }: { k: MailKey }) {
  return <kbd className="k" aria-hidden>{keyText(k)}</kbd>
}

/** Every shortcut, grouped as the `?` sheet shows them. */
export const SHEET: { title: string; rows: [MailKey, string][] }[] = [
  { title: 'Move around', rows: [['down', 'Next conversation'], ['up', 'Previous conversation'], ['search', 'Search'], ['close', 'Close, back to the list']] },
  { title: 'Go to', rows: [['inbox', 'Inbox'], ['unreadView', 'Unread'], ['starred', 'Starred'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['archiveView', 'Archive'], ['spamView', 'Spam'], ['trashView', 'Trash']] },
  { title: 'Act on a conversation', rows: [['archive', 'Archive'], ['trash', 'Delete'], ['spam', 'Spam'], ['notSpam', 'Not spam'], ['move', 'Move to folder'], ['star', 'Star'], ['unread', 'Mark unread / read'], ['summarise', 'Summarise with AI']] },
  { title: 'Sort with AI', rows: [['catAll', 'All but spam'], ['catImportant', 'Important'], ['catUpdates', 'Updates'], ['catNewsletter', 'Newsletters'], ['catSpam', 'Spam, the filter’s and the AI’s']] },
  { title: 'Write', rows: [['compose', 'New message'], ['reply', 'Reply'], ['replyAll', 'Reply all'], ['forward', 'Forward'], ['send', 'Send'], ['draft', 'Draft the reply with AI']] },
  { title: 'Mail', rows: [['sync', 'Check mail'], ['theme', 'Theme'], ['settings', 'Settings'], ['help', 'This list']] },
]

/** The `?` sheet. */
export function KeySheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="keysheet" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="keybox" onClick={(e) => e.stopPropagation()}>
        <div className="keyhead">Keyboard shortcuts <span className="grow" /><K k="close" /></div>
        <p className="keyhint">Two keys with a space, like <kbd className="k">g i</kbd>: press g, let go, then i. Every button shows its key too.</p>
        <div className="keycols">
          {SHEET.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              {g.rows.map(([k, label]) => (
                <div key={k} className="keyrow"><span>{label}</span><K k={k} /></div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
