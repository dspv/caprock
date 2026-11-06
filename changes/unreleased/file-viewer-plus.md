---
kind: Added
---
- **ui:** the file tab reads more kinds of file. Markdown and HTML get
  *Rendered* / *Source* / *Split*, Split showing the source and the page side
  by side, their scrolling kept together for Markdown; the choice is
  remembered. An HTML page is drawn in a sandboxed frame that runs no script
  and loads nothing from the network, its own stylesheets and pictures read
  from the project. CSV and TSV files show as a table, pictures (SVG too) as
  themselves, and code and config files are syntax-highlighted by a part of
  the app loaded only when such a file is opened; a file over 256 KB stays
  plain.
