---
kind: Added
---
- **projects:** New project's *Where is it?* step makes a folder that is not
  there yet. Type `~/dev/newhop5` and, when `~/dev` exists, the line under the
  field reads *New folder — Caprock will create ~/dev/newhop5* and the button
  *Create folder & continue*, in place of the red *… is not a folder*. That
  press (or Enter) makes the one folder, with no parents, no git and no GitHub
  (`POST /v1/browse/mkdir`), and the wizard goes on as if you had picked it.
  When the parent is missing too, the line names it (*~/foo/bar does not
  exist*) and nothing is made.
