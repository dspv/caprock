import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CLOSE_KEY, loadAgentClose, saveAgentClose, useAgentClose } from '@/lib/agentClose'
import { AgentCloseSetting } from './AgentCloseSetting'

beforeEach(() => localStorage.clear())

describe('closing an agent\'s tab, the setting', () => {
  it('asks by default, and reads only the two remembered answers', () => {
    expect(loadAgentClose()).toBe('ask')
    localStorage.setItem(AGENT_CLOSE_KEY, 'end')
    expect(loadAgentClose()).toBe('end')
    localStorage.setItem(AGENT_CLOSE_KEY, 'nonsense')
    expect(loadAgentClose()).toBe('ask')
  })

  it('sets always keep or always end, and back to asking while it works: Settings and the close agree at once', () => {
    const hook = renderHook(() => useAgentClose())
    render(<AgentCloseSetting />)
    expect(screen.getByRole('radio', { name: 'Ask while it works' })).toHaveAttribute('aria-checked', 'true')
    act(() => saveAgentClose('keep'))
    expect(screen.getByRole('radio', { name: 'Keep it running' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Ask while it works' }))
    expect(localStorage.getItem(AGENT_CLOSE_KEY)).toBe('ask')
    expect(hook.result.current[0]).toBe('ask')
  })
})
