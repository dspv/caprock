import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AttachPicker } from './AttachPicker'
import { ATTACH_ACCEPT, FILES_ACCEPT, PHOTOS_ACCEPT } from '@/lib/attach'

/** A finger for a pointer, as on a phone or a tablet; or a mouse. */
function pointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: coarse && q.includes('pointer: coarse'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
}

function renderPicker(onFiles = vi.fn()) {
  render(<AttachPicker onFiles={onFiles} testId="pick" className="x">Attach</AttachPicker>)
  return {
    onFiles,
    button: screen.getByRole('button', { name: 'Attach a photo or file' }),
    files: screen.getByTestId('pick') as HTMLInputElement,
    photos: screen.getByTestId('pick-photos') as HTMLInputElement,
  }
}

describe('AttachPicker', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Owner, 2026-11-06: on the phone he could not choose the gallery or his
  // files from iOS's one sheet. Two named choices, each its own picker.
  it('on a touch screen offers Photos and Files, each opening its own picker', () => {
    pointer(true)
    const { button, files, photos } = renderPicker()
    expect(photos.accept).toBe(PHOTOS_ACCEPT)
    expect(files.accept).toBe(FILES_ACCEPT)
    const photoClick = vi.spyOn(photos, 'click')
    const fileClick = vi.spyOn(files, 'click')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual([expect.stringContaining('Photos'), expect.stringContaining('Files')])
    expect(photoClick).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: /Photos/ }))
    expect(photoClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitem', { name: /Files/ }))
    expect(fileClick).toHaveBeenCalledTimes(1)
    expect(photoClick).toHaveBeenCalledTimes(1)
  })

  it('closes the menu on Escape and on a tap outside it', () => {
    pointer(true)
    const { button } = renderPicker()
    fireEvent.click(button)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    fireEvent.click(document.querySelector('.fixed.inset-0')!)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('with a mouse opens the one picker that takes everything, no menu', () => {
    pointer(false)
    const { button, files } = renderPicker()
    expect(files.accept).toBe(ATTACH_ACCEPT)
    const click = vi.spyOn(files, 'click')
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).not.toHaveAttribute('aria-expanded')
  })

  it('hands on what either picker picked, and never sets capture', () => {
    pointer(true)
    const { files, photos, onFiles } = renderPicker()
    expect(photos.hasAttribute('capture')).toBe(false)
    expect(files.hasAttribute('capture')).toBe(false)
    const photo = new File(['x'], 'IMG_0001.jpg', { type: 'image/jpeg' })
    fireEvent.change(photos, { target: { files: [photo] } })
    expect(onFiles).toHaveBeenLastCalledWith([photo])
    const doc = new File(['# plan'], 'plan.md')
    fireEvent.change(files, { target: { files: [doc] } })
    expect(onFiles).toHaveBeenLastCalledWith([doc])
    fireEvent.change(files, { target: { files: [] } })
    expect(onFiles).toHaveBeenCalledTimes(2)
  })
})
