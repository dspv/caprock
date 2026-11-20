---
kind: Fixed
---
- **setup:** the first **Install** or **Sign in** on a computer with no
  project opens its terminal tab in front. It used to switch to the empty
  projects page while the shell ran out of sight, and only a second click
  showed one; a tab left over from that is restored under Outside projects,
  where it can be seen and closed.
- **projects:** a clone goes into the `dev` folder in your home folder by
  default (`C:\Users\you\dev` on Windows), shown in full in the Clone field
  with "Projects are cloned into this folder; change it here." A default
  folder you set before still wins, the folder is made when missing, the
  wizard's *Clone, or start an empty folder…* opens on Clone, and the setup
  checklist says where clones go.
- **setup:** an agent installed in `~/.local/bin` while that folder is off
  your PATH — what Claude Code's Windows installer warns about — now reads
  "Claude Code is installed, but terminals can't find it", and **Add to
  PATH** types the command that adds that one folder to your user PATH.
  Caprock still runs nothing for you, and the item ticks by itself once the
  folder is on the PATH.
- **setup:** the checklist's agents are switches: a row for each agent
  Caprock can start, switched on (Claude Code and anything already
  installed) or off, and each one on shows its own next step — Install, Add
  to PATH, Sign in — until it is ready. The switches are kept on that
  computer, so your laptop and `caprock setup --agent codex on` see the
  same; a switch never uninstalls anything. A project there is now optional
  ("Projects here", last): the computer is Ready without one.
