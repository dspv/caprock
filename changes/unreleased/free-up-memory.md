---
kind: Changed
---
- **resources:** one **Free up memory** button, in Caprock resources and in
  the memory popover alike, replaces *Clean up* and *End N idle agents*. It
  opens a list in two groups — leftovers and idle agents — each line with
  its own checkbox and size, the total following the ticks, and says first
  what happens: conversations are kept, and anything an idle agent started
  in the background stops with it.
- **resources:** it is stricter about what is safe. A test copy of Caprock
  is offered only once the agent that started it is gone; one whose agent
  still runs is kept, with the reason on its row. An idle agent is offered
  only after 15 minutes idle, with nothing but its own helpers running under
  it, and never the tab in front; the rest it leaves running are listed with
  why, and the daemon checks each again at the click.
