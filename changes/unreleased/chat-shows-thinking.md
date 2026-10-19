---
kind: Fixed
---
- **chat:** a reply now shows the moment it is written. Claude Code writes a
  reply's thinking first and its words on a later line of the same message;
  the daemon merged those words into the stored turn without telling the live
  feed, so a chat showed the turn's cost and no answer until it was opened
  again. Measured on a preview daemon: never within 30 s before, 108 ms now.
  The merge is now an `event_update` frame, and the chat replaces the reply in
  place.
- **chat:** a chat says when its agent is at work: *Claude is thinking…* with
  a clock from your message, the call it runs (*Running npm test*, *Reading
  main.go*), or *Waiting for your permission* with the Yes / No card under
  the conversation, on the desktop, in the app's chat tab and on the phone.
  A quick chat runs in the default permission mode, so a web fetch or a
  command could stall it on a prompt the chat never showed.
- **chat:** what you send shows at once as your bubble, *Sending…* then
  *Sent ✓*, until the session's own record of it arrives; one the daemon
  refused reads *Not sent* with Retry. Before, nothing showed until the
  transcript caught up, so a message to a busy session looked lost.
- **chat:** text you pasted shows as a quiet *Pasted · N lines* block, folded
  past six lines, instead of Claude Code's raw `<pasted_content>` tags; a
  `<system-reminder>` inside a prompt is left out.
