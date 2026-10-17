---
kind: Fixed
---
- **pipeline:** in a repository that cuts no releases (none published and no
  version tag in 180 days, such as a site deployed on every merge), merged is
  now the last step: the CI block's and the Pipeline's bars end at merged and
  fill, and the release plan says *No releases here: work ships when it
  merges* instead of listing every merge as waiting for a release that never
  comes. Where releases are cut, the empty released step says what it means
  and what a merge waits for (*the next release (v0.133.0)*, *in v0.132.0*);
  where it cannot be read, the step is drawn as not known.
