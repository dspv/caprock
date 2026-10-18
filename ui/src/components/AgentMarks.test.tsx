import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentGlyph, agentMarkPath, CODEX_MARK_PATH } from './AgentMarks'
import { BLOSSOM_BOX, BLOSSOM_PATH } from './OpenAIBlossom'
import { markColour } from './ShareCard'
import { Body } from './Characters'

describe('Codex and ChatGPT identities', () => {
  it('keeps them distinct and names each glyph accessibly', () => {
    render(<><AgentGlyph agent="codex" /><AgentGlyph agent="chatgpt" /></>)
    const codex = screen.getByRole('img', { name: /^Codex$/ })
    const chatgpt = screen.getByRole('img', { name: /^ChatGPT$/ })
    expect(codex.querySelector('path')).toHaveAttribute('fill', 'none')
    expect(codex.querySelector('path')).toHaveAttribute('d', CODEX_MARK_PATH)
    expect(chatgpt.querySelector('path')).toHaveAttribute('d', BLOSSOM_PATH)
    expect(chatgpt.querySelector('path')).toHaveAttribute('fill', 'currentColor')
    expect(agentMarkPath('codex')).toMatchObject({ path: CODEX_MARK_PATH, stroke: true, box: { size: 24 } })
    expect(agentMarkPath('chatgpt')).toMatchObject({ path: BLOSSOM_PATH, box: BLOSSOM_BOX })
    expect(markColour('chatgpt', 'paper')).toBe('#000000')
    expect(markColour('chatgpt', 'dark')).toBe('#ffffff')
  })

  it('restores the terminal character without putting a face on the company mark', () => {
    const { container } = render(<svg><Body who="codex" /></svg>)
    expect([...container.querySelectorAll('path')].some((p) => p.getAttribute('d') === BLOSSOM_PATH)).toBe(false)
    expect(container.querySelector('path[d="M24 42l7 5-7 5"]')).not.toBeNull()
  })
})
