---
kind: Fixed
---
- **cockpit:** the Release panel's stepper no longer draws the release pull
  request's step as a dashed, punched-out circle with *Tagged* looking further
  along while its checks run. An open release pull request is now the current
  step until it merges, ringed like every current step; the steps after it all
  look the same. The line under it names the pull request and counts its
  checks from the CI section's own read (*#1080 checks running · 6 of 16*),
  and says *reading checks…* rather than *checks not read* before that read.
