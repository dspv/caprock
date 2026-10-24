---
kind: Fixed
---
- **store:** a pull request a script opened or merged now gets the agent cost
  of the session that ran the script. Before, only a `gh pr` command the
  session typed itself counted, so on the PRs & CI board three releases made
  by a release script showed "–". Now GitHub's own opening and merge times are
  matched to the one session in the repository that had a Bash call running at
  that moment. With no such session, or more than one, the pull request stays
  unattributed. Nothing is stored, and every session is still charged once.
