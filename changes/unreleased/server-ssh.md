---
kind: Added
---
- **server:** New server → *I already have a server*: enter its address and
  user (root, or a user with sudo) and press Set up. A terminal tab opens on
  your computer with your own `ssh` command typed in; press Enter, and ssh
  asks for the server's password or uses your key, which Caprock never sees.
  The script runs there with its steps in that tab, turns password login off
  (SSH stays on for keys only), and the server's page opens once it has
  joined. On Windows the command uses Windows' own OpenSSH.
