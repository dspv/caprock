# 2026-08-24 — Alex's Windows install captured nothing

Found in a chat log between Alex and his own agent, forwarded by Dima. The
user never filed a report; the bug was read out of a transcript of someone
trying to make the product work.

Covers [FB-001](../01-ledger.md#fb-001--windows-hooks).

## What it looked like

Caprock installed and ran, and captured nothing. No hook ever fired.

Dima's initial read, at the time: *"у него точно мало сессий и он все запускает
из одной папки у всех остальных пока работает корректно это просто конкретный
частный случай"* — few sessions, everything out of one folder, everyone else is
fine, so probably his particular setup.

**That read was wrong, and the way it was wrong is the lesson.** Hook
registration was broken for every Windows install. Nobody else had reported it
because our Windows users are approximately Alex.

## Root cause

Claude Code runs hook commands through a POSIX shell **even on Windows**. The
registration wrote a Windows path with backslashes and quoted it only if it
contained spaces — and Windows program paths usually do not. bash ate every
backslash as an escape, the command never resolved, and the hook silently did
nothing.

Two adjacent defects surfaced in the same investigation, neither reported by
anyone:

- `statusLine.command` was built by a separate copy of the same logic and had
  the identical bug;
- `filepath.Base` uses the host separator, so a Windows registration read on
  another host went unrecognised.

The fix quotes *and* forward-slashes the path — either alone is insufficient —
and is now a single exported function so the two call sites cannot drift again.

Shipped across v0.27.3 and v0.27.4. v0.27.3 carried only part of the fix; the
changelog says so rather than filing the rest under an entry that describes a
fix it does not contain.

## What to carry forward

- A user's agent's chat log is a bug report. This one was better than most
  filed reports: it had the exact command, the exact failure, and the user's
  own attempts.
- "Probably just his setup" is a hypothesis about frequency. With two Windows
  users, the sample cannot distinguish an edge case from a universal break.
