# My machines

**Status: accepted, Phase 1 in progress.** The decision is
[ADR-067](08-decisions.md); this file is what it is for, how it is built,
in what order, and what is still open. Nothing here is in a release.

## What it is for

The owner, 2026-10-15 (translated): "move towards encouraging people to
install Caprock on their other computers, so they can work with them the
same way, from the phone and so on — just my computers joined in a network."

- **The Mac the user sits at stays responsive.** Agents, their MCP servers
  and the builds and tests they run move to another machine; the editor, the
  browser and a call stay on this one. On 2026-10-14 the owner's own Claude
  Code process reached 2.6 GB and the load average 140.
- **More agents at once** than one machine's memory holds.
- **Work goes on with the laptop closed,** and the phone sees every machine.
- **Not speed.** A task is not claimed to finish faster on another machine.
  A recent Mac's one-core speed is high, and nothing says a Mac mini or a
  rented VM beats it. A claim of that kind needs the benchmark in § Measure
  first (rule 6).

Hosted machines (a VM we rent out with a plan) were weighed the same day and
parked: they would put users' code on a machine in our account (rule 4) and
the speed case is unproven. A rented VM the user owns is just another
machine here; that works without anything hosted.

## How it works for the user

1. On any machine, Settings → *My machines* → **Add a machine** shows a link
   and a code, with one line saying a linked machine can run agents here.
2. On the new machine, `caprock join <link>` (or the same screen with the
   code). It works over ssh with no screen.
3. Both machines list each other: name, online, round trip, agents running,
   free memory.
4. The sidebar groups sessions by machine once there are two. A remote
   agent's terminal is a tab like any other.
5. **New agent** has a *Run on* picker; the folder list is the chosen
   machine's.
6. When this machine is loaded and a linked one is not, the place the user
   starts an agent says so once: "This Mac is busy — run it on Mac mini
   (N GB free)?", with the measured figure. It never moves anything by
   itself.
7. Without a second machine, the sidebar's *My machines* row reads **+ Add
   a machine**, and the same busy-machine moment offers it.

## How it is built

- **The link.** `internal/remote` gains a client: the Noise Initiator that
  exists for tests, plus the stream framing `ui/src/remote/transport.ts`
  speaks, ported to Go — an `http.RoundTripper` and a WebSocket dialer over
  one channel. The relay, its protocol and the remote daemon's host side do
  not change.
- **Joining.** The link the Add screen shows is the phone's pairing link
  (relay, machine id, X25519 key, one-time code). `caprock join` turns the
  new machine's relay host on, dials the first machine as a client, pairs
  with the code, and in the same exchange hands over its own id, key and a
  fresh token for the first machine. Each side writes the other into
  `machines.json` (0600, beside `devices.json`) and as a `machine` device.
- **The proxy.** `/v1/m/{machine}/…` on loopback forwards to that machine's
  `/v1/…` over its link, WebSockets included, under the `machine` role. The
  dashboard prefixes its calls by machine; the app does not change.
- **The role.** `machine` = controller routes + custom agents + saved
  prompts. Pairing, access from anywhere, settings and the doctor's stop
  stay local-only. Enforced in `internal/api/lanauth.go` and
  `controller.go`, like the others.
- **Load.** `/v1/resources` gains the machine's free memory and load
  average, so the picker and the busy-machine line read real figures.
- **Paths.** Relay first, always. A machine whose network listener is on, or
  that has a Tailscale address, reports its addresses through the link; the
  client then dials every known path at once and keeps the fastest, still
  inside Noise (21-app.md § Phase B). Nothing new listens by default.

## The wire, as Phase 1 builds it

PR 2 moves this into [03-contracts.md](03-contracts.md) with the code; until
then it is the agreement the Go and UI work build against.

- **A code for a machine.** `POST /v1/pair/code` takes `{"role":"machine"}`
  (loopback only, as for the other roles) and answers as it does for a
  phone, `remote.link` included: the link a new machine joins with.
- **Joining.** `POST /v1/machines/join` `{"link":"…","name":"…"}`, loopback
  only, on the new machine (`caprock join <link>` calls it). The daemon turns
  its own access from anywhere on, mints a `machine` device for the other
  side, dials the link's machine through the relay and calls `POST
  /v1/pair` there with `{"code","name","machine":{"id","key","relay",
  "token"}}`: its own identity and the token just minted. The other side
  redeems the code as a `machine` device, records the sender in its
  `machines.json`, and answers the usual `{token,id,name}` plus its own
  `{"machine":{"id","key","relay","name"}}`. Both now hold a token on each
  other. A failure at any step undoes the local half.
- **The list.** `GET /v1/machines` (loopback only) →
  `{"machines":[{"id","name","online","rtt_ms","version","since",
  "error"}]}`; `online` is the link's state, `rtt_ms` its last measured
  round trip.
- **Removing.** `DELETE /v1/machines/{id}` (loopback only) drops the entry
  and revokes its device here, then calls `DELETE /v1/machines/me` on the
  other side if it is reachable — the one pairing route a `machine` token
  may call, and only about itself.
- **The proxy.** `/v1/m/{id}/…` on loopback forwards method, path, query,
  body and WebSocket upgrades to that machine's `/v1/…` over the link,
  carrying the stored token. 502 with `{"error"}` when the link is down;
  the other side's status otherwise.
- **Load.** `GET /v1/resources` gains `"machine":{"cpus","load1",
  "mem_total","mem_available"}` (bytes).

## Measure

Each figure is measured, dated and written here before it is used in copy
or in a decision. None exists yet.

- **Round trip over the relay**, machine to machine in the same city and
  across countries, against the hosted relay (`relay.caprock.dev`) and a
  self-hosted one.
- **Terminal echo over a link**: `bench/busy.mjs` pointed at a remote agent
  through `/v1/m/…`, p50 and p95, beside the local figures in 21-app.md §
  Typing beside busy agents.
- **What a remote agent saves this machine**: memory and CPU of the
  `claude` process tree and its children for one real task, run here and
  then on the other machine, with this machine's figures recorded both
  times.
- **Speed, for honesty**: `go test ./...` and the UI build of this
  repository on the owner's Mac and on the second machine.

If echo over the relay is worse than local by more than the user notices,
the direct path moves up, and local echo prediction (mosh-style) is
considered only after that.

## Phases

### Phase 1 — two machines, one link

- **PR 1, the client.** `internal/remote/client.go`: Initiator + framing,
  `RoundTripper`, WebSocket dial; tested against `relaysrv` in-process,
  including a dropped relay and a peer that restarts.
- **PR 2, join and proxy.** The `machine` role, `machines.json`, `caprock
  join` and `caprock machines` (list, remove), `POST /v1/machines/join`,
  `/v1/m/{machine}/…`; a two-daemon smoke (two temp homes, local relay, fake
  `claude`) that joins, starts an agent on the other machine and types into
  it, on macOS, Linux and Windows CI. 03-contracts.md in the same PR.
- **PR 3, the screens.** Settings → *My machines* (add, list, remove,
  online, round trip), the sidebar's machine grouping, remote terminal tabs,
  the *Run on* picker. Agreed with the owner on a local compare page first.

Done when the owner starts an agent on his Mac mini from the MacBook, types
into it, closes the lid, and finds it finished from the phone.

### Phase 2 — a group, and a machine with no screen

- **Introductions.** Joining B to A introduces B to every machine A already
  links (A holds a `machine` token on each), so a group forms from one join
  per machine.
- **Headless.** `caprock join` on Linux checks `loginctl enable-linger` and
  says the one command when it is off; `caprock service install` is offered
  at the end of a join.
- **Windows as a host**, checked on a real Windows machine, not only CI.

### Phase 3 — one view of everything

- The local daemon merges the linked machines' live sessions, waiting
  states and notifications into its own `/v1/live`, tagged by machine.
- The phone sees all machines from the one it paired with, capped by the
  role rule in ADR-067.
- The busy-machine line, from the load figures.

### Phase 4 — speed

- The direct path (network listener, Tailscale), measured against the
  relay.
- Local echo prediction, only if § Measure says typing needs it.
- A site page on running agents on another computer (caprock-web, the SEO
  plan), once Phase 1 has shipped and the figures above exist.

## Open questions

- **A paid tier.** Free with no machine limit for now (ADR-067). Whether
  anything here is paid later is decided from use.
- **Hosted machines.** Parked; a new ADR with measured numbers if users ask.
- **Mixed versions.** Two machines on different releases: the link's
  Welcome carries the version; a route the other side lacks answers 404 and
  the screen says which machine needs updating. Exact behaviour is PR 2's
  to settle.
- See `OQ-17` and `OQ-18` in [12-risks.md](12-risks.md).
