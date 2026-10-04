import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Shows a fixed-size card at whatever width the screen has, without changing
 * the card itself: the export reads the unscaled node, so the PNG is always
 * the full 1200 or 1080 pixels wide.
 */
export function Scaled({ w, h, max, children }: { w: number; h: number; max: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shown = Math.min(width || max, max)
  const scale = shown / w
  return (
    <div ref={box} className="w-full flex justify-center">
      <div style={{ width: shown, height: h * scale, overflow: 'hidden', borderRadius: 12 }} className="shadow-[var(--shadow-panel)]">
        <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  )
}
