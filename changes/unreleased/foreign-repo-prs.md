---
kind: Fixed
---
- **ui:** a pull request a session opened in another repository no longer
  shows as this repository's. The right panel's *Release* and the Work board
  list only the repository's own pull requests; the cockpit's CI block and
  the Pipeline's *This session* list still show it, named with its repository
  before the number (*caprock-web #247*), and the CI line prefers this
  repository's open pull request over it.
