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

import { useId } from 'react'
import { isDobie, isDuck, isNewYear, isPumpkin, type ClaudeFace, type Dobie, type Duck, type Face, type NewYear, type Pumpkin } from '@/lib/faces'

export type Character = 'lead' | 'crowd' | 'codex' | 'opencode' | 'gemini' | 'deepseek' | 'hermes' | 'cursor'

const INK = '#201c16'
const AMBER = '#f3a553'
const AMBER_SOFT = '#ffc27e'
const AMBER_DEEP = '#e08a2b'
const CREAM = '#ebe6dc'
const STONE = '#bbb4a7'

/** Which character stands for an agent's main threads or its subagents. */
export function characterFor(agent: string, subagent = false): Character {
  if (agent === 'claude') return subagent ? 'crowd' : 'lead'
  if (agent === 'codex' || agent === 'opencode' || agent === 'gemini' || agent === 'deepseek' || agent === 'hermes' || agent === 'cursor') return agent
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
function FaceBody({ face, outline }: { face: Exclude<ClaudeFace, 'cap'>; outline: { stroke: string; strokeWidth: number } }) {
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

/*
 * The rubber ducks (lib/faces.ts): one bath-toy duck, facing right, in the
 * same 80x80 box and on the same shadow as the pebble, so a duck sits where
 * a face sits at 30 and at 48 pixels. Every duck is the same body, head,
 * beak and eye; what each one wears is drawn over it.
 */
const DUCK_YELLOW = '#f6cf4a'
const DUCK_SHADE = '#e2b030'
const BEAK = '#f39a3d'
const BEAK_DEEP = '#d8772a'
const DUCK_BODY = 'M8 36c5 5 11 6 17 5.5 5-1.6 11-2.5 18-2.5 15 0 25 7 25 17.5 0 9.5-10 15.5-27 15.5H29C16 72 8 65 8 54.5c0-6.5-1-12 0-18.5z'
const DUCK_WING = 'M23 51c6-5.5 16-6 22-.5-2.5 7.5-11 10.5-18 8-3-1.2-5-4.2-4-7.5z'

function DuckBody({ duck, outline }: { duck: Duck; outline: { stroke: string; strokeWidth: number } }) {
  const id = useId()
  const head = (fill = DUCK_YELLOW) => <circle cx="46" cy="29" r="15" fill={fill} {...outline} />
  const beak = () => (<><path d="M57.5 27.5c6.5-3 13.5-2 16.5 2 1 1.4.2 2.8-1.4 3.3-4 1.6-10 2.6-15 2.2z" fill={BEAK} {...outline} /><path d="M59.5 33h12" stroke={BEAK_DEEP} strokeWidth="1.6" strokeLinecap="round" /></>)
  const eye = (<><circle cx="51" cy="24.5" r="3.4" fill={INK} /><circle cx="52.3" cy="23.2" r="1.15" fill="#fff" /></>)
  const shut = <path d="M47.6 25q3.4 2.8 6.8 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
  const cheek = <ellipse cx="53.5" cy="32.5" rx="2.6" ry="2" fill="#f08a6a" opacity=".55" />
  const body = (fill = DUCK_YELLOW, wing = DUCK_SHADE) => (<><path d={DUCK_BODY} fill={fill} {...outline} /><path d={DUCK_WING} fill={wing} /></>)
  switch (duck) {
    case 'duck':
      // The classic: yellow, orange beak, bright-eyed.
      return (<><Shadow rx={25} />{body()}{head()}{beak()}{eye}{cheek}</>)
    case 'duck-glasses':
      // The debugger: round glasses, looking hard at the problem.
      return (
        <>
          <Shadow rx={25} />{body()}{head()}{beak()}{eye}{cheek}
          <circle cx="51" cy="24.5" r="6.4" fill="#fff" fillOpacity=".22" stroke={INK} strokeWidth="2.2" />
          <path d="M44.7 23.6L33 21" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M57.3 23.4l3-1.2" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
        </>
      )
    case 'duck-headset':
      // On call: a headset with a mic at the beak.
      return (
        <>
          <Shadow rx={25} />{body('#9fd0e6', '#7bb4cf')}{head('#9fd0e6')}{beak()}{eye}{cheek}
          <path d="M39 26c-3-9 2-15.5 10-16.5 4-.4 7.5.6 10 2.5" stroke="#3a3733" strokeWidth="3.6" fill="none" strokeLinecap="round" />
          <rect x="34" y="22" width="10" height="13" rx="4.5" fill="#3a3733" />
          <rect x="36.5" y="24.5" width="5" height="8" rx="2.5" fill={CREAM} />
          <path d="M40 35c2 5 8 6.5 13 5" stroke="#3a3733" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <circle cx="54.5" cy="39.8" r="2.4" fill="#3a3733" />
        </>
      )
    case 'duck-party':
      // Party: a striped cone hat, confetti, eyes shut with glee.
      return (
        <>
          <Shadow rx={25} />{body()}{head()}{beak()}{shut}{cheek}
          <path d="M37 18.5L47.5 1.5 56 16.5c-6.5-1.6-12.5-1-19 2z" fill="#b8a8d6" strokeLinejoin="round" {...outline} />
          <path d="M42.5 9.6l7.7 2.2M39.6 14.4l13.2 2" stroke="#e3807f" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="47.5" cy="2.5" r="2.8" fill="#f2c94c" />
          <rect x="11" y="12" width="4" height="4" rx="1" fill="#e3807f" transform="rotate(20 13 14)" />
          <rect x="68" y="10" width="4" height="4" rx="1" fill="#86a9dc" transform="rotate(-25 70 12)" />
          <circle cx="24" cy="24" r="2" fill="#8fbc98" />
          <circle cx="70" cy="46" r="1.8" fill="#f3a553" />
        </>
      )
    case 'duck-pirate':
      // The pirate: a black hat with a skull, a patch over the eye.
      return (
        <>
          <Shadow rx={25} />{body()}{head()}{beak()}{cheek}
          <path d="M37 23.5l20 7" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
          <ellipse cx="51" cy="25" rx="4.6" ry="4.2" fill={INK} />
          <path d="M29 19.5c3-10 11-14.5 17.5-14.5S60 9 64 18c-6-3.2-12-4.2-17.5-4.2S35 15.5 29 19.5z" fill="#2f2b26" {...outline} />
          <path d="M31 18.5c5-3 10.5-4.3 15.5-4.3 6.5 0 12.5 1.5 17 3.6" stroke="#d9a92e" strokeWidth="1.4" fill="none" />
          <circle cx="46.5" cy="10" r="2.4" fill={CREAM} />
          <path d="M44.5 13.2l4 0" stroke={CREAM} strokeWidth="1.2" strokeLinecap="round" />
        </>
      )
    case 'duck-hoodie':
      // The hacker: a graphite hoodie, a green glint, code on the chest.
      return (
        <>
          <Shadow rx={25} />
          <path d={DUCK_BODY} fill="#615b52" {...outline} />
          <path d="M27 63.5h7M37 63.5h10M27 58.5h4M34 58.5h9" stroke="#8fd18f" strokeWidth="2" strokeLinecap="round" />
          <path d="M28 33c0-14 8.5-22 19-22s19 8 19 21c0 5-1.5 9-4 12H31c-2-3-3-6.5-3-11z" fill="#615b52" {...outline} />
          <circle cx="48" cy="29" r="12" fill={DUCK_YELLOW} />
          {beak()}
          <circle cx="51" cy="25.5" r="3.2" fill={INK} /><circle cx="52.2" cy="24.3" r="1.1" fill="#8fd18f" />
          <path d="M40 43v8M45 43v7" stroke={CREAM} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )
    case 'duck-sleepy':
      // Sleepy: a nightcap, eyes shut, a z or two.
      return (
        <>
          <Shadow rx={25} />{body()}{head()}{beak()}{shut}{cheek}
          <path d="M32.5 22c1-9 8-14.5 16-14.5 9 0 15 7 18.5 17-3.5-3.5-8-5-12.5-5-8 0-15 .5-22 2.5z" fill="#86a9dc" {...outline} />
          <path d="M31.5 20.5c7-3 16-4 24-3" stroke="#e9f0f6" strokeWidth="3.2" strokeLinecap="round" />
          <circle cx="67.5" cy="26" r="3.6" fill="#e9f0f6" {...outline} />
          <path d="M13 17h6l-6 6.5h6M21 7.5h4.4L21 12.3h4.4" stroke="#86a9dc" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'duck-rainbow':
      // Rainbow: the body in six bands, the head in the classic yellow.
      return (
        <>
          <Shadow rx={25} />
          <clipPath id={`${id}-rb`}><path d={DUCK_BODY} /></clipPath>
          <g clipPath={`url(#${id}-rb)`}>
            {['#e3807f', '#f3a553', '#f2d15c', '#8fbc98', '#86a9dc', '#b8a8d6'].map((c, i) => <rect key={c} x="0" y={35 + i * 6.4} width="80" height="6.6" fill={c} />)}
          </g>
          <path d={DUCK_BODY} fill="none" {...outline} />
          <path d={DUCK_WING} fill="#000" opacity=".1" />
          {head()}{beak()}{eye}{cheek}
        </>
      )
  }
}

/*
 * The Halloween pumpkins (lib/faces.ts): one ribbed pumpkin, three lobes and
 * a curled stem, in the same 80x80 box and on the same shadow, the eyes where
 * the pebble's are so a pumpkin reads as the same little guy. What each one
 * wears, and how its face is carved, is drawn over it.
 */
const PUMPKIN = '#f08a2e'
const PUMPKIN_DEEP = '#d4701c'
const STEM = '#6b7f45'

function PumpkinBody({ pumpkin, outline }: { pumpkin: Pumpkin; outline: { stroke: string; strokeWidth: number } }) {
  const id = useId()
  // A hat leaves the stem out (stem null): it would poke through the brim.
  const body = (fill = PUMPKIN, deep = PUMPKIN_DEEP, stem: string | null = STEM) => (
    <>
      {stem && <path d="M37.5 30c-.5-4.5.5-9 3.5-12l3.5 2c-2 2.5-2.6 6-2 10z" fill={stem} {...outline} />}
      {stem && <path d="M44 21c3.5-3 8.5-3 11 .5" stroke={stem} strokeWidth="2" fill="none" strokeLinecap="round" />}
      <ellipse cx="27" cy="50" rx="15" ry="19" fill={deep} {...outline} />
      <ellipse cx="53" cy="50" rx="15" ry="19" fill={deep} {...outline} />
      <ellipse cx="40" cy="49" rx="16" ry="21" fill={fill} {...outline} />
    </>
  )
  const eyes = (r = 4) => (<><circle cx="31" cy="46" r={r} fill={INK} /><circle cx="49" cy="46" r={r} fill={INK} /><circle cx="32.3" cy="44.6" r="1.3" fill="#fff" /><circle cx="50.3" cy="44.6" r="1.3" fill="#fff" /></>)
  const carved = (fill: string) => (
    <>
      <path d="M26 48l5-8.5 5 8.5zM44 48l5-8.5 5 8.5z" fill={fill} strokeLinejoin="round" />
      <path d="M26 54c3 6.5 8 9 14 9s11-2.5 14-9c-2 .8-4 1.2-6 1.2l-1.5 3-2-3h-9l-2 3-1.5-3c-2 0-4-.4-6-1.2z" fill={fill} />
    </>
  )
  switch (pumpkin) {
    case 'pumpkin':
      // The classic jack-o'-lantern: triangle eyes, a toothy grin.
      return (<><Shadow rx={26} />{body()}{carved(INK)}</>)
    case 'pumpkin-witch':
      // A witch: a crooked purple hat with a green band, a sly smile.
      return (
        <>
          <Shadow rx={26} />{body(PUMPKIN, PUMPKIN_DEEP, null)}
          <path d="M26 30c5-9 9-17 20-25-2 6-1 15 8 25z" fill="#4a3d63" strokeLinejoin="round" {...outline} />
          <rect x="27" y="25" width="26" height="5" rx="1.5" fill="#8fbc98" />
          <rect x="37" y="24.5" width="6" height="6" rx="1" fill="none" stroke="#f2c94c" strokeWidth="1.6" />
          <ellipse cx="40" cy="31" rx="25" ry="4.5" fill="#3d3352" {...outline} />
          {eyes()}
          <path d="M33 56c4 3 9 3 13-1" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      )
    case 'pumpkin-vampire':
      // A vampire: a high red-lined collar, a widow's peak, two small fangs.
      return (
        <>
          <Shadow rx={26} />
          <path d="M14 70L4 30l20 20zM66 70l10-40-20 20z" fill="#2f2b26" {...outline} />
          <path d="M14 66L7 37l15 15zM66 66l7-29-15 15z" fill="#b8423a" />
          {body()}
          <path d="M26 33c4-3 9-4.5 14-4.5s10 1.5 14 4.5c-4 0-7.5.5-10 2.5L40 40l-4-4.5c-2.5-2-6-2.5-10-2.5z" fill="#2f2b26" />
          <path d="M26 42l8.5 2M54 42l-8.5 2" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
          {eyes(3.6)}
          <path d="M32 55c5 3 11 3 16 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M35 56.5l1.6 4 1.6-3.5zM41.8 57l1.6 3.5 1.6-4z" fill="#fff" />
        </>
      )
    case 'pumpkin-ghost':
      // A ghost: a white pumpkin, startled, with a small ghost over its shoulder.
      return (
        <>
          <Shadow rx={26} />{body('#ece7dc', '#cfc7b8', '#8a8f6a')}
          <ellipse cx="31" cy="45.5" rx="3.8" ry="5" fill={INK} /><ellipse cx="49" cy="45.5" rx="3.8" ry="5" fill={INK} />
          <circle cx="32.3" cy="43.5" r="1.3" fill="#fff" /><circle cx="50.3" cy="43.5" r="1.3" fill="#fff" />
          <ellipse cx="40" cy="58" rx="3.4" ry="4.2" fill={INK} />
          <circle cx="23" cy="53" r="3.2" fill="#9db7e8" opacity=".6" /><circle cx="57" cy="53" r="3.2" fill="#9db7e8" opacity=".6" />
          <path d="M60 22c0-7 3.5-11 8-11s8 4 8 11v8l-2.7-2.2-2.6 2.2-2.7-2.2-2.7 2.2-2.6-2.2L60 30z" fill="#fff" {...outline} stroke="var(--character-outline, #cfc7b8)" />
          <circle cx="65.5" cy="19.5" r="1.3" fill={INK} /><circle cx="70.5" cy="19.5" r="1.3" fill={INK} />
        </>
      )
    case 'pumpkin-cat':
      // A black cat: ears, a pink nose and whiskers.
      return (
        <>
          <Shadow rx={26} />
          <path d="M17 38l1-17 13 9zM63 38l-1-17-13 9z" fill="#2f2b26" strokeLinejoin="round" {...outline} />
          <path d="M20 33l.6-8.5 6.5 4.5zM60 33l-.6-8.5-6.5 4.5z" fill="#e3a0a0" />
          {body()}
          <ellipse cx="31" cy="46" rx="4" ry="4.6" fill="#f2c94c" /><ellipse cx="49" cy="46" rx="4" ry="4.6" fill="#f2c94c" />
          <ellipse cx="31" cy="46" rx="1.4" ry="3.8" fill={INK} /><ellipse cx="49" cy="46" rx="1.4" ry="3.8" fill={INK} />
          <path d="M37.5 52.5h5L40 55.5z" fill="#e3807f" />
          <path d="M40 55.5c-1 2.5-4 3-5.5 1M40 55.5c1 2.5 4 3 5.5 1" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M28 54.5l-11-1.5M28 57.5l-10 2.5M52 54.5l11-1.5M52 57.5l10 2.5" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
        </>
      )
    case 'pumpkin-mummy':
      // A mummy: wrapped in bandages, one eye peeking out.
      return (
        <>
          <Shadow rx={26} />
          <clipPath id={`${id}-mm`}><ellipse cx="27" cy="50" rx="15" ry="19" /><ellipse cx="53" cy="50" rx="15" ry="19" /><ellipse cx="40" cy="49" rx="16" ry="21" /></clipPath>
          {body()}
          <g clipPath={`url(#${id}-mm)`} opacity=".95">
            <path d="M8 34l64 6M8 41l64-7M8 53l64 4M8 62l64-5M8 68l64 2" stroke="#ebe6dc" strokeWidth="5.5" />
            <path d="M8 34l64 6M8 53l64 4M8 68l64 2" stroke="#cfc7b8" strokeWidth="1" />
          </g>
          <rect x="24" y="44" width="32" height="6.5" rx="3" fill={PUMPKIN} />
          <circle cx="31" cy="47.2" r="3" fill={INK} /><circle cx="32" cy="46.2" r="1" fill="#fff" />
          <path d="M45.5 47.5h7" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
        </>
      )
    case 'pumpkin-monster':
      // A monster: green, a flat black top, stitches and two bolts.
      return (
        <>
          <Shadow rx={26} />
          <rect x="5" y="49" width="9" height="5" rx="1.5" fill="#8a8f96" {...outline} />
          <rect x="66" y="49" width="9" height="5" rx="1.5" fill="#8a8f96" {...outline} />
          {body('#9cc48a', '#7aa36a', '#5a4632')}
          <path d="M25 37c0-5 6-8 15-8s15 3 15 8l-3-1.5-2.5 2-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2z" fill="#2f2b26" />
          <path d="M35 39.5h10M37 37.5v4M40 37.5v4M43 37.5v4" stroke="#3d5a35" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M27 45h8M45 45h8" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="31" cy="48" r="3" fill={INK} /><circle cx="49" cy="48" r="3" fill={INK} />
          <path d="M32 57h16" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <path d="M35 55v4M40 55v4M45 55v4" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
        </>
      )
    case 'pumpkin-lantern':
      // A lantern: a deep-orange pumpkin with a candle's glow inside its carved face.
      return (
        <>
          <Shadow rx={26} />
          <radialGradient id={`${id}-gl`} cx="40" cy="50" r="22" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffe08a" /><stop offset="1" stopColor="#f3a553" />
          </radialGradient>
          {body('#c8601e', '#9e4814')}
          {carved(`url(#${id}-gl)`)}
          <circle cx="40" cy="50" r="24" fill="#ffd25e" opacity=".08" />
        </>
      )
  }
}

/*
 * The New Year faces (lib/faces.ts): Santa, the elf and the reindeer are the
 * pebble, the Santa duck is the rubber duck, and the snowman, the tree, the
 * bauble and the gingerbread man are drawn in the same 80x80 box on the same
 * shadow, the eyes near where the pebble's are.
 */
const RED = '#d6504a'
const RED_DEEP = '#b33f3a'
const SNOW = '#f4f1ea'
const SNOW_SHADE = '#ddd6ca'
const GOLD = '#f2c94c'
const GOLD_DEEP = '#d9a92e'
const ICING = '#fbf7ef'
const GINGER_LIMBS = 'M21 43L59 43M34 55L27 66M46 55L53 66'

function NewYearBody({ face, outline }: { face: NewYear; outline: { stroke: string; strokeWidth: number } }) {
  const eyes = (<><circle cx="31" cy="46" r="4" fill={INK} /><circle cx="49" cy="46" r="4" fill={INK} /><circle cx="32.3" cy="44.6" r="1.3" fill="#fff" /><circle cx="50.3" cy="44.6" r="1.3" fill="#fff" /></>)
  const cheeks = (c: string) => (<><circle cx="23" cy="53" r="3.2" fill={c} opacity=".75" /><circle cx="57" cy="53" r="3.2" fill={c} opacity=".75" /></>)
  switch (face) {
    case 'ny-santa':
      // Santa: a soft-amber pebble, a red hat whose tip flops to the right, a white beard.
      return (
        <>
          <Shadow />
          <path d={PEBBLE} fill={AMBER_SOFT} />
          <path d="M17 34c0-13 10-21 23-21 10 0 18 4 23 11l7 13-6 1.5c-1.5-4-3.5-7-6-9v4.5z" fill={RED} strokeLinejoin="round" {...outline} />
          <circle cx="68" cy="38.5" r="5" fill={SNOW} {...outline} />
          <rect x="15" y="29" width="50" height="9" rx="4.5" fill={SNOW} {...outline} />
          <path d="M15 49c3 4 7 6 11 6h28c4 0 8-2 11-6 1 11-5 21-13 24-4 1.5-8 2-12 2s-8-.5-12-2c-8-3-14-13-13-24z" fill={SNOW} {...outline} />
          <path d="M24 63c3 3 6 5 9 6M56 63c-3 3-6 5-9 6" stroke={SNOW_SHADE} strokeWidth="1.6" fill="none" strokeLinecap="round" />
          {eyes}
          <circle cx="22.5" cy="50" r="3" fill="#e3807f" opacity=".75" /><circle cx="57.5" cy="50" r="3" fill="#e3807f" opacity=".75" />
          <ellipse cx="40" cy="60.5" rx="3" ry="2.2" fill={INK} />
          <path d="M40 55.5c-3-3.5-9-3.5-12 .5 3.5 2.5 9 2.5 12-.5zM40 55.5c3-3.5 9-3.5 12 .5-3.5 2.5-9 2.5-12-.5z" fill="#fff" {...outline} />
          <circle cx="40" cy="52.5" r="2.8" fill="#e8907a" />
        </>
      )
    case 'ny-snowman':
      // A snowman: coal eyes and smile, a carrot nose, a crooked bucket, a red scarf.
      return (
        <>
          <Shadow rx={20} />
          <ellipse cx="40" cy="63" rx="19" ry="10" fill={SNOW_SHADE} {...outline} />
          <circle cx="40" cy="41" r="19" fill={SNOW} {...outline} />
          <g transform="rotate(-10 40 22)">
            <path d="M28 24l3-15h18l3 15z" fill="#7f9bb3" strokeLinejoin="round" {...outline} />
            <path d="M30.3 13.5h19.4" stroke="#9fb6c9" strokeWidth="2" strokeLinecap="round" />
            <rect x="25" y="22" width="30" height="5" rx="2.5" fill="#6a849b" {...outline} />
            <path d="M29 18c-4 1-5 5-3 8" stroke="#4d6275" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </g>
          <circle cx="33" cy="39" r="3.4" fill={INK} /><circle cx="47" cy="39" r="3.4" fill={INK} />
          <circle cx="34.1" cy="37.8" r="1.1" fill="#fff" /><circle cx="48.1" cy="37.8" r="1.1" fill="#fff" />
          <path d="M39 43.5l17 4c1 .3 1 1.3 0 1.6L39.5 49c-2-.8-2.5-4.5-.5-5.5z" fill={BEAK} strokeLinejoin="round" />
          <path d="M45 45.5l-1 2.8M50 46.8l-.8 2" stroke={BEAK_DEEP} strokeWidth="1" strokeLinecap="round" />
          <circle cx="33.5" cy="51.5" r="1.4" fill={INK} /><circle cx="37.5" cy="53.3" r="1.4" fill={INK} /><circle cx="42" cy="53.6" r="1.4" fill={INK} /><circle cx="46.3" cy="52.3" r="1.4" fill={INK} />
          <circle cx="26" cy="46" r="3.2" fill="#e3a0a0" opacity=".75" /><circle cx="54" cy="46" r="3.2" fill="#e3a0a0" opacity=".75" />
          <path d="M22 54c5 4 11 6 18 6s13-2 18-6l1 5c-5 4.5-12 7-19 7s-14-2.5-19-7z" fill={RED} {...outline} />
          <path d="M49 60l6 12-6 1.5-4-12z" fill={RED_DEEP} strokeLinejoin="round" {...outline} />
          <path d="M30 58.5l-1 5.5M40 60l-.5 5.5M50 58.5l1 5" stroke="#8fbc98" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M50 66l4-1" stroke="#8fbc98" strokeWidth="2" strokeLinecap="round" />
        </>
      )
    case 'ny-reindeer':
      // A reindeer: a brown pebble, branching antlers, a pale muzzle, a shiny red nose.
      return (
        <>
          <Shadow />
          <path d="M29 24c-4-6-5-12-2.5-18M27.5 14c-4-.5-7.5-3-9-7M27 19.5c3-2 5-5.5 5.5-9" stroke="#6b4a32" strokeWidth="3.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M51 24c4-6 5-12 2.5-18M52.5 14c4-.5 7.5-3 9-7M53 19.5c-3-2-5-5.5-5.5-9" stroke="#6b4a32" strokeWidth="3.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18 34c-6.5 0-11.5-3-13-8 5-1.5 11 0 15 4z" fill="#7d5638" {...outline} />
          <path d="M62 34c6.5 0 11.5-3 13-8-5-1.5-11 0-15 4z" fill="#7d5638" {...outline} />
          <path d={PEBBLE} fill="#a87a5a" />
          <path d="M40 22c3 0 5 2 5 4s-2 3-5 3-5-1-5-3 2-4 5-4z" fill="#c9a07e" />
          <ellipse cx="40" cy="58" rx="12" ry="9" fill="#dcbf9f" />
          {eyes}
          <path d="M35 64c3 2 7 2 10 0" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />
          <circle cx="40" cy="55" r="5.5" fill="#e0443e" {...outline} /><circle cx="38.2" cy="53.2" r="1.7" fill="#fff" opacity=".8" />
          {cheeks('#8a5c40')}
        </>
      )
    case 'ny-tree':
      // A Christmas tree: three tiers, garland and lights, a star; the face on the bottom tier.
      return (
        <>
          <Shadow rx={24} />
          <rect x="35" y="62" width="10" height="9" rx="2" fill="#7d5638" {...outline} />
          <path d="M40 34l24 27c1 1.5 0 3-2 3H18c-2 0-3-1.5-2-3z" fill="#4a8559" strokeLinejoin="round" {...outline} />
          <path d="M40 23l18 20c1 1.5 0 3-2 3H24c-2 0-3-1.5-2-3z" fill="#5f9e6e" strokeLinejoin="round" {...outline} />
          <path d="M40 13l12 14c1 1.5 0 2.5-1.5 2.5h-21C28 29.5 27 28.5 28 27z" fill="#6fae7d" strokeLinejoin="round" {...outline} />
          <path d="M31 27c5 2.5 13 2.5 19-1M26 43c8 4 20 4 30-1.5" stroke={GOLD} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M21 60c11 3.5 27 3.5 39-1" stroke="#e3807f" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <circle cx="34" cy="21.5" r="1.8" fill="#e3807f" /><circle cx="46" cy="35" r="2" fill="#86a9dc" /><circle cx="30" cy="36" r="2" fill={GOLD} />
          <circle cx="21" cy="56" r="2.2" fill="#86a9dc" /><circle cx="59" cy="56" r="2.2" fill={GOLD} />
          <circle cx="33" cy="51" r="3.4" fill={INK} /><circle cx="47" cy="51" r="3.4" fill={INK} />
          <circle cx="34.1" cy="49.8" r="1.1" fill="#fff" /><circle cx="48.1" cy="49.8" r="1.1" fill="#fff" />
          <path d="M36.5 56c2 2 5 2 7 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <circle cx="27.5" cy="55" r="2.6" fill="#e3a0a0" opacity=".8" /><circle cx="52.5" cy="55" r="2.6" fill="#e3a0a0" opacity=".8" />
          <path d="M40 2.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill={GOLD} strokeLinejoin="round" {...outline} />
        </>
      )
    case 'ny-elf':
      // An elf: a peach pebble, pointy ears, a green hat with a bell; laughing.
      return (
        <>
          <Shadow />
          <path d="M16 41L4 33.5c-1-.6-.6-1.8.5-1.6L17 35z" fill="#f5c9a6" strokeLinejoin="round" {...outline} />
          <path d="M64 41l12-7.5c1-.6.6-1.8-.5-1.6L63 35z" fill="#f5c9a6" strokeLinejoin="round" {...outline} />
          <path d={PEBBLE} fill="#f5c9a6" />
          <path d="M19 33C24 20 36 8 54 4c2.5-.5 3.5 1 2.5 3C52 16 56 25 61 33z" fill="#4f9a5a" strokeLinejoin="round" {...outline} />
          <circle cx="56" cy="5" r="4" fill={GOLD} {...outline} /><path d="M54 6.5h4" stroke={GOLD_DEEP} strokeWidth="1.4" strokeLinecap="round" />
          <rect x="15" y="29" width="50" height="8" rx="4" fill={RED} {...outline} />
          <path d="M21 33h0M28 33h0M35 33h0M42 33h0M49 33h0M56 33h0" stroke={SNOW} strokeWidth="2.6" strokeLinecap="round" />
          {eyes}
          <path d="M32 54h16c0 6-4 9-8 9s-8-3-8-9z" fill={INK} />
          <path d="M36 60.5c2-1.8 6-1.8 8 0-1 1.6-2.5 2.4-4 2.4s-3-.8-4-2.4z" fill="#e3807f" />
          {cheeks('#e8907a')}
          <circle cx="21" cy="50" r=".9" fill="#b9805a" /><circle cx="24" cy="49" r=".9" fill="#b9805a" /><circle cx="56" cy="49" r=".9" fill="#b9805a" /><circle cx="59" cy="50" r=".9" fill="#b9805a" />
        </>
      )
    case 'ny-bauble':
      // A bauble: a blue ornament with a gold cap and loop, a wavy band, a shine.
      return (
        <>
          <Shadow rx={20} />
          <circle cx="40" cy="14" r="4.5" fill="none" stroke={GOLD_DEEP} strokeWidth="2.4" />
          <circle cx="40" cy="47" r="24" fill="#5f8fd6" {...outline} />
          <path d="M17.5 39c7 3 15 4 22.5 4s15.5-1 22.5-4" stroke="#b8cdf0" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M18 61c4.5-2.5 7.5 2.5 11 0s7.5 2.5 11 0 7.5 2.5 11 0 7.5 2.5 11 0" stroke={GOLD} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <ellipse cx="29" cy="32" rx="5" ry="3" fill="#fff" opacity=".5" transform="rotate(-35 29 32)" />
          <rect x="32" y="18" width="16" height="7.5" rx="2" fill={GOLD} {...outline} />
          <path d="M36 19.5v4.5M40 19.5v4.5M44 19.5v4.5" stroke={GOLD_DEEP} strokeWidth="1.4" strokeLinecap="round" />
          {eyes}
          <path d="M34 54c3.5 3.5 8.5 3.5 12 0" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          {cheeks('#e3a0a0')}
        </>
      )
    case 'ny-santa-duck':
      // The classic duck in a Santa hat, its tip flopping back behind the head.
      return (
        <>
          <Shadow rx={25} />
          <path d={DUCK_BODY} fill={DUCK_YELLOW} {...outline} /><path d={DUCK_WING} fill={DUCK_SHADE} />
          <circle cx="46" cy="29" r="15" fill={DUCK_YELLOW} {...outline} />
          <path d="M57.5 27.5c6.5-3 13.5-2 16.5 2 1 1.4.2 2.8-1.4 3.3-4 1.6-10 2.6-15 2.2z" fill={BEAK} {...outline} /><path d="M59.5 33h12" stroke={BEAK_DEEP} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="51" cy="24.5" r="3.4" fill={INK} /><circle cx="52.3" cy="23.2" r="1.15" fill="#fff" />
          <ellipse cx="53.5" cy="32.5" rx="2.6" ry="2" fill="#f08a6a" opacity=".55" />
          <path d="M38 11c-5-3.5-12-3-16.5 2l3.5 3.5c3.5-2.5 7.5-3 11.5-2z" fill={RED_DEEP} {...outline} />
          <path d="M31.5 21.5c1-8.5 7.5-14 15.5-14 7.5 0 13.5 5 15 13.5-10-1.5-20-1.5-30.5.5z" fill={RED} {...outline} />
          <path d="M31.5 21.5c10-2.2 20.5-2.4 30.5-.6" stroke={SNOW} strokeWidth="4.6" strokeLinecap="round" fill="none" />
          <circle cx="22.5" cy="15" r="4" fill={SNOW} {...outline} />
        </>
      )
    case 'ny-gingerbread':
      // A gingerbread man: icing at the wrists and ankles, an icing smile, two candy buttons.
      return (
        <>
          <Shadow rx={22} />
          <path d={GINGER_LIMBS} stroke={outline.stroke} strokeWidth="13.5" strokeLinecap="round" fill="none" />
          <circle cx="40" cy="25" r="14.75" fill={outline.stroke} />
          <path d={GINGER_LIMBS} stroke="#c97d40" strokeWidth="12" strokeLinecap="round" fill="none" />
          <ellipse cx="40" cy="48" rx="12" ry="12" fill="#c97d40" />
          <circle cx="40" cy="25" r="14" fill="#c97d40" />
          <path d="M19.5 39.5c1.5 1 1.5 2.5 0 3.5s-1.5 2.5 0 3.5M60.5 39.5c-1.5 1-1.5 2.5 0 3.5s1.5 2.5 0 3.5" stroke={ICING} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M23.5 64c2 .5 3.5 1.5 5 2.5s3 1 4.5 .5M56.5 64c-2 .5-3.5 1.5-5 2.5s-3 1-4.5.5" stroke={ICING} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <circle cx="40" cy="43" r="2.4" fill="#e0443e" /><circle cx="40" cy="50.5" r="2.4" fill="#4f9a5a" />
          <path d="M36.5 36.5l3.5 2 3.5-2" stroke={ICING} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="34.5" cy="23" r="3.2" fill={INK} /><circle cx="45.5" cy="23" r="3.2" fill={INK} />
          <circle cx="35.6" cy="21.9" r="1.1" fill="#fff" /><circle cx="46.6" cy="21.9" r="1.1" fill="#fff" />
          <path d="M34 29.5c3.5 3.5 8.5 3.5 12 0" stroke={ICING} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <circle cx="29.5" cy="28.5" r="2.5" fill="#e3807f" opacity=".75" /><circle cx="50.5" cy="28.5" r="2.5" fill="#e3807f" opacity=".75" />
        </>
      )
  }
}

/*
 * The dobermans (lib/faces.ts): one head, front-on, in the same 80x80 box on
 * the same shadow — cropped ears, a narrow wedge head with a long muzzle, the
 * breed's rust markings (eyebrow dots, cheeks and muzzle round a dark bridge,
 * two chest patches) — in its four coats: black, red, blue and fawn. The eyes
 * sit in a brown ring so they read on a black coat.
 */
type Coat = { coat: string; deep: string; tan: string; nose: string; ear: string; iris: string }
const COATS: Record<'black' | 'red' | 'blue' | 'fawn', Coat> = {
  black: { coat: '#3d3530', deep: '#2c2622', tan: '#cc8440', nose: '#1c1814', ear: '#9a6a56', iris: '#6b4424' },
  red: { coat: '#7c3f24', deep: '#5f2f1a', tan: '#dba06a', nose: '#4a2414', ear: '#b07060', iris: '#5a3018' },
  blue: { coat: '#6c7884', deep: '#56616c', tan: '#cc935f', nose: '#3f4852', ear: '#a08a88', iris: '#5a4632' },
  fawn: { coat: '#b19887', deep: '#977e6d', tan: '#e2b27a', nose: '#86665e', ear: '#d09c94', iris: '#6a4a30' },
}
const DOBIE_HEAD = 'M40 15c13 0 20.5 9 20.5 21 0 7-2 11-5 15-2 4-4 9-6.5 12.5-2 2.5-5 3.5-9 3.5s-7-1-9-3.5c-2.5-3.5-4.5-8.5-6.5-12.5-3-4-5-8-5-15 0-12 7.5-21 20.5-21z'
const DOBIE_SMILE = 'M40 56.5v2M34 58.5c2 2.8 4.5 2.8 6 0 1.5 2.8 4 2.8 6 0'
const DOBIE_SMIRK = 'M40 56.5v2M35 59.5c2 1 4 .6 5-1 1.5 2.6 5 2.6 7.5-.5'

type DobieLook = { coat: Coat; ears?: 'cropped' | 'floppy'; eye?: 'open' | 'happy' | 'sleepy' | 'none'; mouth: 'smile' | 'tongue' | 'blep' | 'smirk' | 'oh'; tilt?: number }
const DOBIE_LOOK: Record<Dobie, DobieLook> = {
  'dobie-black': { coat: COATS.black, mouth: 'smile' },
  'dobie-red': { coat: COATS.red, eye: 'happy', mouth: 'smile' },
  'dobie-blue': { coat: COATS.blue, mouth: 'smirk' },
  'dobie-fawn': { coat: COATS.fawn, mouth: 'oh' },
  'dobie-floppy': { coat: COATS.black, ears: 'floppy', mouth: 'smile' },
  'dobie-tongue': { coat: COATS.red, eye: 'happy', mouth: 'tongue' },
  'dobie-cool': { coat: COATS.blue, eye: 'none', mouth: 'smirk' },
  'dobie-sleepy': { coat: COATS.fawn, eye: 'sleepy', mouth: 'blep', tilt: -14 },
}

function DobieBody({ dobie, outline }: { dobie: Dobie; outline: { stroke: string; strokeWidth: number } }) {
  const { coat: k, ears = 'cropped', eye = 'open', mouth, tilt } = DOBIE_LOOK[dobie]
  const line = (d: string) => <path d={d} stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  const head = (
    <>
      {ears === 'cropped' && (
        <>
          <path d="M24 31L19.5 3c-.3-1.8 1.2-2.6 2.4-1.4L36 20z" fill={k.coat} strokeLinejoin="round" {...outline} />
          <path d="M56 31l4.5-28c.3-1.8-1.2-2.6-2.4-1.4L44 20z" fill={k.coat} strokeLinejoin="round" {...outline} />
          <path d="M25.3 25L22 8l9 11.5zM54.7 25L58 8l-9 11.5z" fill={k.ear} />
        </>
      )}
      <path d={DOBIE_HEAD} fill={k.coat} {...outline} />
      <path d="M25 48c3.5-2.5 9-3.5 15-3.5s11.5 1 15 3.5c-1.5 5-3.5 10.5-6 14.5-2 2.6-5 3.6-9 3.6s-7-1-9-3.6c-2.5-4-4.5-9.5-6-14.5z" fill={k.tan} />
      <path d="M34.5 38c2-1 9-1 11 0l-1.4 15.5h-8.2z" fill={k.coat} />
      {ears === 'floppy' && (
        <>
          <path d="M22 21c-7 1.5-11 10-11.5 21-.2 5 3.5 7 6.5 3.5 3.5-4.5 5-11 6.5-17z" fill={k.deep} strokeLinejoin="round" {...outline} />
          <path d="M58 21c7 1.5 11 10 11.5 21 .2 5-3.5 7-6.5 3.5-3.5-4.5-5-11-6.5-17z" fill={k.deep} strokeLinejoin="round" {...outline} />
        </>
      )}
      <ellipse cx="30" cy="35" rx="3.4" ry="2.4" fill={k.tan} /><ellipse cx="50" cy="35" rx="3.4" ry="2.4" fill={k.tan} />
      {eye === 'open' && (
        <>
          <circle cx="31" cy="42.5" r="4.6" fill={k.iris} /><circle cx="49" cy="42.5" r="4.6" fill={k.iris} />
          <circle cx="31" cy="42.5" r="3.3" fill={INK} /><circle cx="49" cy="42.5" r="3.3" fill={INK} />
          <circle cx="32.4" cy="41.1" r="1.3" fill="#fff" /><circle cx="50.4" cy="41.1" r="1.3" fill="#fff" />
        </>
      )}
      {eye === 'happy' && <path d="M26.5 43.5q4.5-5 9 0M44.5 43.5q4.5-5 9 0" stroke={k.tan} strokeWidth="3" fill="none" strokeLinecap="round" />}
      {eye === 'sleepy' && (
        <>
          <path d="M26.5 42q4.5 3.5 9 0" stroke={k.tan} strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="49" cy="43" r="4.6" fill={k.iris} /><circle cx="49" cy="43" r="3.3" fill={INK} />
          <circle cx="50.4" cy="41.6" r="1.3" fill="#fff" />
          <path d="M43.8 41.2h10.4c0-3.4-2.4-5.4-5.2-5.4s-5.2 2-5.2 5.4z" fill={k.coat} />
          <path d="M44 41.3h10" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      <g transform="translate(0 3)">
        <path d="M33.5 51.5c0-2.3 2.8-3.5 6.5-3.5s6.5 1.2 6.5 3.5-2.8 5-6.5 5-6.5-2.7-6.5-5z" fill={k.nose} />
        <ellipse cx="37.8" cy="50.3" rx="2" ry="1.1" fill="#fff" opacity=".45" />
        {(mouth === 'smile' || mouth === 'blep') && line(DOBIE_SMILE)}
        {mouth === 'blep' && <path d="M41.5 59.8h4.2v2.4c0 1.4-1 2.4-2.1 2.4s-2.1-1-2.1-2.4z" fill="#e8807f" />}
        {mouth === 'smirk' && line(DOBIE_SMIRK)}
        {mouth === 'oh' && (<><path d="M40 56.5v1.5" stroke={INK} strokeWidth="2" strokeLinecap="round" /><ellipse cx="40" cy="60.5" rx="2.4" ry="2.6" fill={INK} /></>)}
        {mouth === 'tongue' && (
          <>
            <path d="M33 58c2 4 12 4 14 0z" fill={INK} />
            <path d="M36 59.5h8v4.5c0 3-1.8 5-4 5s-4-2-4-5z" fill="#e8807f" {...outline} />
            <path d="M40 60.5v4.5" stroke="#c4605f" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M40 56.5v2" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </g>
      {dobie === 'dobie-cool' && (
        <>
          {/* Sunglasses and a tiny party hat, with confetti. */}
          <path d="M23 39.5h14c0 5-2.5 8-7 8s-7-3-7-8zM43 39.5h14c0 5-2.5 8-7 8s-7-3-7-8z" fill="#1d2228" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M37 40.5c2-1 4-1 6 0" stroke={INK} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M23 40l-4.5-1.5M57 40l4.5-1.5" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M26.5 42l3-2.2M46.5 42l3-2.2" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity=".7" />
          <path d="M33 20L41.5 1.5 49.5 19c-5.5-1.6-11-1.3-16.5 1z" fill="#b8a8d6" strokeLinejoin="round" {...outline} />
          <path d="M38.2 10l7.4 1.6M35.7 15.4l11.9 1.2" stroke="#e3807f" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="41.5" cy="2.5" r="2.8" fill="#f2c94c" />
          <rect x="9" y="22" width="4" height="4" rx="1" fill="#e3807f" transform="rotate(20 11 24)" />
          <rect x="67" y="24" width="4" height="4" rx="1" fill="#86a9dc" transform="rotate(-25 69 26)" />
          <circle cx="70" cy="44" r="1.8" fill="#8fbc98" /><circle cx="10" cy="46" r="1.8" fill="#f3a553" />
        </>
      )}
    </>
  )
  return (
    <>
      <Shadow rx={24} />
      <path d="M15 73c1.5-10 11-15.5 25-15.5S63.5 63 65 73z" fill={k.coat} {...outline} />
      <path d="M26 63c3.5 1.5 6.5 4.5 8 10h-8.5c-1.5-3.5-1.5-7 .5-10zM54 63c-3.5 1.5-6.5 4.5-8 10h8.5c1.5-3.5 1.5-7-.5-10z" fill={k.tan} />
      {tilt ? <g transform={`rotate(${tilt} 40 44)`}>{head}</g> : head}
      {dobie === 'dobie-sleepy' && <path d="M62 14h6l-6 6.5h6M70 4.5h4.4L70 9.3h4.4" stroke="#86a9dc" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </>
  )
}

/** A character's drawing in its 80x80 box, for composing several into one scene (BannerArt). */
export function Body({ who, face = 'cap' }: { who: Character; face?: Face }) {
  const outline = { stroke: 'var(--character-outline, transparent)', strokeWidth: 1.5 }
  if (who === 'lead' && isDuck(face)) return <DuckBody duck={face} outline={outline} />
  if (who === 'lead' && isNewYear(face)) return <NewYearBody face={face} outline={outline} />
  if (who === 'lead' && isDobie(face)) return <DobieBody dobie={face} outline={outline} />
  if (who === 'lead' && isPumpkin(face)) return <PumpkinBody pumpkin={face} outline={outline} />
  if (who === 'lead' && !isDuck(face) && !isPumpkin(face) && !isNewYear(face) && !isDobie(face) && face !== 'cap') return <FaceBody face={face} outline={outline} />
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
    case 'hermes':
      // Hermes Agent: a teal messenger with two small wings. Drawn here, not
      // Nous Research's mark.
      return (
        <>
          <Shadow rx={20} />
          <path d="M20 26c-7-1-13-6-15-13 6 1 12 4 16 9z" fill="#e9f0f6" {...outline} />
          <path d="M60 26c7-1 13-6 15-13-6 1-12 4-16 9z" fill="#e9f0f6" {...outline} />
          <rect x="18" y="20" width="44" height="50" rx="20" fill="#5fb8a3" {...outline} />
          <circle cx="32" cy="42" r="3.6" fill={INK} /><circle cx="48" cy="42" r="3.6" fill={INK} />
          <circle cx="33.2" cy="40.8" r="1.2" fill="#fff" /><circle cx="49.2" cy="40.8" r="1.2" fill="#fff" />
          <path d="M34 52c3.5 2.6 8.5 2.6 12 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
        </>
      )
    case 'cursor':
      // Cursor: a graphite cube with a face on its front. Drawn here, not
      // Anysphere's mark.
      return (
        <>
          <Shadow rx={22} />
          <path d="M40 10 66 24v30L40 68 14 54V24z" fill="#5d636b" {...outline} />
          <path d="M14 24 40 38l26-14" fill="none" {...outline} />
          <path d="M40 38v30" fill="none" {...outline} />
          <path d="M14 24 40 10l26 14-26 14z" fill="#8a9099" {...outline} />
          <circle cx="24" cy="46" r="3.2" fill={INK} /><circle cx="32" cy="50" r="3.2" fill={INK} />
          <circle cx="25" cy="45" r="1.1" fill="#fff" /><circle cx="33" cy="49" r="1.1" fill="#fff" />
        </>
      )
  }
}

/**
 * One character, `size` pixels square. Decorative: the name beside it says
 * who. `face` dresses Claude ('lead') in one of its faces; every other
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
    case 'hermes': return 'Hermes'
    case 'cursor': return 'Cursor'
    // Conversations imported from an export (ADR-074): the service is the source.
    case 'claude.ai': return 'Claude.ai'
    case 'chatgpt': return 'ChatGPT'
    // A custom agent's session carries its id (ADR-046); its name lives in
    // the config, so the id stands in where only the session is at hand.
    default: return agent.replace(/^custom:/, '')
  }
}
