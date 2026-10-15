import { useEffect } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { MailScreen } from './MailScreen'

/**
 * Mail on its own (`?mail=1`): the whole window is the inbox, with none of
 * Caprock around it. The Mac preview of Caprock Mail (app/mail-mac) opens it
 * on the running daemon, so accounts and mail are the same as in Caprock's
 * Mail tab.
 */
export default function MailApp() {
  useEffect(() => { document.title = 'Caprock Mail' }, [])
  return (
    <div data-mail-view className="fixed inset-0 bg-bg">
      <ErrorBoundary label="Mail">
        <MailScreen fill />
      </ErrorBoundary>
    </div>
  )
}
