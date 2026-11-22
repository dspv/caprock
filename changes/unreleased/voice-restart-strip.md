---
kind: Added
---
- **app:** on macOS, an agent tab whose terminal shows Claude Code's voice
  failing (*No audio detected from microphone*, *Microphone access is
  denied*) gets a strip: *Voice works after restarting this session.* with
  *Restart here*. It ends that Claude Code process and resumes the same
  conversation with `--resume` in the same tab, folder and mode, so a
  terminal opened before the Caprock Terminal helper records again. While the
  agent works it reads *Restart when idle* and restarts once the turn ends;
  × hides it for that session. Never on Windows or Linux, never in a shell
  tab.
