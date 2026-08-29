# Who the users are

Two people have used Caprock on their own machines and reported back. That is
the entire population, and every generalisation in this directory should be
read against that number.

## Vova

**Runs Caprock as his main working surface.** He replaced the Claude Code IDE
with it — not "installed it to look", but moved onto it. The terminal is what
made that possible, which is why a font defect in the terminal (FB-004) is not
cosmetic for him.

Works in Russian. That is the only reason the Cyrillic rendering bug was ever
found; the dashboard's own chrome is English and everyone else's output was
Latin, so the fallback face never looked wrong to anybody else.

Reached the payment page and stopped at the price — see FB-003. Uses OpenCode
alongside Claude Code, which is how FB-002 was found.

Earlier feedback from him, recorded before this directory existed: per-repo
costs (shipped), team stats, and that Claude's own prose was being stored but
never shown.

## Alex

Windows. Few sessions, and he runs everything out of a single folder — Dima's
note at the time was that this looked like one person's particular setup. It
was not: the hook registration was broken for **every** Windows install
(FB-001), and the narrow-looking report turned out to be universal.

**The lesson worth keeping:** a report that looks like an edge case is a
hypothesis about frequency, not a finding. Alex's report was nearly filed as
his own peculiarity.

**On 2026-08-29 he came back, having built from source and read the schema.**
Four requests: winget packaging, the install path, a `make build` that works on
Windows, and a measured claim about database size that held up when checked
(FB-023 to FB-026). He is the first person outside Dima to treat Caprock as a
codebase rather than a tool — which also means "light user on Windows" was
never an accurate description of him.

## What we do not have

No user we did not personally recruit. No user outside Dima's circle. Nobody
who has paid. Every number in this directory is a quote from a conversation,
not a measurement of behaviour.
