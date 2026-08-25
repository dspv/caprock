/**
 * The footer, and the one thing it sells.
 *
 * A person reading this has their own numbers on screen — they know what a
 * month of their sessions costs, because Caprock just told them. That is the
 * moment where "the same, for your team" needs no explanation, and it is the
 * only place in the product where asking for anything is fair: they got the
 * thing they installed first.
 *
 * Deliberately a footer rather than a banner, a modal or a strip at the top.
 * The free product is not a trial and must never behave like one — nothing
 * here interrupts, blocks or reappears. Someone who never scrolls to the
 * bottom never sees it, which is the correct outcome for someone who does not
 * want it.
 */

import { useState } from 'react'

const REPO = 'https://github.com/dspv/caprock'
const TEAMS = 'https://caprock.dev/teams'
const PREMIUM = 'https://caprock.dev/premium'
const STAR_KEY = 'caprock.footer.starred'

export function SiteFooter() {
  // Remembered so the ask stops once it has been acted on. A prompt that keeps
  // asking after you have done the thing is how a footer becomes noise.
  const [starred, setStarred] = useState(
    () => localStorage.getItem(STAR_KEY) === '1',
  )

  return (
    <footer className="mt-6 border-t border-border">
      <div className="max-w-[1600px] mx-auto px-3 py-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-[11px] text-fg-faint">
        {/* The team line leads: it is the only thing here that is not already
          * available from the dashboard itself. */}
        <a
          href={TEAMS}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-2 no-underline"
        >
          <span className="text-fg-muted group-hover:text-fg">
            Want this for your team?
          </span>
          <span className="text-accent group-hover:text-accent-strong">
            Caprock for Teams →
          </span>
        </a>

        <span className="ml-auto inline-flex items-center gap-4">
          {/* Legible, but still not a second offer: the team line above keeps
            * the accent colour and the arrow, this one reads at the weight of
            * the links beside it. Phrased as a place rather than a question —
            * "what should paid add?" was both too quiet to read and too vague
            * to act on, since nothing said where it led. */}
          <a
            href={PREMIUM}
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted hover:text-fg no-underline"
            title="Nothing is built yet — the page asks what a paid tier should contain"
          >
            premium
          </a>
          {!starred && (
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                localStorage.setItem(STAR_KEY, '1')
                setStarred(true)
              }}
              className="text-fg-faint hover:text-fg no-underline"
              title="Opens GitHub in a new tab"
            >
              ★ star on GitHub
            </a>
          )}
          <a
            href="https://caprock.dev/blog"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg no-underline"
          >
            blog
          </a>
          <a
            href="https://caprock.dev/docs"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg no-underline"
          >
            docs
          </a>
        </span>
      </div>
    </footer>
  )
}
