/**
 * The first n characters of a string as a string of their own.
 *
 * `s.slice(0, n)` does not copy: V8 and JavaScriptCore return a view that
 * keeps the whole parent string alive, so 200 characters cut from a 100 KB
 * file body held in a list hold the 100 KB (measured in V8: 200 such slices
 * kept 33 MB). A JSON round trip makes a fresh string with nothing behind it.
 * Use it where a clipped string outlives the object it was cut from.
 */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return JSON.parse(JSON.stringify(s.slice(0, n))) as string
}
