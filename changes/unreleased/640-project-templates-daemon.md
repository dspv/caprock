---
kind: Added
---
- **projects:** start a project from a template — the daemon side; the
  screen comes next. Add your own template (a GitHub template repository,
  a folder, or both) with where its brief goes and the agent's first
  prompt; Caprock reads its `TEMPLATE.md` to fill those in. Making a
  project from it runs your own `gh` on your click (`gh repo create
  --template`, then `gh repo clone`), or copies the folder's last commit
  into a new repository when you pick the local copy, then writes your
  brief and commits it — never pushed. A failure takes away only the
  folder Caprock made and never deletes a repository on GitHub; Retry
  picks up where it stopped (ADR-065).
