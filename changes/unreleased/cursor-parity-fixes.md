---
kind: Fixed
---
- **cursor:** Cursor turns now carry the model Cursor billed for them, not the
  one its model picker happens to show now: a chat billed to one model files
  every turn under it, and a chat billed to several says the model is not
  known rather than guess. Chats stored before are corrected once on the next
  start, with their total tokens and cost unchanged.
- **cursor:** the Context meter of a Cursor chat reads Cursor's own measure
  of how full the window is (a 1M window in max mode), instead of a figure
  worked out from tokens that were never one request's size.
- **cursor:** Cursor chats now record what each tool call returned, so they
  find the pull requests they opened and the branches they pushed (and with
  them the PR and CI cells), and show failed and rejected tool calls in the
  timeline and loop alerts, as Claude Code sessions do.
