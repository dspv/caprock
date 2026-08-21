import '@testing-library/jest-dom/vitest'

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
