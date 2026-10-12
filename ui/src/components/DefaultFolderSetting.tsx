/**
 * Settings → Projects: the default folder (owner, 2026-10-09). Where the Add
 * project sheet starts — its folder field, a new project's parent, a clone's
 * destination and the folder browser. Stored by the daemon
 * (`default_folder` in /v1/settings), so the app and the browser agree; empty
 * is the home folder. The sheet's *Set as default* writes the same field.
 * The new-session search also lists the git repositories under it
 * (`/v1/browse/repos`).
 *
 * Tester, 2026-10-12 (translated): "it seems you could add more project
 * folders… not obvious why it's needed." It reads like a list of where
 * projects live, which it is not: projects come from sessions and from any
 * folder added. So the label names what it is — where your code is kept —
 * and the help says what it does and what it does not limit.
 */
import { useEffect, useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section } from './SettingsParts'

export function DefaultFolderSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const saved = settings.data?.default_folder ?? ''
  const [value, setValue] = useState(saved)
  const [state, setState] = useState<'' | 'saved' | string>('')
  useEffect(() => { setValue(saved) }, [saved])
  const save = async () => {
    setState('')
    try {
      await api.saveSettings({ default_folder: value.trim() } as Settings)
      setState('saved')
      settings.refresh()
    } catch (e) {
      setState(errText(e))
    }
  }
  return (
    <Section title="Projects">
      <label className="grid min-w-0 gap-1">
        <span className="text-[12px] text-fg-muted">Where you keep your code</span>
        <div className="flex min-w-0 gap-2">
          <input
            className="input min-w-0 flex-1"
            placeholder="~ (your home folder)"
            spellCheck={false}
            value={value}
            onChange={(e) => { setValue(e.target.value); setState('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          />
          <button type="button" disabled={value.trim() === saved} onClick={() => void save()} className="shrink-0 rounded-[var(--radius-control,6px)] border border-border-strong px-3 text-[13px] text-fg disabled:opacity-50">
            Save
          </button>
        </div>
      </label>
      <p className="text-[12px] text-fg-muted">
        One folder, like <span className="mono">~/dev</span>. <span className="text-fg">Add project</span> and Browse open there, and
        a new session suggests the git repositories inside it. It limits nothing: every folder you run an agent in, or add,
        is a project wherever it is. Empty is your home folder.
      </p>
      {state === 'saved' && <p className="text-[12px] text-fg-muted">Saved.</p>}
      {state && state !== 'saved' && <p className="text-[12px] text-danger">{state}</p>}
    </Section>
  )
}
