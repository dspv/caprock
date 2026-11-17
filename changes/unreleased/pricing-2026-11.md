---
kind: Fixed
---
- **pricing:** Claude Fable 5.2 is no longer priced as Fable 5. A model is now
  matched only by its own name (or a dated or `[1m]` form of it), so a newer
  model is shown as unpriced rather than charged at an older model's rate.
  Turns already priced the wrong way are corrected on the next start.
- **pricing:** long prompts are priced at their higher rate: Claude Haiku 5.5
  over 100,000 tokens, GPT-6 and GPT-5.6 over 272K, Gemini 3.1 Pro and 2.5
  Pro over 200k, MiniMax M3 over 512K. Earlier turns on these models are
  corrected on the next start.
- **pricing:** OpenCode, Hermes and Cursor turns keep the cost their own
  agent recorded, or none, when Caprock reprices or fills in stored turns.
