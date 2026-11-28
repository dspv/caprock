/**
 * Two people's Caprocks for Talks (ADR-110): a relay on loopback
 * (testdata/looprelay, never the hosted one), two sandboxed daemons — Dima's
 * and Ana's — each with its own HOME, data directory and the fake claude on
 * its PATH, and this checkout's dashboard served for each by `vite preview`.
 *
 * As the shared stand (stand.ts): nothing of the caller's environment reaches
 * a daemon (`env -i`), no keychain (CAPROCK_SECRET_STORE=file), no hooks, no
 * browser, no update check, and every pid stopped is one started here.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO, UI_DIR, alive, freePort, killHolders, run, sleep, waitHTTP } from './stand'

export interface Side {
  name: string
  daemonURL: string
  pageURL: string
}

export interface Pair {
  dir: string
  relay: string
  dima: Side
  ana: Side
  stop: () => Promise<void>
}

async function stopProc(p: ChildProcess | undefined): Promise<void> {
  if (!p || !alive(p)) return
  p.kill('SIGTERM')
  const until = Date.now() + 5000
  while (alive(p) && Date.now() < until) await sleep(50)
  if (alive(p)) p.kill('SIGKILL')
}

export async function startPair(): Promise<Pair> {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const caprock = path.join(REPO, 'bin', `caprock${exe}`)
  if (!existsSync(caprock)) throw new Error(`${caprock} is missing: run \`make build-go\` (make e2e does)`)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'caprock-e2e-talks-'))
  const bin = path.join(dir, 'bin')
  const ui = path.join(dir, 'ui')
  mkdirSync(bin, { recursive: true })
  const procs: ChildProcess[] = []
  const datas: string[] = []
  const stop = async () => {
    for (const p of [...procs].reverse()) await stopProc(p)
    for (const d of datas) killHolders(d)
    if (process.env.CAPROCK_E2E_KEEP === '1') console.log(`e2e: talks stand kept at ${dir}`)
    else rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  try {
    run('go', ['build', '-o', path.join(bin, `claude${exe}`), './testdata/fakeclaude'], REPO)
    run('go', ['build', '-o', path.join(bin, `looprelay${exe}`), './testdata/looprelay'], REPO)
    run(path.join(UI_DIR, 'node_modules', '.bin', 'vite'), ['build', '--outDir', ui, '--emptyOutDir', '--logLevel', 'warn'], UI_DIR)

    // The relay: stdin is a pipe it watches, so it stops with this process too.
    const addrFile = path.join(dir, 'relay.addr')
    const rlog = openSync(path.join(dir, 'relay.log'), 'a')
    const relay = spawn(path.join(bin, `looprelay${exe}`), ['-addr', '127.0.0.1:0', '-out', addrFile], { stdio: ['pipe', rlog, rlog] })
    closeSync(rlog)
    procs.push(relay)
    const until = Date.now() + 10_000
    while (!existsSync(addrFile) || !readFileSync(addrFile, 'utf8')) {
      if (!alive(relay) || Date.now() > until) throw new Error('the loopback relay did not start')
      await sleep(50)
    }
    const relayURL = `ws://${readFileSync(addrFile, 'utf8').trim()}`

    const side = async (name: string): Promise<Side> => {
      const root = path.join(dir, name.toLowerCase())
      const home = path.join(root, 'home')
      const data = path.join(root, 'data')
      const tmp = path.join(root, 'tmp')
      for (const d of [home, data, tmp, path.join(home, '.claude', 'projects')]) mkdirSync(d, { recursive: true })
      datas.push(data)
      const dport = await freePort()
      const daemonURL = `http://127.0.0.1:${dport}`
      writeFileSync(path.join(data, 'config.json'), JSON.stringify({
        port: dport, update_checks: false, open_browser: false, notify_approval: false,
        notify_finished: false, keep_awake: 'off', brain: { auto: false },
      }))
      writeFileSync(path.join(data, 'app-hotkey.json'), '{"accelerator": null}')
      const env = {
        HOME: home, USERPROFILE: home, TMPDIR: tmp, CAPROCK_DATA_DIR: data,
        CAPROCK_SECRET_STORE: 'file', CAPROCK_SERVICE_LABEL: `dev.caprock.e2e.${name.toLowerCase()}`,
        PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      }
      const log = openSync(path.join(root, 'daemon.log'), 'a')
      const d = spawn('env', ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        caprock, 'up', '--foreground', '--no-hooks', '--no-open', '--port', String(dport), '--data-dir', data],
      { cwd: tmp, stdio: ['ignore', log, log] })
      closeSync(log)
      procs.push(d)
      await waitHTTP(`${daemonURL}/healthz`, 30_000, () => alive(d))
      const pport = await freePort()
      const pageURL = `http://127.0.0.1:${pport}`
      const plog = openSync(path.join(root, 'preview.log'), 'a')
      const pv = spawn(path.join(UI_DIR, 'node_modules', '.bin', 'vite'),
        ['preview', '--outDir', ui, '--host', '127.0.0.1', '--port', String(pport), '--strictPort'],
        { cwd: UI_DIR, env: { ...process.env, CAPROCK_DAEMON_URL: daemonURL }, stdio: ['ignore', plog, plog] })
      closeSync(plog)
      procs.push(pv)
      await waitHTTP(`${pageURL}/healthz`, 20_000, () => alive(pv))
      // This relay, and access from anywhere off: inviting and accepting turn it on.
      const r = await fetch(`${daemonURL}/v1/pair/remote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false, relay: relayURL }) })
      if (!r.ok) throw new Error(`${name}: relay: ${r.status} ${await r.text()}`)
      return { name, daemonURL, pageURL }
    }
    const [dima, ana] = await Promise.all([side('Dima'), side('Ana')])
    return { dir, relay: relayURL, dima, ana, stop }
  } catch (err) {
    const tail = (f: string) => { try { return readFileSync(path.join(dir, f), 'utf8').slice(-3000) } catch { return '' } }
    const msg = `${err instanceof Error ? err.message : String(err)}\n--- dima ---\n${tail('dima/daemon.log')}\n--- ana ---\n${tail('ana/daemon.log')}`
    await stop()
    throw new Error(msg)
  }
}
