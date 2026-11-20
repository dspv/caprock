---
kind: Added
---
- **computers:** adding a computer that runs agents is a checklist. Choose
  **Run agents for another computer** in Settings → Computers and it lists
  what that computer still needs — Git (on Windows, Claude Code needs it),
  Claude Code or Codex, its sign-in, a project, and the link to your laptop —
  each with one button. Install and Sign in open a terminal tab with the
  command typed for you to run; nothing is installed silently. The list
  ticks itself as each step is done, says "Ready. Start agents from your
  laptop." at the end, and shows on Home while something is left. Beside
  Turn on, one line says the link is end-to-end encrypted and nothing gets
  in until you press Allow. Over SSH (a VPS, a Mac mini with no screen),
  `caprock setup` prints the same list with the command for each step, and
  `caprock setup --link` ends with the one-time link and asks you to allow
  the laptop by name.
- **computers:** on the laptop, each linked computer says whether it is
  ready — online, its agent, signed in, how many projects, its OS and
  memory — with **Start an agent there**, or the one step it still needs.
  A computer can be renamed from the sidebar: right-click it, Rename. The
  role cards now read **Run agents for another computer** and **This is
  where I work**. Something installed after Caprock started is found
  without restarting it (on Windows the PATH is read again from the
  registry).
