import { Banner, BannerButton } from '@/components/Banner'
import { keys } from '@/lib/appkeys'
import { openMailBrowserWindow } from '@/lib/mailwindow'

/**
 * On top of the Mail tab in a browser (owner, 2026-10-15): Mail is meant to
 * be a window of its own, with nothing of Caprock around it. The button opens
 * `/?mail=1` in a browser window; ⇧⌘M on the app layout's Mail tab does the
 * same, so `shortcut` shows it there (the plain dashboard binds no key). The
 * desktop app never shows this: there Mail opens in its own window directly
 * (lib/mailwindow.ts).
 */
export function MailWindowBanner({ shortcut = true }: { shortcut?: boolean } = {}) {
  return (
    <Banner
      id="mail-window"
      art="mail"
      title="Mail works best in its own window"
      line="The same accounts and mail, without Caprock's sidebar and tabs around it."
      actions={
        <BannerButton onClick={openMailBrowserWindow}>
          Open in its own window{shortcut && <kbd className="mono ml-1.5 font-normal opacity-80">{keys('⇧⌘M')}</kbd>}
        </BannerButton>
      }
    />
  )
}
