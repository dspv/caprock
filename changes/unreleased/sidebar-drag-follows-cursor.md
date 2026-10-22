---
kind: Fixed
---
- **ui:** dragging a session row in the sidebar now shows it moving: the row
  follows the pointer, raised over the others, and they slide apart by its
  height to show where it will land. Released over the list it lands there;
  released off the list, or on Escape, it slides back and nothing moves.
  Before, the row only dimmed and you could not see where it was going. A
  dragged row or tab now makes way for a neighbour once it is halfway over
  it, rather than all the way.
