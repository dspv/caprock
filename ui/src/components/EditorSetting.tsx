/**
 * Settings → Editor (F18): which editor "Open in editor" uses, among those
 * the daemon found. Stored by the daemon (`editor` in /v1/settings), so the
 * app and the browser agree. Shown only on this machine and only when there
 * is more than nothing to choose from.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { resetEditors, useEditors } from '@/lib/editors'
import { Choice, Section } from './SettingsParts'

export function EditorSetting() {
  const list = useEditors()
  const [error, setError] = useState('')
  if (!list) return null
  const save = async (id: string) => {
    setError('')
    try {
      await api.saveSettings({ editor: id } as Settings)
      resetEditors()
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Section title="Editor">
      <Choice label="Open in" value={list.preferred} options={list.editors.map((e) => ({ value: e.id, label: e.name }))} onChange={(id) => void save(id)} />
      <p className="text-[12px] text-fg-muted">
        What <span className="text-fg">Open in editor</span> uses — in the palette (⌘K), a project&apos;s right-click menu and the inspector.
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
