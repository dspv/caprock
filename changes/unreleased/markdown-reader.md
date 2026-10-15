---
kind: Added
---
- **app:** Markdown reads comfortably in a file tab, and goes to another agent
  in one click. The document sits at a reading measure with a larger heading
  scale; code blocks have a Copy button, wide tables scroll on their own,
  task lists show real check boxes, headings take anchors that in-page links
  jump to, and a relative picture is read from the project through the
  daemon (one on the web stays its alt text, so nothing is fetched from
  outside the machine). Contents sit beside a long document on a wide window
  and in a dropdown on a narrow one, with a thin reading-progress line. The
  tab's header has a quiet toolbar: *Copy path*, *Copy for an agent*
  (`@/absolute/path`, which Claude Code, Codex and the others read as a file
  reference), *Copy Markdown*, *Download*, and *Send to a session*, which
  types that reference into a running agent Caprock started without sending
  it, then brings that agent forward for you to add your words. A `.md` path
  an agent prints in its chat or terminal now opens the file in a tab
  (⌘-click in the terminal, Ctrl+click elsewhere), and *Open file…* lists
  Markdown files first. Every "link" is a path on this machine; nothing is
  uploaded.
