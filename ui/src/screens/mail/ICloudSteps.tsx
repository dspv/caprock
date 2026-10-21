import { openExternal } from '@/lib/nudges'
import { extTitle } from '@/lib/externalLinks'

// iCloud has no sign-in for other mail apps: it takes an app-specific
// password (support.apple.com/102654). The owner, 2026-10-22, translated: he
// did not know which password, and Apple's pages lost him — so the steps are
// three short lines and one button, and the field below takes the code.

export const APPLE_ACCOUNT_URL = 'https://account.apple.com'

/** The three steps to an app-specific password, with the button that opens Apple's page. */
export function ICloudSteps() {
  return (
    <div className="hint steps icloudsteps">
      <b>iCloud needs an app-specific password — not your Apple Account password.</b>
      <ol>
        <li>
          Open account.apple.com and sign in. Apple may ask you to confirm on your iPhone or Mac.{' '}
          <a className="btn small" href={APPLE_ACCOUNT_URL} target="_blank" title={extTitle()} rel="noreferrer"
            onClick={(e) => { e.preventDefault(); openExternal(APPLE_ACCOUNT_URL) }}>Open account.apple.com</a>
        </li>
        <li>Sign-In and Security → App-Specific Passwords → +, and name it Caprock.</li>
        <li>Copy the code Apple shows (four groups of four letters, like abcd-efgh-ijkl-mnop) and paste it below.</li>
      </ol>
    </div>
  )
}
