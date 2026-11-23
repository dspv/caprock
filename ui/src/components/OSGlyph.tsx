/**
 * A runner OS as a small monochrome glyph in currentColor (owner,
 * 2026-11-23, variant A1: the M / W / L letters in the per-OS check tiles
 * became the OS's own mark — an apple, four panes, a penguin). Inline paths
 * on a 16-unit grid, simple enough to stay crisp at 11px; no asset is
 * loaded. Decorative: what it stands for is said by the element around it.
 */
export type GlyphOS = 'macos' | 'windows' | 'linux'

const PATHS: Record<GlyphOS, string> = {
  // An apple: the body with its bite, and the leaf.
  macos: 'M11.2 8.6c0-1.6 1.3-2.4 1.4-2.4-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6C4.4 4.9 3 6 3 8.3c0 1.4.5 2.9 1.2 3.9.6.8 1.1 1.6 1.9 1.6.8 0 1.1-.5 2-.5s1.2.5 2 .5c.8 0 1.4-.8 1.9-1.6.4-.6.7-1.2.8-1.6-1-.4-1.6-1.3-1.6-2zM9.7 3.9c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.7.9-.4.4-.7 1.1-.6 1.8.7 0 1.3-.3 1.7-.8z',
  // Four panes.
  windows: 'M2 2h5.5v5.5H2zM8.5 2H14v5.5H8.5zM2 8.5h5.5V14H2zM8.5 8.5H14V14H8.5z',
  // A penguin: the silhouette, its belly and eyes cut out.
  linux: 'M8 1.5c-1.9 0-3 1.5-3 3.4 0 1-.3 1.7-.9 2.6C3.3 8.7 2.5 10 2.5 11.6c0 .6.2 1 .5 1.3-.4.3-.6.7-.4 1.1.3.6 1.3.6 2.4.4.9.6 1.9.9 3 .9s2.1-.3 3-.9c1.1.2 2.1.2 2.4-.4.2-.4 0-.8-.4-1.1.3-.3.5-.7.5-1.3 0-1.6-.8-2.9-1.6-4.1-.6-.9-.9-1.6-.9-2.6 0-1.9-1.1-3.4-3-3.4zM8 7.4c1.3 0 2.2 1.5 2.2 3.4S9.3 13.8 8 13.8s-2.2-1.1-2.2-3S6.7 7.4 8 7.4zM6.9 4.1a.65.65 0 1 0 0 1.3.65.65 0 0 0 0-1.3zM9.1 4.1a.65.65 0 1 0 0 1.3.65.65 0 0 0 0-1.3z',
}

export function OSGlyph({ os, size = 11, className = '' }: { os: GlyphOS; size?: number; className?: string }) {
  return (
    <svg data-os-glyph={os} width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false" className={className}>
      <path d={PATHS[os]} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}
