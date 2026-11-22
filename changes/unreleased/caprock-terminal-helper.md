---
kind: Fixed
---
- **macos:** voice input in a Caprock terminal no longer loses the
  microphone when Claude Code updates itself, and works from a shell tab.
  Every program in a Caprock terminal now asks macOS as **Caprock
  Terminal**, a small helper app signed with Caprock's Developer ID, so you
  allow the microphone (or a folder) once and the answer stays across
  updates of Caprock and of your agents. Before, macOS asked each program
  itself: Claude Code installs every version at its own path, so each
  update was a new program to macOS, and a shell could not ask at all.
  Terminals that were open before you update keep running as they are;
  open a new one for voice. Homebrew without the app, Windows and Linux are
  unchanged (ADR-101).
