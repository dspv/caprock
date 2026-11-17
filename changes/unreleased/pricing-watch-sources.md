---
kind: Changed
---
- **pricing:** the daily price watch now also reads DeepSeek, MiniMax and Kimi
  pricing, OpenCode Zen (for the rows whose figure is Zen's), Cursor's models
  page (its own models' prices, and the names Caprock cannot map to a priced
  model), Codex's model catalog (a model its picker lists with no price is
  drift), the Anthropic, OpenAI and Gemini model lists (context windows,
  new models, retirement dates) and OpenRouter's model list (new models, as a
  hint only). Findings that need no change to the table are reported "for
  information" and never open the "Pricing drift" issue. A new test fails any
  pull request whose launch menus offer a model the pricing table cannot
  price.
