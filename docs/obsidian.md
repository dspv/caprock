# Bring an Obsidian vault into Second Brain

Open Second Brain → **Import from Obsidian…**. Choose the vault's folder in
the desktop app, or paste its full path on this computer, then **Import vault**.
The importer reads Markdown notes locally, without calling a model or writing
anything into the vault. It works with a Markdown folder without `.obsidian` too.

- Each file's name is its title. `[[links]]` join notes or memories with the
  same title or alias; a missing target makes no placeholder. Heading, block,
  folder and display-text suffixes are ignored when finding a target.
- Inline `#tags` and simple frontmatter `tags` become topics. Frontmatter
  `aliases` help match existing nodes. The importer reads scalars, comma-separated
  and bracketed lists, and simple block lists; it is not a full YAML interpreter.
- Matching a title or alias adds a source to the existing node, preserving its
  summary. Otherwise a new **Obsidian note** appears. Each source keeps its own
  excerpt; opening a node shows its vault and source file. Imported notes are
  diamonds in the graph; source labels also mark existing memories they join.
- A folder named like a Caprock project puts its notes under that project.
  Otherwise they appear under **Obsidian**. Notes are counted separately from
  memories extracted from agent sessions.

## Letting agents use notes

**Let agents use these notes** is off by default, separately for each vault.
Off, imported notes remain visible in Caprock, including its paired screens,
but are excluded from memory handoffs and [MCP](mcp.md) reads. Topics made by
that private import are excluded from the model's topic list too.

On, new sessions can receive the notes for their project, MCP clients can
read them, and automatic extraction can send their topic names to your model.
MCP results enter the agent's conversation and reach the model it uses. This
does not start a model call by itself.

When sources from several vaults share one note, all those vaults must allow
agent access before the note reaches an agent. For MCP, a private source also
hides an existing memory it joined, its search matches and links, until sharing
is allowed or the import is removed. The original session memory's own summary
can still be included in a handoff; the private source's excerpt is not added.
Turning sharing off stops future reads; it cannot retract text already sent to
a running agent or its model.

## Refreshing and removing

Caprock first checks saved vaults two minutes after it starts, then checks
again ten minutes after the previous pass finishes. Automatic checks read only
files whose size or modification time changed. **Refresh now** rereads every
note, including an edit that kept its size and timestamp, and resolves links
again. Edit and delete source notes in Obsidian; Caprock never writes them.

**Remove… → Remove import** removes the imported sources and their exclusive
nodes and links from Second Brain. Original memories and sources still used by
another vault stay. Your vault files stay on disk. Importing the folder again
is a fresh import.

The importer ignores dot folders, `node_modules`, symbolic links and
attachments. A vault is limited to 50,000 Markdown files, and only the first
4 MiB of each file is read; excerpts keep at most 400 characters. A folder
that cannot be scanned records an error and keeps the previous import.
An unreadable individual file keeps its previous source, if any. Correct the
folder or permissions and press **Refresh now** to try again.

Vault management is available on the computer running Caprock. A paired phone
can view the graph but cannot import a local folder or change sharing.
