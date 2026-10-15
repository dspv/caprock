/** When the app may restart into an update on its own (Update automatically). */
import { afterEach, describe, expect, it } from 'vitest'
import { IDLE_MS, UPDATED_KEY, blockerText, hasDraft, rememberAutoInstall, restartBlocker, takeUpdatedNote, type RestartState } from './autoupdate'

const now = 1_800_000_000_000
const quiet: RestartState = { working: 0, idleMs: IDLE_MS, draft: false, now, postponedUntil: 0 }

describe('the safe-to-restart rule', () => {
  it('restarts only when nothing is busy, the user is away and nothing is typed', () => {
    expect(restartBlocker(quiet)).toBeNull()
  })

  it('waits for an agent that works or waits on a permission prompt', () => {
    // The daemon's count covers both: a turn in progress and an open prompt.
    expect(restartBlocker({ ...quiet, working: 1 })).toEqual({ kind: 'busy', working: 1 })
    expect(blockerText({ kind: 'busy', working: 3 })).toMatch(/3 agents/)
  })

  it('treats a count it could not read as busy', () => {
    expect(restartBlocker({ ...quiet, working: undefined })?.kind).toBe('unknown')
  })

  it('waits until the user has left the app alone for two minutes', () => {
    expect(IDLE_MS).toBe(120_000)
    expect(restartBlocker({ ...quiet, idleMs: IDLE_MS - 1 })?.kind).toBe('active')
  })

  it('waits while something typed is not sent', () => {
    expect(restartBlocker({ ...quiet, draft: true })?.kind).toBe('draft')
  })

  it('holds back a version the user said Not now to, until the hour is up', () => {
    expect(restartBlocker({ ...quiet, postponedUntil: now + 1 })?.kind).toBe('postponed')
    expect(restartBlocker({ ...quiet, postponedUntil: now })).toBeNull()
  })
})

describe('a draft', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('is text in a text area or an editable block', () => {
    document.body.innerHTML = '<textarea></textarea>'
    expect(hasDraft()).toBe(false)
    document.querySelector('textarea')!.value = 'fix the flaky test'
    expect(hasDraft()).toBe(true)
    document.body.innerHTML = '<div contenteditable="true">half a sentence</div>'
    expect(hasDraft()).toBe(true)
  })

  it('is not the terminal’s own input, nor a filter left in a search box', () => {
    // What is typed into a terminal lives in the session's process.
    document.body.innerHTML = '<textarea class="xterm-helper-textarea"></textarea><input type="search">'
    document.querySelector('textarea')!.value = 'ls'
    document.querySelector('input')!.value = 'caprock'
    expect(hasDraft()).toBe(false)
    // Focused, the same input is being typed into.
    document.querySelector('input')!.focus()
    expect(hasDraft()).toBe(true)
  })
})

describe('the note after an automatic update', () => {
  afterEach(() => localStorage.clear())

  it('is shown once, by the version it installed', () => {
    rememberAutoInstall('0.80.0')
    expect(localStorage.getItem(UPDATED_KEY)).toBe('v0.80.0')
    expect(takeUpdatedNote('0.79.0')).toBeNull() // the install did not happen yet
    expect(localStorage.getItem(UPDATED_KEY)).toBe('v0.80.0')
    expect(takeUpdatedNote('0.80.0')).toBe('v0.80.0')
    expect(takeUpdatedNote('0.80.0')).toBeNull()
  })

  it('is dropped when a later version is already running', () => {
    rememberAutoInstall('0.80.0')
    expect(takeUpdatedNote('0.81.0')).toBeNull()
    expect(localStorage.getItem(UPDATED_KEY)).toBeNull()
  })
})
