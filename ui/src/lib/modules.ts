/**
 * Private modules (ADR-076): which ones this machine's admin key opens, and
 * the app's theme handed to a module's page so it reads as one more screen.
 *
 * Without a valid key the list is empty and nothing anywhere draws a row, a
 * tab or a hint for it. A paired device asks only while it is a controller
 * (ADR-076 amended 2026-10-21); a viewer never sees a module.
 */
import { useEffect, useState } from 'react'
import { api, isPairedDevice, type AdminState, type ModuleInfo } from './api'
import { setModuleKeyCount } from './appkeys'
import { useCanControl } from './useCanControl'

/** Sent on this window when the admin key changes, so every list asks again. */
export const ADMIN_EVENT = 'caprock-admin-change'

let known: ModuleInfo[] = []

/** Keeps the list the sidebar draws, and the keys that open its rows (appkeys moduleKey). */
function remember(list: ModuleInfo[]): void {
  known = list
  setModuleKeyCount(list.length)
}

/** The module at a place in the sidebar, for its key; undefined past the end. */
export function moduleAt(index: number): ModuleInfo | undefined {
  return known[index]
}

/** The module's name as the last answer gave it; the id until one has. */
export function moduleName(id: string): string {
  return known.find((m) => m.id === id)?.name ?? id
}

/** Says an admin key was stored or cleared, with the daemon's answer. */
export function announceAdmin(st: AdminState): void {
  remember(st.installed ?? [])
  window.dispatchEvent(new CustomEvent<AdminState>(ADMIN_EVENT, { detail: st }))
}

/** The admin state, asked once and again whenever the key changes. */
export function useAdmin(): AdminState | undefined {
  const [st, setSt] = useState<AdminState>()
  // Always on the machine; on a phone only while it holds control, and the
  // list goes when control is taken away.
  const may = useCanControl()
  useEffect(() => {
    if (!may) {
      if (isPairedDevice()) {
        remember([])
        setSt(undefined)
      }
      return
    }
    let live = true
    const ask = () => {
      api.admin().then((a) => {
        if (!live) return
        remember(a.installed ?? [])
        setSt(a)
      }).catch(() => { /* an older daemon, or none: no modules */ })
    }
    ask()
    const on = (e: Event) => setSt((e as CustomEvent<AdminState>).detail)
    window.addEventListener(ADMIN_EVENT, on)
    return () => {
      live = false
      window.removeEventListener(ADMIN_EVENT, on)
    }
  }, [may])
  return st
}

/** The installed modules the key opens; empty without one. */
export function useModules(): ModuleInfo[] {
  return useAdmin()?.installed ?? []
}

/** The theme as a module sees it: light or dark, and every colour and font token. */
export interface ModuleTheme {
  theme: 'light' | 'dark'
  vars: Record<string, string>
}

let tokenNames: string[] | undefined

/** The design tokens' names, read once from the page's own style sheets. */
function themeTokenNames(): string[] {
  if (tokenNames) return tokenNames
  const names = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      const style = (r as CSSStyleRule).style
      if (style) {
        for (let i = 0; i < style.length; i++) {
          const n = style.item(i)
          if (n.startsWith('--color-') || n.startsWith('--font-')) names.add(n)
        }
      }
      const inner = (r as CSSGroupingRule).cssRules
      if (inner) walk(inner)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try { walk(sheet.cssRules) } catch { /* a sheet from another origin */ }
  }
  tokenNames = [...names].sort()
  return tokenNames
}

/** What the page shows now, for a module's page. */
export function moduleTheme(): ModuleTheme {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const n of themeTokenNames()) {
    const v = css.getPropertyValue(n).trim()
    if (v) vars[n] = v
  }
  return { theme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark', vars }
}

/**
 * Puts the theme on a module's page: data-theme, color-scheme and every token
 * as a custom property on its <html>, so a module written against the same
 * names (var(--color-bg), var(--color-accent)) is drawn in the app's palette
 * without doing anything. It is told too, for one that wants to react.
 *
 * A sandboxed frame (a phone's, lib/modulebridge.ts) has an opaque origin: the
 * page cannot be reached into and its origin cannot be named, so it is only
 * told, and its bootstrap puts the theme on <html> itself.
 */
export function applyModuleTheme(frame: HTMLIFrameElement, t: ModuleTheme = moduleTheme(), sandboxed = false): void {
  if (sandboxed) {
    frame.contentWindow?.postMessage({ type: 'caprock:theme', ...t }, '*')
    return
  }
  try {
    const el = frame.contentDocument?.documentElement
    if (el) {
      el.setAttribute('data-theme', t.theme)
      el.style.colorScheme = t.theme
      for (const [k, v] of Object.entries(t.vars)) el.style.setProperty(k, v)
    }
  } catch { /* not the same origin: the message below still arrives */ }
  frame.contentWindow?.postMessage({ type: 'caprock:theme', ...t }, location.origin)
}
