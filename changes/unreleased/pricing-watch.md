---
kind: Added
---
- **ci:** a daily `pricing-watch` run compares the Anthropic, OpenAI and Gemini
  pricing pages with `pricing/pricing.json` and opens one "Pricing drift" issue
  when a page lists a model the table lacks, a model the table prices as a
  different one by prefix (Claude Fable 5.2 as Fable 5), or a different price.
  It never edits the table; prices are still copied by hand with their source
  and date.
