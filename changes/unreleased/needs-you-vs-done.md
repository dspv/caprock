---
kind: Changed
---
- **attention:** a session whose turn ended is now either **Needs you** or
  **Done**. Needs you is a permission prompt, a question, a plan to approve
  (ExitPlanMode, which now says so), a turn that stopped on an error (a
  StopFailure such as a rate limit, which used to read "working", then
  "idle"), or a last message that asks you something (a guess, marked with a
  dashed GUESS chip). Done is a turn whose last message asks nothing: it stays
  listed, quieter, and is never counted in the badge, the tray head or the
  phone's amber card. Home, the sidebar, the tray popover and menu (Done in
  its own submenu) and the phone home all show it; *needs me?* and *not
  needed* move a guess until the session's next turn.
- **notifications:** a turn that ends on a question is *Needs your answer*
  instead of *Finished*, and a Done turn raises no OS notification. Telegram
  still sends *Finished* for Done turns, unless the new *Also when it asked
  nothing (Done)* switch is turned off.
