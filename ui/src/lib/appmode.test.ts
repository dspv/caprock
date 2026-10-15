import { describe, expect, it } from 'vitest'
import { isMailApp } from './appmode'

describe('isMailApp', () => {
  it('is on for ?mail=1 and ?mail=true only', () => {
    expect(isMailApp('?mail=1')).toBe(true)
    expect(isMailApp('?mail=true')).toBe(true)
    expect(isMailApp('?app=1&mail=1')).toBe(true)
    expect(isMailApp('')).toBe(false)
    expect(isMailApp('?mail=0')).toBe(false)
    expect(isMailApp('?app=1')).toBe(false)
  })
})
