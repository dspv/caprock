# Caprock for iPhone: App Store listing

What goes into App Store Connect for version 1.0, field by field. English
(U.S.) is the primary language. The long texts are in their own files so they
paste without Markdown: [description.txt](description.txt),
[promotional-text.txt](promotional-text.txt),
[review-notes.txt](review-notes.txt). The questionnaires are
[app-privacy.md](app-privacy.md) and [age-rating.md](age-rating.md);
export compliance is in [../README.md § Export compliance](../README.md#export-compliance).
Limits are Apple's; `scripts/check-store.mjs` checks every field against them.

## App information

- **Name** (30 max): `Caprock`
- **Subtitle** (30 max): `Answer your coding agents`
- **Bundle ID:** `dev.caprock.ios` (set when the record was made)
- **SKU:** `caprock-ios`
- **Primary category:** Developer Tools
- **Secondary category:** Productivity
- **Content rights:** the app shows no third-party content of its own; the
  sessions it shows are the user's. Answer *No, it does not contain, show, or
  access third-party content*.
- **Age rating:** 4+ (answers in [age-rating.md](age-rating.md))
- **Price:** Free. No in-app purchases.

## Version 1.0

- **Promotional text** (170 max): [promotional-text.txt](promotional-text.txt)
- **Description** (4000 max): [description.txt](description.txt)
- **Keywords** (100 max, comma separated, no spaces needed):
  `remote,coding agent,AI agent,terminal,developer,session,approve,dictation,QR,codex,mission control`
- **Support URL:** `https://caprock.dev/feedback`
- **Marketing URL:** `https://caprock.dev`
- **Privacy Policy URL:** `https://caprock.dev/privacy`
- **Copyright:** `2026 CYBRIX LLC`
- **What's New:** not shown for a first version.
- **Screenshots:** iPhone 6.9" display, 1320 × 2868 portrait, in the order of
  the files the release brief lists (not committed: they are made in the
  Simulator in demo mode, see ../README.md § Screenshots).
- **App Review information:** sign-in required **No** (there is no account);
  notes in [review-notes.txt](review-notes.txt); contact is the owner's.

## Why these words

- *Coding agents*, not a product name, in the name and subtitle: Apple's
  guideline 2.3.7 keeps other companies' trademarks out of the name,
  subtitle and keywords. The description names the agents Caprock works with,
  which the guideline allows as a statement of compatibility. `codex` in the
  keywords is a common word as well as a product; drop it if review objects.
- *Mac or PC*: Caprock runs on macOS, Windows and Linux, and the phone pairs
  the same way with each.
- Nothing is for sale in the app and nothing in the listing points to a
  purchase (ADR-083); Premium is mentioned only as something the computer may
  have turned on.
