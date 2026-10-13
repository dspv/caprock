/**
 * The agents, drawn as characters.
 *
 * One small cast for every place the product shows who did the work — the
 * Week card first, and anything after it that wants the same language. Each
 * is a plain inline SVG with no external asset, so a card rendered to PNG in
 * the browser carries them without a fetch.
 *
 * The bodies use fixed brand colours rather than theme tokens: a character is
 * an illustration, and an amber pebble is the same pebble on graphite and on
 * paper. What does follow the theme is the outline, so a cream body never
 * vanishes into a cream ground.
 */

import type { Face } from '@/lib/faces'

export type Character = 'lead' | 'crowd' | 'codex' | 'opencode' | 'gemini' | 'deepseek'

const INK = '#201c16'
const AMBER = '#f3a553'
const AMBER_SOFT = '#ffc27e'
const AMBER_DEEP = '#e08a2b'
const CREAM = '#ebe6dc'
const STONE = '#bbb4a7'

/** Which character stands for an agent's main threads or its subagents. */
export function characterFor(agent: string, subagent = false): Character {
  if (agent === 'claude') return subagent ? 'crowd' : 'lead'
  if (agent === 'codex' || agent === 'opencode' || agent === 'gemini' || agent === 'deepseek') return agent
  return 'lead'
}

function Shadow({ rx = 22 }: { rx?: number }) {
  return <ellipse cx="40" cy="73" rx={rx} ry="3.5" fill="#000" opacity=".22" />
}

/** The pebble every face of Claude shares: one body, one shadow, the cheeks in its deeper shade. */
const PEBBLE = 'M14 46c0-17 11-28 26-28s26 11 26 28c0 14-11 24-26 24S14 60 14 46z'

/**
 * Claude's seven other faces (lib/faces.ts): the same pebble, hat and face
 * in the same places, so any one reads as Claude at 40 pixels. The bodies
 * are the pastel set the Dark Pastel palette is built from — sage, lavender,
 * dusty blue, sand, rose, periwinkle, soft amber — fixed like the classic
 * amber, since a character is an illustration; what follows the theme is the
 * outline round a pale hat.
 */
function FaceBody({ face, outline }: { face: Exclude<Face, 'cap'>; outline: { stroke: string; strokeWidth: number } }) {
  const eyes = (r = 4) => (<><circle cx="31" cy="46" r={r} fill={INK} /><circle cx="49" cy="46" r={r} fill={INK} /><circle cx="32.3" cy="44.6" r="1.3" fill="#fff" /><circle cx="50.3" cy="44.6" r="1.3" fill="#fff" /></>)
  const cheeks = (c: string) => (<><circle cx="23" cy="53" r="3.2" fill={c} opacity=".75" /><circle cx="57" cy="53" r="3.2" fill={c} opacity=".75" /></>)
  switch (face) {
    case 'beanie':
      // Sage, in a rose beanie with a pompom; eyes shut, content.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#8fbc98" />
          <path d="M17 34c0-13 10-21 23-21s23 8 23 21z" fill="#e3a0a0" {...outline} />
          <rect x="15" y="29" width="50" height="9" rx="4.5" fill="#c98282" {...outline} />
          <path d="M22 31v5M28 31v5M34 31v5M40 31v5M46 31v5M52 31v5M58 31v5" stroke="#e8b3b3" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="40" cy="12" r="5" fill="#f4d6d6" {...outline} />
          <path d="M27 47q4-4.5 8 0M45 47q4-4.5 8 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M34 56c3 3 9 3 12 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          {cheeks('#6f9e7a')}
        </>
      )
    case 'headphones':
      // Lavender, in big headphones, singing along.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#b8a8d6" />
          <path d="M16 42c0-18 11-27 24-27s24 9 24 27" stroke="#3a3733" strokeWidth="5" fill="none" strokeLinecap="round" />
          <rect x="8" y="37" width="12" height="18" rx="5" fill="#3a3733" />
          <rect x="60" y="37" width="12" height="18" rx="5" fill="#3a3733" />
          <rect x="16" y="39.5" width="4" height="13" rx="2" fill={CREAM} />
          <rect x="60" y="39.5" width="4" height="13" rx="2" fill={CREAM} />
          <path d="M66 6v10" stroke={AMBER} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M66 6l5 2" stroke={AMBER} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="63.5" cy="16" r="2.8" fill={AMBER} />
          {eyes()}
          <ellipse cx="40" cy="57.5" rx="3.6" ry="4.2" fill={INK} />
          {cheeks('#9886c0')}
        </>
      )
    case 'crown':
      // Dusty blue, crowned, a little smug.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#a3b6c9" />
          <path d="M23 33l-2-17 9.5 8L40 11l9.5 13 9.5-8-2 17z" fill="#f2c94c" strokeLinejoin="round" {...outline} />
          <rect x="22.5" y="29" width="35" height="5.5" rx="2.5" fill="#d9a92e" />
          <circle cx="21" cy="15.5" r="2.3" fill="#f2c94c" /><circle cx="40" cy="10.5" r="2.5" fill="#f2c94c" /><circle cx="59" cy="15.5" r="2.3" fill="#f2c94c" />
          <circle cx="40" cy="31.7" r="1.9" fill="#d9725f" />
          <path d="M27 46a4 4 0 0 0 8 0zM45 46a4 4 0 0 0 8 0z" fill={INK} />
          <path d="M26 45.5h10M44 45.5h10" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
          <path d="M34 57c3.5 2 8 1.5 12-2" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          {cheeks('#8299b2')}
        </>
      )
    case 'wizard':
      // Sand, under a starry wizard's hat, wide-eyed.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#d2bb88" />
          <path d="M23 31L39 3c1-2 3-2 4 0l15 28z" fill="#4b4f8f" strokeLinejoin="round" {...outline} />
          <ellipse cx="40" cy="31" rx="25" ry="4.5" fill="#3d4178" {...outline} />
          <path d="M44 14l1.2 2.8 2.8 1.2-2.8 1.2L44 22l-1.2-2.8-2.8-1.2 2.8-1.2z" fill="#f2c94c" />
          <circle cx="35" cy="24" r="1.3" fill="#f2c94c" />
          <circle cx="31" cy="46" r="4.6" fill={INK} /><circle cx="49" cy="46" r="4.6" fill={INK} />
          <circle cx="32.6" cy="44.3" r="1.6" fill="#fff" /><circle cx="50.6" cy="44.3" r="1.6" fill="#fff" />
          <circle cx="29.6" cy="47.6" r=".8" fill="#fff" /><circle cx="47.6" cy="47.6" r=".8" fill="#fff" />
          <ellipse cx="40" cy="57.5" rx="2.6" ry="3" fill={INK} />
          {cheeks('#b89d64')}
        </>
      )
    case 'tuft':
      // Rose, no hat, a tuft of hair; winks.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#e3a0a0" />
          <path d="M17 37c1-13 10-21 23-21s22 8 23 19c-5-4-10-6-15-6l1.5-5c-5 3-10 4.5-16 4.5l1-4c-6 3-12 7-17.5 12.5z" fill="#4a3a2e" />
          <path d="M40 17c-1-5 2-9 7-10" stroke="#4a3a2e" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M27 47q4-3.5 8 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="49" cy="46" r="4" fill={INK} /><circle cx="50.3" cy="44.6" r="1.3" fill="#fff" />
          <path d="M33 54h14c0 5-3 8.5-7 8.5s-7-3.5-7-8.5z" fill={INK} />
          {cheeks('#c98282')}
        </>
      )
    case 'bandana':
      // Periwinkle, in a coral bandana, set to work.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill="#a9a6e3" />
          <path d="M16 33c6-6 15-9 24-9s18 3 24 9l-1.5 6.5c-6-4.5-14-7-22.5-7s-16.5 2.5-22.5 7z" fill="#d9725f" />
          <path d="M62 33l11-3-4 6.5 6 5-11.5-2z" fill="#c4614f" />
          <circle cx="27" cy="31" r="1.2" fill={CREAM} /><circle cx="36" cy="28.5" r="1.2" fill={CREAM} /><circle cx="45" cy="28.5" r="1.2" fill={CREAM} /><circle cx="54" cy="31" r="1.2" fill={CREAM} />
          <path d="M26 41l8.5 2.2M54 41l-8.5 2.2" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="31" cy="47.5" r="3.6" fill={INK} /><circle cx="49" cy="47.5" r="3.6" fill={INK} />
          <circle cx="32.2" cy="46.3" r="1.1" fill="#fff" /><circle cx="50.2" cy="46.3" r="1.1" fill="#fff" />
          <path d="M34 57c4 2 8 2 12 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          {cheeks('#8a86cc')}
        </>
      )
    case 'propeller':
      // Soft amber, in a propeller cap, delighted.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill={AMBER_SOFT} />
          <path d="M20 32c2-10 10-15 20-15s18 5 20 15z" fill="#86a9dc" {...outline} />
          <path d="M34 32c0-9 2-14.5 6-15 4 .5 6 6 6 15z" fill="#e3a0a0" />
          <path d="M38 32h28c0 3-3 4.5-6.5 4.5H38z" fill="#6b8fc4" {...outline} />
          <rect x="39" y="9" width="2" height="9" fill={INK} />
          <ellipse cx="33" cy="9.5" rx="7" ry="2.3" fill="#f2c94c" />
          <ellipse cx="47" cy="9.5" rx="7" ry="2.3" fill="#e3a0a0" />
          <circle cx="40" cy="9.5" r="2" fill={INK} />
          {eyes()}
          <path d="M32 54h16c0 6-4 9-8 9s-8-3-8-9z" fill={INK} />
          <path d="M36 60.5c2-1.8 6-1.8 8 0-1 1.6-2.5 2.4-4 2.4s-3-.8-4-2.4z" fill="#e3807f" />
          {cheeks(AMBER_DEEP)}
        </>
      )
  }
}

/** A character's drawing in its 80x80 box, for composing several into one scene (BannerArt). */
export function Body({ who, face = 'cap' }: { who: Character; face?: Face }) {
  const outline = { stroke: 'var(--character-outline, transparent)', strokeWidth: 1.5 }
  if (who === 'lead' && face !== 'cap') return <FaceBody face={face} outline={outline} />
  switch (who) {
    case 'lead':
      // Claude Code: an amber pebble in a hard hat.
      return (
        <>
          <Shadow />
          <path d="M14 46c0-17 11-28 26-28s26 11 26 28c0 14-11 24-26 24S14 60 14 46z" fill={AMBER} />
          <path d="M22 30c3-10 10-15 18-15s15 5 18 15z" fill={CREAM} {...outline} />
          <rect x="18" y="28.5" width="44" height="5" rx="2.5" fill={CREAM} {...outline} />
          <rect x="37" y="14" width="6" height="8" rx="2" fill={STONE} />
          <circle cx="31" cy="46" r="4" fill={INK} /><circle cx="49" cy="46" r="4" fill={INK} />
          <circle cx="32.3" cy="44.6" r="1.3" fill="#fff" /><circle cx="50.3" cy="44.6" r="1.3" fill="#fff" />
          <path d="M33 56c4 4 10 4 14 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="24" cy="53" r="3.2" fill={AMBER_DEEP} opacity=".7" /><circle cx="56" cy="53" r="3.2" fill={AMBER_DEEP} opacity=".7" />
        </>
      )
    case 'crowd':
      // Subagents: a crowd of small pebbles.
      return (
        <>
          <Shadow rx={30} />
          <path d="M8 44c0-9 5-14 12-14s12 5 12 14-5 13-12 13S8 53 8 44z" fill={AMBER_DEEP} />
          <circle cx="16" cy="44" r="2" fill={INK} /><circle cx="24" cy="44" r="2" fill={INK} />
          <path d="M48 44c0-9 5-14 12-14s12 5 12 14-5 13-12 13S48 53 48 44z" fill={AMBER_DEEP} />
          <circle cx="56" cy="44" r="2" fill={INK} /><circle cx="64" cy="44" r="2" fill={INK} />
          <path d="M17 58c0-11 6-18 15-18s15 7 15 18-6 15-15 15-15-4-15-15z" fill={AMBER_SOFT} />
          <circle cx="27" cy="57" r="2.6" fill={INK} /><circle cx="37" cy="57" r="2.6" fill={INK} />
          <path d="M28 64c2.5 2 5.5 2 8 0" stroke={INK} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M35 60c0-11 6-18 14-18s14 7 14 18-6 14-14 14-14-3-14-14z" fill={AMBER} />
          <circle cx="45" cy="59" r="2.6" fill={INK} /><circle cx="54" cy="59" r="2.6" fill={INK} />
          <path d="M46 66c2.5 2 5.5 2 8 0" stroke={INK} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </>
      )
    case 'codex':
      // Codex: a cream terminal block with a prompt for a face.
      return (
        <>
          <Shadow />
          <rect x="13" y="20" width="54" height="50" rx="12" fill={CREAM} {...outline} />
          <path d="M25 20h30a12 12 0 0 1 12 11H13a12 12 0 0 1 12-11z" fill={STONE} />
          <circle cx="21" cy="25.5" r="1.8" fill="#6a655c" /><circle cx="27" cy="25.5" r="1.8" fill="#6a655c" />
          <path d="M24 42l7 5-7 5" stroke={INK} strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="36" y="51" width="16" height="3.4" rx="1.7" fill={INK} />
          <path d="M32 61c3 2.5 9 2.5 12 0" stroke="#958e81" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M58 12c0 4-3 6-6 6M64 9c0 6-5 10-10 10" stroke={AMBER} strokeWidth="2.2" fill="none" strokeLinecap="round" opacity=".9" />
        </>
      )
    case 'opencode':
      // OpenCode: a graphite block between braces.
      return (
        <>
          <Shadow />
          <rect x="18" y="22" width="44" height="48" rx="10" fill="#3a3733" {...outline} />
          <path d="M14 30c-4 0-5 3-5 7v4c0 3-2 5-4 5 2 0 4 2 4 5v4c0 4 1 7 5 7" stroke={AMBER} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M66 30c4 0 5 3 5 7v4c0 3 2 5 4 5-2 0-4 2-4 5v4c0 4-1 7-5 7" stroke={AMBER} strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="32" cy="43" r="4" fill={AMBER_SOFT} /><circle cx="48" cy="43" r="4" fill={AMBER_SOFT} />
          <circle cx="32" cy="43" r="1.8" fill={INK} /><circle cx="48" cy="43" r="1.8" fill={INK} />
          <path d="M33 55c4 3 10 3 14 0" stroke={AMBER_SOFT} strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </>
      )
    case 'gemini':
      // Gemini: a four-pointed spark with a face.
      return (
        <>
          <Shadow rx={18} />
          <path d="M40 10c3 18 12 27 28 32-16 4-25 13-28 30-3-17-12-26-28-30 16-5 25-14 28-32z" fill="#9db7e8" {...outline} />
          <circle cx="34" cy="41" r="3.2" fill={INK} /><circle cx="46" cy="41" r="3.2" fill={INK} />
          <circle cx="35" cy="40" r="1" fill="#fff" /><circle cx="47" cy="40" r="1" fill="#fff" />
          <path d="M35 49c3 2.6 7 2.6 10 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
        </>
      )
    case 'deepseek':
      // DeepSeek Harness: a small whale.
      return (
        <>
          <Shadow rx={26} />
          <path d="M10 46c0-13 12-22 28-22 15 0 25 8 27 18l9-8c1 6-1 12-6 16-4 9-15 16-30 16C21 66 10 58 10 46z" fill="#7fa7c9" {...outline} />
          <path d="M14 52c6 7 15 10 25 10s18-3 23-9" stroke="#e9f0f6" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".8" />
          <circle cx="27" cy="42" r="3.4" fill={INK} /><circle cx="28.2" cy="41" r="1.1" fill="#fff" />
          <path d="M30 18c0-4 3-6 3-9M36 20c1-4 4-5 5-8" stroke="#7fa7c9" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        </>
      )
  }
}

/**
 * One character, `size` pixels square. Decorative: the name beside it says
 * who. `face` dresses Claude ('lead') in one of its eight looks; every other
 * agent keeps its own mark.
 */
export function AgentCharacter({ who, size = 62, className, face }: { who: Character; size?: number; className?: string; face?: Face }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" aria-hidden="true" className={className} style={{ flex: 'none', display: 'block' }} data-face={who === 'lead' ? face ?? 'cap' : undefined}>
      <Body who={who} face={face} />
    </svg>
  )
}

/** The brand mark, as on the site: an amber triangle outline. */
export function CaprockMark({ size = 26, color = 'var(--color-accent)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M12 3.5 21.5 20h-19z" fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  )
}

/** What an agent is called on a card. */
export function agentName(agent: string): string {
  switch (agent) {
    case 'claude': return 'Claude Code'
    case 'codex': return 'Codex'
    case 'opencode': return 'OpenCode'
    case 'gemini': return 'Gemini CLI'
    case 'deepseek': return 'DeepSeek'
    case 'grok': return 'Grok'
    // A custom agent's session carries its id (ADR-046); its name lives in
    // the config, so the id stands in where only the session is at hand.
    default: return agent.replace(/^custom:/, '')
  }
}
