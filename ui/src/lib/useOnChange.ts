/**
 * Runs `fn` after a render in which `value` changed — never on the first
 * mount, and never when a view kept hidden (components/KeptViews, React's
 * Activity) mounts its effects again with the same value. For state that
 * belongs to one session and is cleared when the component is reused for
 * another: an effect on `[sessionId]` alone also ran on that re-show and
 * blanked what the kept view was holding.
 */
import { useEffect, useRef } from 'react'

export function useOnChange(value: unknown, fn: () => void): void {
  const prev = useRef(value)
  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    fn()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
}
