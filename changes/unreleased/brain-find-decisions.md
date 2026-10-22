---
kind: Added
---
- **brain:** Second Brain finds what was decided and knows which decisions
  still stand. Search matches whole words (*PR* no longer finds *project*
  and *prompt*: 136 memories instead of 1,097 on the owner's database),
  any word may match, rarer words and title or keyword hits rank first,
  and *PR*, *pull request*, *cost*, *price*, *spend*, *decision* and *rule*
  find each other. Each new memory gets five to eight English keywords,
  whatever language its title is in, so an English query finds a memory
  written in another language (older memories get theirs from the
  re-tag). A read
  is shown the project's current decisions and recent memories with their
  ids: it no longer repeats one, can link to one, and can say a new
  decision supersedes an older one. A superseded memory is ranked last,
  dimmed and struck through in the graph, and says what replaced it; its
  *Undo* makes it current again. A new session's handoff now leads with
  the project's current decisions (up to 15), carries one memory per
  session, and goes even when no recent passage does. `caprock mcp` gains
  `current_decisions`, and `search_memories` returns up to 30 ranked
  candidates with keywords and a short summary for the agent to judge.
