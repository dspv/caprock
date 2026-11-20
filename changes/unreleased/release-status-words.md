---
kind: Changed
---
- **cockpit:** the Release section says its status in plain words and one
  colour: *Ready to release · not started* in grey when the changes are
  merged and nobody has started the release, *Waiting for #949 to merge* in
  amber, *Releasing · checks 1 of 3 systems* in blue with a pulsing dot,
  *Release stopped · checks failed* in red, *Released · 5 min ago* in green.
  A grey "not started" was drawn amber before and read as a release under
  way. The heading names the number (*Next release 0.185.1 · patch · last
  release 2h ago*, *Releasing 0.185.1*, *0.185.1 released*), each dot says
  its stage and state on hover (*Release PR: not started*), and the folded
  line uses the same words and colours.
