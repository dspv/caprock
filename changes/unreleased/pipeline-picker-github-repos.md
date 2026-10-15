---
kind: Fixed
---
- **pipeline:** the repository picker lists only git repositories on GitHub.
  A folder outside git (a copy in Downloads, a quick chat's folder, the paste
  folder), a repository with no remote and one on another host are no longer
  offered, so picking an entry never ends on "This folder is not a git
  repository with a remote". Two clones of one GitHub repository are one
  entry, and two entries that would read the same word show owner/name, else
  their parent folder. The *N more…* list follows the same rules, and Home's
  Pipeline card picks from the same list. New read: `GET /v1/repos/remotes`.
