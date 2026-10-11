/**
 * The banner system: one shape for every offer and notice, and the short
 * figures it quotes.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Banner, BannerArt, BannerButton, BannerDismiss, Fig, type Scene } from './Banner'
import { fmtUSDShort } from '@/lib/format'

describe('Banner', () => {
  it('draws a scene, a title, one line and its actions', () => {
    const go = vi.fn()
    const later = vi.fn()
    const { container } = render(
      <Banner id="t" tone="premium" art="cap" title={<><Fig title="$16,820.12">$16.8k</Fig> all time</>} line="One idea."
        actions={<><BannerButton kind="premium" onClick={go}>Go</BannerButton><BannerDismiss onClick={later}>Not now</BannerDismiss></>} />,
    )
    const el = container.querySelector('[data-banner="t"]')!
    expect(el.getAttribute('data-tone')).toBe('premium')
    // The picture is decoration: the words say what it is about.
    expect(el.querySelector('.bn-art')!.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('.bn-art svg')).toBeTruthy()
    expect(screen.getByText('$16.8k').getAttribute('title')).toBe('$16,820.12')
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(go).toHaveBeenCalledOnce()
    expect(later).toHaveBeenCalledOnce()
  })

  it('has an edge form for strips, and a × dismiss with a name', () => {
    const { container } = render(<Banner id="s" edge art="star" title="Enjoying Caprock?" actions={<BannerDismiss icon aria-label="Hide for a month" />} />)
    expect(container.querySelector('[data-banner="s"]')!.hasAttribute('data-edge')).toBe(true)
    expect(screen.getByRole('button', { name: 'Hide for a month' }).textContent).toBe('×')
  })

  it('draws every scene', () => {
    const scenes: Scene[] = ['team', 'cap', 'window', 'phone', 'star', 'update', 'hooks', 'done', 'lock', 'plan']
    for (const s of scenes) {
      const { container, unmount } = render(<BannerArt scene={s} />)
      expect(container.querySelector('svg')!.children.length, s).toBeGreaterThan(0)
      unmount()
    }
  })
})

describe('fmtUSDShort', () => {
  it('drops cents and goes to k and M', () => {
    expect(fmtUSDShort(16820.12)).toBe('$16.8k')
    expect(fmtUSDShort(1354.59)).toBe('$1.4k')
    expect(fmtUSDShort(2000)).toBe('$2k')
    expect(fmtUSDShort(168_400)).toBe('$168k')
    expect(fmtUSDShort(1_240_000)).toBe('$1.2M')
    expect(fmtUSDShort(135.46)).toBe('$135')
    expect(fmtUSDShort(0.42)).toBe('$0.42')
    expect(fmtUSDShort(undefined)).toBe('—')
  })
})
