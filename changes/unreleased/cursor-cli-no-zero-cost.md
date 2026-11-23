---
kind: Fixed
---
- **cursor:** a `cursor-agent` chat no longer reads "0 tok · $0.00 cost" with a blank burn rate in the inspector. Cursor's hooks carry no tokens and no cost, so its tokens, cost, burn rate, cache and last call now read "—" with "Cursor doesn't record a cost for this chat" (or "… token counts for this chat") on hover, in the headline, the lines beside the agent, their menus, the Numbers row and the chart. The Session screen, the Now card and the Live screen's rows say the same instead of $0.00.
