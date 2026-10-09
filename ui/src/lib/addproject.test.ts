import { describe, expect, it } from 'vitest'
import { defaultFolder, keyLabel, sheetKey, statWorthy, targetNote, withSlash } from './addproject'
import type { BrowseStat } from './api'

const st = (o: Partial<BrowseStat>): BrowseStat => ({ path: '/x', exists: false, is_dir: false, empty: false, parent_exists: true, ...o })

describe('where the sheet starts', () => {
  it('is the setting, else the home folder', () => {
    expect(defaultFolder(undefined)).toBe('~')
    expect(defaultFolder('  ')).toBe('~')
    expect(defaultFolder('~/dev')).toBe('~/dev')
    expect(withSlash('~')).toBe('~/')
    expect(withSlash('~/dev/')).toBe('~/dev/')
  })
})

describe('what the sheet says under the path', () => {
  it('in Clone: fails on a full folder, uses an empty one, creates a missing one', () => {
    expect(targetNote('clone', st({ exists: true, is_dir: true }))).toEqual({ text: 'exists — not empty, clone will fail', tone: 'bad' })
    expect(targetNote('clone', st({ exists: true, is_dir: true, empty: true }))).toEqual({ text: 'exists, empty — will clone here', tone: 'ok' })
    expect(targetNote('clone', st({}))).toEqual({ text: 'will be created', tone: 'muted' })
    expect(targetNote('clone', st({ exists: true }))?.tone).toBe('bad')
  })
  it('in New project: refuses what exists, and a missing folder above', () => {
    expect(targetNote('new', st({}))).toEqual({ text: 'will be created', tone: 'muted' })
    expect(targetNote('new', st({ exists: true, is_dir: true }))?.tone).toBe('bad')
    expect(targetNote('new', st({ parent_exists: false }))?.text).toBe('the folder above does not exist')
  })
  it('in Existing folder: not a folder, missing, already in Caprock, else nothing', () => {
    expect(targetNote('folder', st({ exists: true }))).toEqual({ text: 'not a folder', tone: 'bad' })
    expect(targetNote('folder', st({}))).toEqual({ text: 'no such folder', tone: 'bad' })
    expect(targetNote('folder', st({ exists: true, is_dir: true, project_id: 3, project_name: 'api' }))).toEqual({ text: 'already in Caprock · api', tone: 'ok' })
    expect(targetNote('folder', st({ exists: true, is_dir: true }))).toBeNull()
  })
  it('says nothing about a guarded place, or before an answer', () => {
    expect(targetNote('clone', st({ guarded: true }))).toBeNull()
    expect(targetNote('clone', null)).toBeNull()
  })
  it('does not ask about a folder still open for a name', () => {
    expect(statWorthy('new', '~/dev/')).toBe(false)
    expect(statWorthy('clone', '~/dev/x')).toBe(true)
    expect(statWorthy('folder', '~/')).toBe(true)
    expect(statWorthy('folder', ' ')).toBe(false)
  })
})

describe('the sheet keys', () => {
  const k = (key: string, o: Partial<KeyboardEvent> = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...o })
  it('are ⌘ on macOS and Ctrl elsewhere', () => {
    expect(sheetKey(k('Enter', { metaKey: true }), true)).toBe('submit')
    expect(sheetKey(k('Enter', { ctrlKey: true }), false)).toBe('submit')
    expect(sheetKey(k('Enter', { ctrlKey: true }), true)).toBeNull()
    expect(sheetKey(k('1', { code: 'Digit1', metaKey: true }), true)).toBe('folder')
    expect(sheetKey(k('2', { code: 'Digit2', ctrlKey: true }), false)).toBe('new')
    expect(sheetKey(k('3', { code: 'Digit3', metaKey: true }), true)).toBe('clone')
    expect(sheetKey(k('b', { code: 'KeyB', metaKey: true }), true)).toBe('toggle-list')
    expect(sheetKey(k('b', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(sheetKey(k('Enter'), true)).toBeNull()
  })
  it('are named for the platform', () => {
    expect(keyLabel('submit', true)).toBe('⌘↩')
    expect(keyLabel('submit', false)).toBe('Ctrl+↵')
    expect(keyLabel('clone', false)).toBe('Ctrl+3')
    expect(keyLabel('esc', true)).toBe('Esc')
  })
})
