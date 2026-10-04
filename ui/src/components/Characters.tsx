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

function Body({ who }: { who: Character }) {
  const outline = { stroke: 'var(--character-outline, transparent)', strokeWidth: 1.5 }
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

/** One character, `size` pixels square. Decorative: the name beside it says who. */
export function AgentCharacter({ who, size = 62, className }: { who: Character; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" aria-hidden="true" className={className} style={{ flex: 'none', display: 'block' }}>
      <Body who={who} />
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
    default: return agent
  }
}
