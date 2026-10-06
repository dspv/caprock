import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

// jsdom implements neither ResizeObserver nor a canvas 2D context, and the
// dashboard's canvas components (Pulse, the Projects sparkline) construct a
// ResizeObserver in an effect. Without a stub that throws inside React's commit
// phase and fails the test for a reason unrelated to what it asserts.
//
// The stub is inert on purpose: it never fires. The components paint once
// before observing, so the picture under test is the one the data produced, and
// nothing here can invent a resize the browser did not report.
if (!('ResizeObserver' in globalThis)) {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver
}

// jsdom is shared by every test in a file, and so is its storage. What one
// test left there — a kept copy of a session (lib/swr.ts), a workspace, a
// device token — was what the next test's first render showed, so a test's
// outcome depended on the one before it. Every test starts from empty storage;
// one that needs something there puts it there.
beforeEach(() => {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* no storage in this environment */
  }
})
