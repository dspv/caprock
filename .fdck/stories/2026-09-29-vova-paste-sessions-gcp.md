# 2026-09-29 — Vova: paste, ended sessions, and a session that could not reach GCP

Four messages in Telegram, relayed by Dima. Three he called irritations that do
not block him; the fourth he called the blocker.

## In his words

> 1. когда я в терминал вставляю текст то он в 50% случаев криво вставляется:
>    если текст короткий, то он просто дублируется, если длинный то иногда он
>    сразу отображается а не схлопнутым блоком (в claude cli всегда схлопывается)
> 2. … когда я нажимаю галочку показать закрытые, то там много отображается, но
>    не понятно как их различить. было бы круто чтобы в UI подсвечивался какой-то
>    короткий description
> 3. … не пойму почему открыв одни я могу открыть их в терминале и продолжить, а
>    одни - нет

> а, и самое важное, это прям блокер - в сессии я спокойно могу работать со
> своим кодом, но иногда агенту надо сходить в GCP … просматривал таблицы в
> BigQuery и для этого вроде как надо выполнять gcloud auth login / gcloud auth
> application-default login, но когда я это делаю то через caprock все равно он
> потом говорит что не могу слазить в BQ. Я думал что это в принципе ограничение
> Claude CLI, но сегодня тоже самое сделал просто запустив в терминале claude
> (не через caprock) то он подтянул мой ADC

## What was actually wrong

- **GCP (FB-033).** Not a credentials problem at all. A session Caprock starts
  inherited the daemon's environment, and a daemon started at login by launchd
  has `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and nothing from the shell profile.
  Reproduced on the owner's machine: under that environment `claude` could not
  find `gcloud` or `bq`; from a terminal it could. Sessions now start with the
  user's login-shell environment.
- **Paste (FB-034).** Two faults. Cmd+V was pasted twice — once by our own
  clipboard read, once by the browser's native paste that xterm also handles —
  which is the duplicated short text, and "50%" because the clipboard read only
  succeeds when the browser grants it. And a terminal attached after the
  session's first 256 KB of output never learned that Claude Code had turned on
  bracketed paste, so a long paste arrived unbracketed and was not collapsed.
- **Telling ended sessions apart (FB-035).** An ended card carries the project,
  a short id and the last narrated state — which is "ended" or "waiting for
  you" on nearly every one. Nothing says what the session was about.
- **Which ended sessions continue (FB-036).** The button was gated on the agent
  and on who started the session, and on nothing that decides whether a resume
  works. Of 116 ended Claude Code sessions on the owner's machine it told the
  truth for 39: 65 offered a resume that failed (44 transcripts Claude Code had
  already deleted, 21 folders gone), and 12 that could be resumed offered
  nothing.
