/**
 * Which agent a session runs, as that agent's own mark: the Claude spark, the
 * Gemini sparkle, the OpenCode frame, the DeepSeek whale. A text monogram
 * ("Cl", "Cx") had to be read; a mark is recognised.
 *
 * Sources. The Claude, Google Gemini, OpenCode and DeepSeek paths are copied
 * from Simple Icons 16.34.0 (https://github.com/simple-icons/simple-icons,
 * slugs `claude`, `googlegemini`, `opencode`, `deepseek`), which releases its
 * SVG data under CC0 1.0. The marks themselves stay their owners' trademarks
 * and are shown only to say which product a session runs. Simple Icons carries
 * no OpenAI mark and Codex's repository ships none under a licence, so Codex
 * gets a letter in a rounded square drawn here, like the shell's prompt and
 * the unknown agent's dot. Inline path data only: nothing is fetched and no
 * icon package ships with the UI.
 *
 * Colour, one rule: a mark wears its brand colour mixed 70/30 with the muted
 * ink (`--agent-*` in design/tokens.css), which takes the saturation down and
 * clears 3:1 against every surface on graphite, white and paper. A brand
 * whose colour is black or white (OpenCode), and our own glyphs, are drawn in
 * the muted ink itself.
 *
 * The box is the monogram's — 15px tall, 17px wide — so no row, tab or list
 * changes height; the mark inside is 13px.
 */
import { agentName } from './Characters'
import { TerminalIcon } from './AppIcons'

type Mark = { path: string; color: string } | { draw: 'codex' | 'unknown' }

const MARKS: Record<string, Mark> = {
  claude: { path: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z', color: 'var(--agent-claude)' },
  gemini: { path: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81', color: 'var(--agent-gemini)' },
  opencode: { path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z', color: 'var(--color-fg-muted)' },
  deepseek: { path: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45', color: 'var(--agent-deepseek)' },
  codex: { draw: 'codex' },
}

/**
 * An agent's mark as plain path data, for a drawing that is not a DOM tree
 * (the share card paints on a canvas). The path is in a 24x24 box; Codex and
 * an unknown agent have none and are drawn by the caller, as here.
 */
export function agentMarkPath(agent: string): string | undefined {
  const m = MARKS[agent]
  return m && 'path' in m ? m.path : undefined
}

/** The name a glyph announces: the agent's, "Shell", or the raw key. */
export function agentGlyphLabel(agent?: string, shell = false): string {
  if (shell) return 'Shell'
  return agentName(agent || 'claude')
}

export function AgentGlyph({ agent, shell = false, size = 13 }: { agent?: string; shell?: boolean; size?: number }) {
  const key = shell ? 'shell' : agent || 'claude'
  const label = agentGlyphLabel(agent, shell)
  const mark: Mark = MARKS[key] ?? { draw: 'unknown' }
  let body
  if (key === 'shell') {
    body = <TerminalIcon size={size + 1} />
  } else if ('path' in mark) {
    body = (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ color: mark.color }} className="shrink-0">
        <path d={mark.path} fill="currentColor" />
      </svg>
    )
  } else if (mark.draw === 'codex') {
    body = (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
        <path d="M15.2 9.1a4.2 4.2 0 1 0 0 5.8" />
      </svg>
    )
  } else {
    body = (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
      </svg>
    )
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-agent={key}
      className="inline-flex h-[15px] w-[17px] shrink-0 items-center justify-center text-fg-muted"
    >
      {body}
    </span>
  )
}
