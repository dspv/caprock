/**
 * Nothing is locked.
 *
 * Caprock has no paid plan for one person (owner, 2026-11-27, translated:
 * "nobody paid, I gave everyone keys free"; ADR-022 amended). Paid is the
 * team tier alone, sold from its own card and dialog. This test reads the
 * source rather than rendering it, because the question is what somebody put
 * in, not what one screen looks like: no lock, no Premium dialog, no header
 * chip, no licence field, no call to /v1/premium.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('nothing is locked', () => {
  const files = sources(SRC).map((p) => ({ path: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

  it('has no lock, Premium dialog, header chip or licence field', () => {
    const gone = ['components/Locked.tsx', 'components/PremiumModal.tsx', 'components/PremiumChip.tsx',
      'components/PremiumHint.tsx', 'components/PremiumBanner.tsx', 'components/LicenseField.tsx']
    for (const f of gone) expect(files.some((x) => x.path === f), `${f} is back`).toBe(false)
    for (const { path, text } of files) {
      expect(text, `${path} draws a lock`).not.toMatch(/<Locked\b/)
      expect(text, `${path} opens a Premium dialog`).not.toMatch(/<Premium(Modal|Chip|Hint|Banner)\b/)
      expect(text, `${path} asks for a licence`).not.toMatch(/useLicensed\(|['"]\/v1\/premium['"]|api\.premium\(/)
    }
  })

  it('sells nothing for one person in any text a reader sees', () => {
    for (const { path, text } of files) {
      expect(text, `${path} sells Premium`).not.toMatch(/Get premium|Unlock with Premium|in Premium\b|Part of Premium/)
    }
  })
})
