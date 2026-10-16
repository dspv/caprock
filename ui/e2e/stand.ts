/**
 * The e2e stand: a sandboxed daemon, the fake claude and this checkout's
 * dashboard, all in one temp directory (.ai/10-infrastructure.md § E2E).
 *
 * Nothing here touches the machine it runs on:
 *
 * - the daemon runs under `env -i`: its own HOME, data directory, TMPDIR and
 *   service label, CAPROCK_SECRET_STORE=file (no keychain, no OS dialog), a
 *   PATH whose `claude` is testdata/fakeclaude, a free loopback port, no
 *   hooks, no browser, no update check, notifications and keep-awake off;
 * - the page is this checkout's ui/ built into the temp directory and served
 *   by `vite preview`, which proxies /v1 to that daemon. internal/api/dist is
 *   never written (master rebuilds it, ADR-068), so a branch tests its own UI
 *   rather than whatever dashboard the binary happens to embed;
 * - every pid it stops is one it started: the daemon, vite preview, and the
 *   pty-hosts that daemon wrote into its own data directory.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const UI_DIR = path.resolve(HERE, '..')
export const REPO = path.resolve(UI_DIR, '..')

/** What the tests read: written by global setup, found through CAPROCK_E2E_STATE. */
export interface StandState {
  dir: string
  daemonURL: string
  pageURL: string
  daemonPid: number
  previewPid: number
  /** The fake sessions, in the order they were started. */
  sessions: { id: string; cwd: string; name: string }[]
}

export function readState(): StandState {
  const p = process.env.CAPROCK_E2E_STATE
  if (!p) throw new Error('CAPROCK_E2E_STATE is unset: run through `make e2e` (playwright test -c e2e)')
  return JSON.parse(readFileSync(p, 'utf8')) as StandState
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitHTTP(url: string, ms: number, alive: () => boolean): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    if (!alive()) throw new Error(`exited before ${url} answered`)
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms} ms`)
    await sleep(100)
  }
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
}

function alive(p: ChildProcess): boolean {
  return p.exitCode === null && p.signalCode === null
}

/** Starts the stand; the returned function stops it and removes the directory. */
export async function startStand(): Promise<{ state: StandState; stop: () => Promise<void> }> {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const caprock = path.join(REPO, 'bin', `caprock${exe}`)
  if (!existsSync(caprock)) throw new Error(`${caprock} is missing: run \`make build-go\` (make e2e does)`)

  // Never under the real HOME: os.tmpdir() is $TMPDIR, /var/folders on macOS.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'caprock-e2e-'))
  const home = path.join(dir, 'home')
  const data = path.join(dir, 'data')
  const bin = path.join(dir, 'bin')
  const tmp = path.join(dir, 'tmp')
  const ui = path.join(dir, 'ui')
  for (const d of [home, data, bin, tmp, path.join(home, '.claude', 'projects')]) mkdirSync(d, { recursive: true })

  let daemon: ChildProcess | undefined
  let preview: ChildProcess | undefined
  const stop = async () => {
    for (const p of [preview, daemon]) {
      if (p && alive(p)) {
        p.kill('SIGTERM')
        const until = Date.now() + 5000
        while (alive(p) && Date.now() < until) await sleep(50)
        if (alive(p)) p.kill('SIGKILL')
      }
    }
    killHolders(data)
    if (process.env.CAPROCK_E2E_KEEP === '1') console.log(`e2e: stand kept at ${dir}`)
    else rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }

  try {
    // The fake claude, built where only this daemon's PATH finds it.
    run('go', ['build', '-o', path.join(bin, `claude${exe}`), './testdata/fakeclaude'], REPO)
    // This checkout's dashboard, built outside the tree (3 s).
    run(path.join(UI_DIR, 'node_modules', '.bin', 'vite'), ['build', '--outDir', ui, '--emptyOutDir', '--logLevel', 'warn'], UI_DIR)

    const dport = await freePort()
    const daemonURL = `http://127.0.0.1:${dport}`
    writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      port: dport, update_checks: false, open_browser: false, notify_approval: false,
      notify_finished: false, keep_awake: 'off', brain: { auto: false },
    }))
    writeFileSync(path.join(data, 'app-hotkey.json'), '{"accelerator": null}')

    // env -i: nothing of the caller's environment reaches the daemon.
    const env = {
      HOME: home, USERPROFILE: home, TMPDIR: tmp, CAPROCK_DATA_DIR: data,
      CAPROCK_SECRET_STORE: 'file', CAPROCK_SERVICE_LABEL: 'dev.caprock.e2e',
      PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    }
    const log = openSync(path.join(dir, 'daemon.log'), 'a')
    daemon = spawn('env', ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      caprock, 'up', '--foreground', '--no-hooks', '--no-open', '--port', String(dport), '--data-dir', data],
    { cwd: tmp, stdio: ['ignore', log, log] })
    closeSync(log)
    const d = daemon
    await waitHTTP(`${daemonURL}/healthz`, 30_000, () => alive(d))

    const pport = await freePort()
    const pageURL = `http://127.0.0.1:${pport}`
    const plog = openSync(path.join(dir, 'preview.log'), 'a')
    preview = spawn(path.join(UI_DIR, 'node_modules', '.bin', 'vite'),
      ['preview', '--outDir', ui, '--host', '127.0.0.1', '--port', String(pport), '--strictPort'],
      { cwd: UI_DIR, env: { ...process.env, CAPROCK_DAEMON_URL: daemonURL }, stdio: ['ignore', plog, plog] })
    closeSync(plog)
    const pv = preview
    await waitHTTP(`${pageURL}/healthz`, 20_000, () => alive(pv))

    // Two projects (git repositories under the stand's HOME, where the
    // daemon accepts them) with one fake session each, started as the
    // dashboard starts one.
    const post = (p: string, body: unknown) => fetch(`${daemonURL}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const sessions: StandState['sessions'] = []
    for (const name of ['alpha', 'beta']) {
      const cwd = path.join(home, 'dev', name)
      mkdirSync(cwd, { recursive: true })
      writeFileSync(path.join(cwd, 'README.md'), `# ${name}\n`)
      run('git', ['init', '-q'], cwd, { PATH: env.PATH, HOME: home })
      const pr = await post('/v1/projects', { path: cwd })
      if (!pr.ok) throw new Error(`add project ${name}: ${pr.status} ${await pr.text()}`)
      const r = await post('/v1/agents', { cwd })
      const body = await r.json() as { session_id?: string }
      if (!r.ok || !body.session_id) throw new Error(`spawn ${name}: ${r.status} ${JSON.stringify(body)}`)
      // A name of its own, so a tab and its sidebar row are matched by it.
      const title = `e2e ${name}`
      const nr = await fetch(`${daemonURL}/v1/sessions/${body.session_id}/name`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title }),
      })
      if (!nr.ok) throw new Error(`name ${name}: ${nr.status} ${await nr.text()}`)
      sessions.push({ id: body.session_id, cwd, name: title })
    }

    const state: StandState = { dir, daemonURL, pageURL, daemonPid: daemon.pid!, previewPid: preview.pid!, sessions }
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
    return { state, stop }
  } catch (err) {
    const tail = (f: string) => { try { return readFileSync(path.join(dir, f), 'utf8').slice(-4000) } catch { return '' } }
    const msg = `${err instanceof Error ? err.message : String(err)}\n--- daemon.log ---\n${tail('daemon.log')}\n--- preview.log ---\n${tail('preview.log')}`
    await stop()
    throw new Error(msg)
  }
}

/**
 * The sessions' pty-hosts and their children: the daemon started them and
 * recorded each in its own data directory, so these are pids this stand
 * started, never anyone else's.
 */
function killHolders(data: string): void {
  const reg = path.join(data, 'ptyhost')
  let names: string[] = []
  try { names = readdirSync(reg).filter((n) => n.endsWith('.json')) } catch { return }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(path.join(reg, n), 'utf8')) as { host_pid?: number; child_pid?: number }
      for (const pid of [r.child_pid, r.host_pid]) {
        if (pid && pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      }
    } catch { /* unreadable: nothing to stop */ }
  }
}
