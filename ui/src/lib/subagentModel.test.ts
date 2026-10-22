import { beforeEach, describe, expect, it } from 'vitest'
import { SUBAGENT_MODELS, defaultSubagentModel, rememberSubagentModel, rememberedSubagentModel, setDefaultSubagentModel, subagentModelLabel } from './subagentModel'

describe('subagent model choice', () => {
  beforeEach(() => localStorage.clear())

  it('offers the session default first and the three families', () => {
    expect(SUBAGENT_MODELS.map((m) => m.value)).toEqual(['', 'haiku', 'sonnet', 'opus'])
    expect(SUBAGENT_MODELS[0]!.label).toBe('Same as the session')
  })

  it('remembers the last choice per project, and forgets the default', () => {
    rememberSubagentModel('1', 'haiku')
    rememberSubagentModel('2', 'opus')
    expect(rememberedSubagentModel('1')).toBe('haiku')
    expect(rememberedSubagentModel('2')).toBe('opus')
    expect(rememberedSubagentModel('3')).toBe('')
    rememberSubagentModel('1', '')
    expect(rememberedSubagentModel('1')).toBe('')
  })

  it('ignores a stored value that is not on the list', () => {
    localStorage.setItem('caprock.subagentmodel.1', 'gpt-5')
    expect(rememberedSubagentModel('1')).toBe('')
  })

  it('starts a project with no choice on the default, and keeps a project that chose otherwise', () => {
    rememberSubagentModel('2', '')
    rememberSubagentModel('3', 'opus')
    setDefaultSubagentModel('haiku')
    expect(defaultSubagentModel()).toBe('haiku')
    expect(rememberedSubagentModel('1')).toBe('haiku')
    expect(rememberedSubagentModel('2')).toBe('haiku') // it chose the then-default, so nothing was stored
    expect(rememberedSubagentModel('3')).toBe('opus')
    rememberSubagentModel('2', '')
    expect(rememberedSubagentModel('2')).toBe('')
    setDefaultSubagentModel('')
    expect(rememberedSubagentModel('1')).toBe('')
    expect(rememberedSubagentModel('3')).toBe('opus')
  })

  it('labels a chosen model for the session card, and nothing for the default', () => {
    expect(subagentModelLabel('haiku')).toBe('Haiku')
    expect(subagentModelLabel('')).toBe('')
    expect(subagentModelLabel(undefined)).toBe('')
  })
})
