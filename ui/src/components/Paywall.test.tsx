/**
 * Where the line between free and paid actually sits.
 *
 * The free product is the whole product for one person, and every paid feature
 * is something that does not exist yet. That means a lock may only ever cover
 * a preview of something unbuilt — the moment one covers something that used
 * to work, the free tier becomes a hostage and the promise on the site becomes
 * a lie.
 *
 * This is the test that notices. It reads the source of the screens rather
 * than rendering them, because the question is not "what does this look like"
 * but "what did somebody decide to put behind glass".
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/** Every `<Locked feature="…">` in a file, with what it wraps. */
function locks(src: string): { feature: string; body: string }[] {
  const out: { feature: string; body: string }[] = []
  const re = /<Locked\s+feature="([a-z]+)"[^>]*>([\s\S]*?)<\/Locked>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push({ feature: m[1]!, body: m[2]! })
  return out
}

const SCREENS = ['screens/Cost.tsx', 'screens/History.tsx', 'screens/Now.tsx', 'screens/Session.tsx']

describe('the paywall', () => {
  it('covers only features that do not exist yet', () => {
    // Every feature named in the modal is marked built or not. A lock over a
    // built one would be taking something away.
    const modal = read('components/PremiumModal.tsx')
    const built = new Set(
      [...modal.matchAll(/(\w+):\s*\{[\s\S]*?built:\s*true/g)].map((m) => m[1]!),
    )
    for (const screen of SCREENS) {
      for (const l of locks(read(screen))) {
        expect(built.has(l.feature), `${screen} locks "${l.feature}", which is marked as built`).toBe(false)
      }
    }
  })

  it('never locks a panel that shows measured data', () => {
    // A preview may describe what a feature will do. It may not hide numbers
    // the free version already computes — that is the one move that turns this
    // from a preview into a hostage.
    const measured = [/fmtUSD\(\s*[a-z]/i, /\.cost_usd/, /\.tokens\b/, /\.sessions\b/]
    for (const screen of SCREENS) {
      for (const l of locks(read(screen))) {
        for (const re of measured) {
          expect(
            re.test(l.body),
            `${screen} locks "${l.feature}" around something that reads live data (${re}) — the free version already shows this`,
          ).toBe(false)
        }
      }
    }
  })

  it('locks each paid feature exactly where it will live', () => {
    // Every feature we charge for has to be visible somewhere, or nobody can
    // see what they would be buying.
    const all = SCREENS.flatMap((s) => locks(read(s)).map((l) => l.feature))
    for (const f of ['cap', 'report', 'providers']) {
      expect(all, `"${f}" is sold but shown nowhere in the product`).toContain(f)
    }
  })
})
