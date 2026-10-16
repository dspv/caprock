// Whether Playwright's own headless shell is installed for this version of
// @playwright/test: exit 0 if so, 1 with the install command if not. `make
// e2e` fails on 1; scripts/pr-check.sh skips the e2e step on it.
//
// It launches the shell for a moment because that is the one check that
// cannot drift from what the tests do. It never looks for, starts or attaches
// to any other browser.
import { chromium } from '@playwright/test'

try {
  const b = await chromium.launch({ headless: true })
  await b.close()
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Executable doesn't exist|install/i.test(msg)) {
    console.error('e2e: Playwright\'s headless shell is not installed. Install it with:')
    console.error('  cd ui && npx playwright install chromium-headless-shell')
  } else {
    console.error(`e2e: the headless shell does not start: ${msg.split('\n')[0]}`)
  }
  process.exit(1)
}
