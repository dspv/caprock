---
kind: Added
---
- **ui:** the Pipeline's *Next release* panel says where the release itself
  is: the next version's bump and why (*minor · a feature since …*,
  *patch · fixes only*), then its stages as the pull request rows' pills —
  merged → release PR → CI → tag → builds → published → site — the current
  one filled, done ones ticked, and any stage Caprock cannot read (the
  site's deploy) left neutral with a *?* rather than guessed. A tag already
  pushed and still building shows above as *releasing*, its builds counted
  as files on the release against the release before it. Under the rows,
  one line for the last release: when, how many files, and a link.
- **github:** the releases the board lists carry their uploaded file count
  (`assets`), from the same request.
