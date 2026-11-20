/**
 * The Permissions picker on the new-agent sheets (owner, 2026-11-20): three
 * segments, left to right more on its own, the chosen one checked, what to
 * expect under each name in the chosen agent's words, and a radiogroup on the
 * keyboard.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { SpawnAgent } from './AgentPicker'
import { PermissionPicker } from './PermissionPicker'

function Harness({ start, agent = 'claude', opencodeVersion }: { start: string; agent?: SpawnAgent; opencodeVersion?: string }) {
  const [mode, setMode] = useState(start)
  return (
    <>
      <PermissionPicker value={mode} onChange={setMode} agent={agent} opencodeVersion={opencodeVersion} hint="kept for the next agent" />
      <output data-testid="held">{mode}</output>
    </>
  )
}

const group = () => screen.getByRole('radiogroup', { name: 'Permissions' })
const radios = () => within(group()).getAllByRole('radio')
const checked = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true')
const held = () => screen.getByTestId('held').textContent

describe('the Permissions picker', () => {
  it('shows all three at once, safest first, with the held one checked', () => {
    render(<Harness start="bypassPermissions" />)
    expect(radios().map((r) => r.getAttribute('data-mode'))).toEqual(['plan', 'acceptEdits', 'bypassPermissions'])
    expect(checked().map((r) => r.getAttribute('data-mode'))).toEqual(['bypassPermissions'])
    // The accessible name says the mode and what to expect.
    expect(radios().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Plan: changes nothing',
      'Accept edits: asks before commands',
      'Bypass: never asks',
    ])
    expect(within(radios()[0]!).getByText('●○○')).toBeTruthy()
    expect(within(radios()[2]!).getByText('●●●')).toBeTruthy()
    expect(screen.getByText('more on its own →')).toBeTruthy()
    expect(screen.getByText('kept for the next agent')).toBeTruthy()
  })

  it('picks on a click', () => {
    render(<Harness start="acceptEdits" />)
    fireEvent.click(radios()[0]!)
    expect(held()).toBe('plan')
    expect(checked()[0]!.getAttribute('data-mode')).toBe('plan')
  })

  it('is one Tab stop, and the arrow keys move and pick, wrapping round', () => {
    render(<Harness start="acceptEdits" />)
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    const at = radios()[1]!
    at.focus()
    fireEvent.keyDown(at, { key: 'ArrowRight' })
    expect(held()).toBe('bypassPermissions')
    expect(document.activeElement).toBe(radios()[2])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(held()).toBe('plan')
    expect(document.activeElement).toBe(radios()[0])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(held()).toBe('bypassPermissions')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(held()).toBe('acceptEdits')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(held()).toBe('plan')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(held()).toBe('bypassPermissions')
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0])
  })

  it('leaves a chord with a modifier alone', () => {
    render(<Harness start="acceptEdits" />)
    const at = radios()[1]!
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      fireEvent.keyDown(at, { key: 'ArrowRight', ...mod })
    }
    expect(held()).toBe('acceptEdits')
  })

  it.each([
    ['codex', undefined, ['read-only sandbox', 'sandbox, asks first', 'no sandbox, never asks'], 'Bypass · no sandbox, never asks'],
    ['opencode', '1.15.10', ['its plan agent', 'asks before commands', "OpenCode's own rules"], "Bypass · OpenCode's own rules"],
    ['opencode', '2.0.26', ['its plan agent', 'asks before commands', "approves what it doesn't deny"], "Bypass · approves all it doesn't deny"],
    ['hermes', undefined, ['no plan mode: asks', 'asks before risky ones', '--yolo, never asks'], 'Bypass · --yolo, never asks'],
    ['cursor', undefined, ['no plan flag: asks', 'asks before commands', "runs what isn't denied"], 'Bypass · --force, runs what is not denied'],
  ] as const)('says what each mode becomes in %s %s, short, with the whole wording on hover', (agent, version, lines, bypassTitle) => {
    render(<Harness start="acceptEdits" agent={agent} opencodeVersion={version} />)
    expect(radios().map((r) => r.lastElementChild?.textContent)).toEqual(lines)
    expect(radios()[2]!.title).toBe(bypassTitle)
    // The name keeps the agent's own wording, which can say more than the line.
    expect(radios()[2]!.getAttribute('aria-label')).toBe(`Bypass: ${bypassTitle.split(' · ')[1]}`)
  })

  it('still shows a held mode the three do not list, under the control', () => {
    render(<Harness start="auto" />)
    expect(checked()).toEqual([])
    const line = screen.getByText(/pick one above to change it/)
    expect(line.textContent).toBe('Starts in auto mode · pick one above to change it')
    expect(group().getAttribute('aria-describedby')).toBe(line.id)
    // No radio is checked, so the first is the Tab stop, and the arrows start there.
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1])
    radios()[0]!.focus()
    fireEvent.keyDown(radios()[0]!, { key: 'ArrowRight' })
    expect(held()).toBe('acceptEdits')
    expect(screen.queryByText(/pick one above/)).toBeNull()
  })

  it('says when Gemini has no counterpart for a held mode', () => {
    render(<Harness start="dontAsk" agent="gemini" />)
    expect(screen.getByText(/pick one above/).textContent).toBe("Starts in don't ask (Gemini asks instead) · pick one above to change it")
  })
})
