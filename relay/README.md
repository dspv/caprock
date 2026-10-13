# relay — the hosted relay for access from anywhere

A Cloudflare Worker where a phone and a Caprock machine meet (ADR-058 in
`.ai/08-decisions.md`). One Durable Object per machine id holds that machine's
socket and its phones' sockets and forwards bytes between them. Everything it
forwards is Noise ciphertext between the phone and the machine; it stores
nothing.

The reference implementation is `internal/remote/relaysrv` (also
`caprock remote relay`), and the wire is `internal/remote/wire.go`. A change to
the protocol lands in both.

```bash
npm install
npm run typecheck
npx wrangler dev --local --port 8788       # then: caprock remote on --relay ws://127.0.0.1:8788
npx wrangler deploy                        # needs `wrangler login` and the zone in wrangler.toml
```

The phone's page is the dashboard built for it: `cd ui && npx vite build
--mode remote`, output in `ui/dist-remote/`, served over https from any static
host (`caprock remote on --app https://…` to point machines at your own).
