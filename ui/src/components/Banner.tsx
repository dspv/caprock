/**
 * One banner, for every offer and notice in the product.
 *
 * Owner, 2026-10-11 (translated): "Banners like this must be gorgeous, with a
 * picture — small but perfect. Use your own designs." So every banner — the
 * team card, the Premium offers, the setup and star strips, the update and
 * hooks notices, the locked panels' foot — is this one shape: a small scene
 * drawn from the product's own characters on the left, a title in a
 * confident weight, one short line, one primary button and a quiet dismiss.
 * One row on a desktop, the actions under the words when narrow (a container
 * query, so it also holds in a narrow column).
 *
 * The banners keep their own logic — when they show, their dismissal keys,
 * the one offer slot (lib/nudges.ts). This file only draws them. Styles are
 * in Banner.css, theme tokens only.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Body, type Character } from './Characters'
import './Banner.css'

export type BannerTone = 'accent' | 'premium' | 'warn' | 'ok'

export function Banner({
  id,
  tone = 'accent',
  art,
  title,
  line,
  foot,
  actions,
  edge = false,
  role,
  label,
  className = '',
  children,
}: {
  /** data-banner, for tests and screenshots. */
  id: string
  tone?: BannerTone
  art: Scene
  title: ReactNode
  line?: ReactNode
  /** A small third line: a command, a path. */
  foot?: ReactNode
  actions?: ReactNode
  /** A strip on the page's bottom edge or a panel's foot, not a card. */
  edge?: boolean
  role?: string
  label?: string
  className?: string
  /** Shown under the row, full width — an expanded picker. */
  children?: ReactNode
}) {
  return (
    <div className={`bn-wrap ${className}`}>
      <div className="bn" data-banner={id} data-tone={tone} data-edge={edge || undefined} role={role} aria-label={label}>
        <div className="bn-art" aria-hidden="true"><BannerArt scene={art} /></div>
        <div className="bn-body">
          <div className="bn-title">{title}</div>
          {line && <div className="bn-line">{line}</div>}
          {foot && <div className="bn-foot">{foot}</div>}
        </div>
        {actions && <div className="bn-actions">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/** The one primary button. `premium` for a paid feature, ultramarine; `ghost` for a second action. */
export function BannerButton({ kind = 'accent', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'accent' | 'premium' | 'ghost' }) {
  const fill = kind === 'accent' ? 'bg-accent text-bg' : ''
  return <button type="button" data-kind={kind} className={`bn-btn ${fill} ${className}`} {...rest} />
}

/** The quiet dismiss: words ("Not now") or, with `icon`, a ×. */
export function BannerDismiss({ icon = false, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: boolean }) {
  return <button type="button" className="bn-x" data-icon={icon || undefined} {...rest}>{icon ? '×' : children}</button>
}

/** A figure from the reader's own data, set in the banner's tone. */
export function Fig({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="bn-fig" title={title}>{children}</span>
}

export type Scene = 'team' | 'cap' | 'window' | 'phone' | 'star' | 'update' | 'hooks' | 'done' | 'lock' | 'plan' | 'ask' | 'graph' | 'mail'

/** A character at (x, y) in the 120x84 scene, `s` times its 80px size. */
function Who({ who, x, y, s }: { who: Character; x: number; y: number; s: number }) {
  return <g transform={`translate(${x} ${y}) scale(${s})`}><Body who={who} /></g>
}

/** A round badge in the banner's tone, with a glyph in the tone's ink. */
function Badge({ x, y, r = 12, children }: { x: number; y: number; r?: number; children: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r + 2.5} fill="var(--color-panel)" />
      <circle r={r} fill="var(--bn-tone)" />
      <g stroke="var(--bn-on)" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{children}</g>
    </g>
  )
}

/**
 * The small scenes. Each is the product's own cast (Characters.tsx) doing the
 * thing the banner is about: a team of agents, an agent paused at a line, an
 * agent holding a phone. Inline SVG, no external image.
 */
export function BannerArt({ scene }: { scene: Scene }) {
  return (
    <svg viewBox="0 0 120 84" preserveAspectRatio="xMidYMid meet">
      <SceneBody scene={scene} />
    </svg>
  )
}

function SceneBody({ scene }: { scene: Scene }) {
  switch (scene) {
    case 'team':
      // Several people's agents, side by side. No Codex here: its mark is
      // OpenAI's Blossom, which may only name Codex itself, not decorate.
      return (
        <>
          <Who who="opencode" x={-2} y={20} s={0.76} />
          <Who who="gemini" x={62} y={18} s={0.76} />
          <Who who="lead" x={21} y={2} s={1} />
        </>
      )
    case 'cap':
      // An agent stopped at a line the reader drew.
      return (
        <>
          <path d="M4 8H116" stroke="var(--bn-tone)" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" />
          <Who who="lead" x={10} y={4} s={1} />
          <Badge x={92} y={50}><path d="M-3.5 -5V5M3.5 -5V5" /></Badge>
        </>
      )
    case 'window':
      // A plan window nearly spent, and a pause before it.
      return (
        <>
          <Who who="lead" x={0} y={4} s={1} />
          <g transform="translate(92 40)">
            <circle r="17" fill="none" stroke="var(--color-border-strong)" strokeWidth="4" />
            <circle r="17" fill="none" stroke="var(--bn-tone)" strokeWidth="4" strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 17 * 0.84} 200`} transform="rotate(-90)" />
            <path d="M-3.5 -5V5M3.5 -5V5" stroke="var(--bn-ink)" strokeWidth="2.6" strokeLinecap="round" />
          </g>
        </>
      )
    case 'phone':
      // An agent holding a phone, a message on its way.
      return (
        <>
          <Who who="lead" x={-2} y={4} s={1} />
          <g transform="translate(66 14) rotate(8)">
            <rect x="0" y="0" width="28" height="50" rx="6" fill="#201c16" />
            <rect x="2.5" y="5" width="23" height="38" rx="2.5" fill="var(--color-panel-2)" />
            <rect x="5" y="10" width="14" height="6" rx="3" fill="var(--bn-tone)" />
            <rect x="9" y="19" width="14" height="6" rx="3" fill="var(--color-border-strong)" />
            <rect x="5" y="28" width="11" height="6" rx="3" fill="var(--bn-tone)" />
            <rect x="11" y="45.5" width="6" height="1.6" rx=".8" fill="#6a655c" />
          </g>
          <circle cx="66" cy="52" r="4.5" fill="#f3a553" />
          <path d="M98 10l14-5-6 13-3-5z" fill="var(--bn-tone)" />
          <path d="M103 13l-4 5" stroke="var(--bn-tone)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )
    case 'star':
      return (
        <>
          <Who who="lead" x={4} y={4} s={1} />
          <path d="M94 10l4.4 9 9.9 1.4-7.2 7 1.7 9.8L94 32.6 85.2 37.2l1.7-9.8-7.2-7 9.9-1.4z" fill="var(--bn-tone)" />
          <path d="M108 44v6M105 47h6M80 6v4M78 8h4" stroke="var(--bn-tone)" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )
    case 'update':
      return (
        <>
          <Who who="lead" x={4} y={4} s={1} />
          <Badge x={94} y={28} r={13}><path d="M0 6V-6M-5 -1L0 -6L5 -1" /></Badge>
        </>
      )
    case 'hooks':
      // A plug, waiting for its socket.
      return (
        <>
          <Who who="lead" x={0} y={4} s={1} />
          <g transform="translate(92 42)" stroke="var(--bn-tone)" strokeWidth="3" strokeLinecap="round" fill="none">
            <rect x="-9" y="-8" width="18" height="14" rx="4" fill="var(--bn-tone)" stroke="none" />
            <path d="M-4 -8V-15M4 -8V-15M0 6V12c0 6-6 8-12 8" />
          </g>
        </>
      )
    case 'done':
      return (
        <>
          <Who who="lead" x={4} y={4} s={1} />
          <Badge x={94} y={30} r={13}><path d="M-5.5 0.5L-1.5 4.5L6 -4" /></Badge>
        </>
      )
    case 'ask':
      // A question to the reader: the lead beside a question mark.
      return (
        <>
          <Who who="lead" x={4} y={4} s={1} />
          <Badge x={94} y={30} r={13}><path d="M-3.8 -3.2a3.8 3.8 0 1 1 5 3.6c-1 .4-1.2 1-1.2 2.2M0 6.2v.1" /></Badge>
        </>
      )
    case 'graph':
      // The lead beside a small graph of linked ideas (Second Brain).
      return (
        <>
          <Who who="lead" x={-4} y={4} s={1} />
          <g stroke="var(--bn-tone)" strokeWidth="1.6" opacity="0.7">
            <path d="M94 40L80 22M94 40L110 26M94 40L108 58M94 40L78 60M80 22L110 26M78 60L108 58" />
          </g>
          <circle cx="94" cy="40" r="6" fill="var(--bn-tone)" />
          {[[80, 22], [110, 26], [108, 58], [78, 60]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="3.6" fill="var(--color-panel)" stroke="var(--bn-tone)" strokeWidth="1.6" />
          ))}
        </>
      )
    case 'mail':
      // A letter on its way to a window of its own.
      return (
        <>
          <Who who="lead" x={-2} y={4} s={1} />
          <g transform="translate(74 22)">
            <rect width="38" height="28" rx="4" fill="var(--color-panel)" stroke="var(--bn-tone)" strokeWidth="2.2" />
            <path d="M3 4L19 16L35 4" fill="none" stroke="var(--bn-tone)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <path d="M100 58l8 -8M108 50h-6M108 50v6" stroke="var(--bn-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'lock':
      return (
        <>
          <Who who="lead" x={4} y={4} s={1} />
          <g transform="translate(94 40)">
            <path d="M-7 -4V-9a7 7 0 0 1 14 0V-4" stroke="var(--bn-ink)" strokeWidth="3" fill="none" />
            <rect x="-11" y="-4" width="22" height="18" rx="4" fill="var(--bn-tone)" />
            <circle cx="0" cy="4" r="2.4" fill="var(--bn-on)" />
          </g>
        </>
      )
    case 'plan':
      // A plan card with the price left blank.
      return (
        <>
          <Who who="lead" x={-2} y={4} s={1} />
          <g transform="translate(76 16) rotate(6)">
            <rect width="32" height="42" rx="5" fill="var(--color-panel)" stroke="var(--bn-tone)" strokeWidth="2" />
            <rect x="6" y="7" width="20" height="3" rx="1.5" fill="var(--color-border-strong)" />
            <text x="16" y="33" textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--bn-ink)" fontFamily="var(--font-sans)">?</text>
          </g>
        </>
      )
  }
}
