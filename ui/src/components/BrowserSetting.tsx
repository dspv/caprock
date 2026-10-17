/**
 * Settings → In-app browser (beta, ADR-075): off by default, so nobody gets
 * a webview until they turn it on; the search engine plain text in the
 * address box goes to; and whether a video pauses when an agent needs you.
 * The desktop app's only, and this viewer's (localStorage).
 */
import { Choice, Section, Toggle } from './SettingsParts'
import { SEARCH_ENGINES, useBrowserPrefs } from '@/lib/browsertab'
import { keys } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'

export function BrowserSetting() {
  const [prefs, save] = useBrowserPrefs()
  const mac = isMacPlatform()
  return (
    <Section title="In-app browser (beta)">
      <Toggle
        checked={prefs.on}
        onChange={(on) => save({ on })}
        label="Open web pages in a Caprock tab"
        hint={
          <>
            A browser tab after your agents&rsquo; tabs: <i>New browser tab</i> in {keys('⌘K')}, the + menu{mac ? <> and the app&rsquo;s File menu</> : null}, and <i>Open in Caprock</i> where you choose how a link opens. {mac ? '⌘-click' : 'Ctrl+click'} on a link still opens your default
            browser. Pages keep no cookies or logins once the app quits and get none of Caprock&rsquo;s commands. {keys('⌥←, ⌥→')} move
            between tabs while a browser tab is in front{mac ? ', outside a text field' : ''}.
          </>
        }
      />
      {prefs.on && (
        <>
          <Choice
            label="Search with"
            value={prefs.engine}
            options={SEARCH_ENGINES.map((e) => ({ value: e.id, label: e.name }))}
            onChange={(engine) => save({ engine })}
          />
          <Toggle
            checked={prefs.pause}
            onChange={(pause) => save({ pause })}
            label="Pause a video when an agent needs me"
            hint="When a session starts waiting on you while a browser tab is in front, a strip names it with Go, and whatever plays in the page is paused."
          />
        </>
      )}
      <p className="text-[12px] text-fg-muted">Saved in this app only.</p>
    </Section>
  )
}
