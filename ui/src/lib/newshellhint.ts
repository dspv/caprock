/**
 * The line under an empty new shell's prompt: what to run there and how to
 * close the tab (owner-approved mockup, 2026-10-22). Drawn over the terminal
 * by TerminalPane, never written into the PTY (rule 7: nothing is typed into
 * a process).
 *
 * A shell is empty while its cursor is still on the prompt's rows: a fresh
 * shell prints its prompt on the first row or two (a "Last login" line
 * above it at most). Anything that moves the cursor further — a command's
 * output, a tab reopened onto a shell with history — means the tab has
 * output, and the line goes for good. So does the first key typed.
 */
import { keys } from './appkeys'

/** The last buffer row (0-based, scrollback included) a fresh shell's prompt may end on. */
export const PROMPT_ROWS = 2

/** The close key, spelled for this OS (⌘W, Ctrl+Shift+W). */
export function newShellCloseKey(isMac?: boolean): string {
  return keys('⌘W', isMac)
}

/** The line as plain text: the accessible name, and what tests read. */
export function newShellHintText(isMac?: boolean): string {
  return `Run claude, codex or any command · ${newShellCloseKey(isMac)} closes this tab`
}

/** True while the shell shows nothing but its prompt: the cursor's buffer row is within PROMPT_ROWS. */
export function onlyPrompt(buffer: { baseY: number; cursorY?: number }): boolean {
  return buffer.baseY + (buffer.cursorY ?? 0) <= PROMPT_ROWS
}
