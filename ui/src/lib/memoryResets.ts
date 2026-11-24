/**
 * Module state kept in this window's memory registers how to forget it here,
 * so the test setup can clear every such cache before each test without
 * importing the modules that hold them (importing them there would bind them
 * to the real `api` before a test file's own `vi.mock` of it).
 */
const resets = new Set<() => void>()

/** Registers a function that forgets a module's kept state. */
export function onMemoryReset(fn: () => void): void {
  resets.add(fn)
}

/** Forgets every registered module's kept state: for tests. */
export function resetMemory(): void {
  for (const fn of resets) fn()
}
