---
kind: Fixed
---
- **telegram:** a module that answers a button press at once keeps its edit.
  The press is written to the module's store before its `✓ <label>` mark is
  put under the message, so a module quick enough to replace the text and
  buttons in that moment could see the late mark put an old button back over
  its new message. The mark now goes only under the buttons that were
  pressed, and a module's edit and a press's mark no longer interleave.
