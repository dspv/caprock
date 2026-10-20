---
kind: Changed
---
- **ui:** the pull request progress bars end at merged. A merged pull request's
  bar is now completely filled on Work, the Pipeline, the release plan, the
  phone's Releases and the right panel's CI block, instead of leaving a grey
  *released* block that read as unfinished or closed. Whether it shipped is a
  quiet word after the bar: *in v0.140.0* once released, a muted *not
  released* while a repository that cuts releases waits for the next one. A
  pull request closed without a merge still reads *Closed*.
