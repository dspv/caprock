/**
 * Second Brain's picture: a brain made of a graph. Nodes and links laid out
 * in the side view of a brain — the cerebrum with its gyri as a scalloped
 * edge, the cerebellum tucked under the back, the brain stem — in the four
 * memory kinds' colours (`--brain-idea`, `-decision`, `-finding`,
 * `-question`; tokens.css), so it follows every palette.
 *
 * Used large in the *How it works* dialog (SecondBrainModal) and medium as
 * the hero of the sidebar's empty Second Brain banner (BrainSidebar). The
 * size is the caller's: give it a height (or width) in `className`.
 *
 * It is alive, cheaply (resources are the moat): no JavaScript runs after
 * the first render. A few nodes pulse, and every ten seconds a new node
 * drops in, its links draw to its neighbours and a ring spreads where it
 * lands — all CSS keyframes (BrainMark.css). Under prefers-reduced-motion
 * it holds still with the new nodes already in place, and like every
 * animation it pauses while the window is hidden (tokens.css).
 *
 * The layout was generated once (a fixed outline, interior points spaced
 * inside it, each linked to its nearest neighbours) and is kept here as
 * plain numbers.
 */
import './BrainMark.css'

const CEREBRUM = 'M38 104Q23 97 24 86Q14 75 20 64Q16 52 28 43Q29 31 44 26Q49 15 66 14Q75 4 92 8Q105 0 120 7Q136 1 148 11Q166 10 174 22Q191 26 195 38Q210 46 209 58Q219 69 213 80Q217 91 205 100Q204 108 188 110Q184 116 166 114Q162 123 146 121Q138 132 124 128Q112 136 100 129Q87 134 80 124Q69 124 68 112Q55 114 56 106Q40 108 38 104Z'
/** The cerebellum's folds, drawn like the links, so it reads as one and not a hexagon. */
const FOLIA = 'M168 127Q188 120 208 128M167 133Q188 127 208 133M173 139Q189 135 205 140'
const CEREBELLUM = 'M168 120Q177 114 190 114Q201 115 207 121Q211 128 207 136Q200 144 188 145Q174 143 166 136Q163 128 168 120Z'

/** 0–30 trace the outline (cerebrum, cerebellum, stem); 31 on are inside. */
const NODES: [number, number][] = [[38, 104], [24, 86], [20, 64], [28, 43], [44, 26], [66, 14], [92, 8], [120, 7], [148, 11], [174, 22], [195, 38], [209, 58], [213, 80], [205, 100], [188, 110], [166, 114], [146, 121], [124, 128], [100, 129], [80, 124], [68, 112], [56, 106], [168, 120], [190, 114], [207, 121], [207, 136], [188, 145], [166, 136], [142, 125], [148, 143], [152, 160], [109, 75], [198, 64], [59, 69], [142, 102], [60, 38], [107, 108], [110, 42], [182, 92], [83, 37], [168, 56], [38, 83], [40, 49], [129, 62], [69, 92], [132, 25], [154, 78], [153, 33], [85, 64], [92, 90], [107, 20], [84, 110], [129, 84]]
const INSIDE = 31
const LINKS: [number, number][] = [[0, 1], [0, 21], [0, 41], [1, 2], [2, 3], [2, 42], [3, 4], [4, 5], [4, 35], [5, 6], [6, 7], [6, 50], [7, 8], [8, 9], [8, 45], [9, 10], [10, 11], [11, 12], [12, 13], [12, 32], [13, 14], [14, 15], [14, 23], [14, 38], [15, 16], [15, 22], [16, 17], [16, 28], [16, 34], [17, 18], [18, 19], [18, 36], [19, 20], [20, 21], [20, 51], [22, 23], [22, 27], [23, 24], [24, 25], [25, 26], [26, 27], [28, 29], [29, 30], [31, 43], [31, 48], [31, 49], [31, 52], [32, 38], [32, 40], [33, 41], [33, 42], [33, 44], [33, 48], [34, 46], [34, 52], [35, 39], [35, 42], [36, 49], [36, 51], [37, 39], [37, 50], [38, 46], [39, 48], [40, 46], [40, 47], [41, 44], [43, 52], [44, 49], [44, 51], [45, 47], [45, 50], [46, 52], [49, 51]]
/** The nodes that pulse, each a beat apart. Few on purpose: each one costs a repaint. */
const PULSE = [31, 33, 38, 44, 47, 50]
/** The two that drop in, half a cycle apart, into the two widest gaps. */
const NEW: { at: [number, number]; to: number[]; kind: number; delay: string }[] = [
  { at: [148, 54], to: [40, 43, 47], kind: 0, delay: '0s' },
  { at: [178, 74], to: [32, 38, 46], kind: 2, delay: '-5s' },
]
const KINDS = ['var(--brain-idea)', 'var(--brain-decision)', 'var(--brain-finding)', 'var(--brain-question)']

function radius(i: number): number {
  return i < INSIDE ? 2.4 : 3 + ((i * 7) % 3)
}

export function BrainMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="10 -4 214 168" className={`brain-mark block ${className}`} aria-hidden="true" data-brain-mark>
      <path d={CEREBELLUM} className="brain-mark-shape" />
      <path d={CEREBRUM} className="brain-mark-shape" />
      <g className="brain-mark-links">
        <path d={FOLIA} fill="none" />
        {LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NODES[a]![0]} y1={NODES[a]![1]} x2={NODES[b]![0]} y2={NODES[b]![1]} />
        ))}
        {NEW.map((n) => n.to.map((b) => (
          <line key={`n${n.at[0]}-${b}`} x1={n.at[0]} y1={n.at[1]} x2={NODES[b]![0]} y2={NODES[b]![1]}
            pathLength={1} className="brain-mark-link-new" style={{ animationDelay: n.delay }} />
        )))}
      </g>
      {NODES.map(([x, y], i) => {
        const p = PULSE.indexOf(i)
        return (
          <circle key={i} cx={x} cy={y} r={radius(i)} fill={KINDS[i % 4]}
            className={p >= 0 ? 'brain-mark-pulse' : undefined}
            style={p >= 0 ? { animationDelay: `${-p * 0.6}s` } : undefined} />
        )
      })}
      {NEW.map((n) => (
        <g key={`new${n.at[0]}`}>
          <circle cx={n.at[0]} cy={n.at[1]} r={4} fill="none" stroke={KINDS[n.kind]} strokeWidth={1.5}
            className="brain-mark-ring" style={{ animationDelay: n.delay }} />
          <circle cx={n.at[0]} cy={n.at[1]} r={4.5} fill={KINDS[n.kind]}
            className="brain-mark-new" style={{ animationDelay: n.delay }} />
        </g>
      ))}
    </svg>
  )
}
