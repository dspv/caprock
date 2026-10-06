// Shared by the harnesses (bench/README.md): machine load, process sampling,
// percentiles, the page hook's source. Node built-ins only.
import { execFileSync, execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim() } catch { return '' } }

/** What else the machine is doing: load averages and the busiest processes. */
export function machineLoad() {
  const load = os.loadavg().map((x) => Math.round(x * 100) / 100)
  let top = []
  if (process.platform === 'darwin') {
    top = run('ps', ['-Ao', 'pcpu=,comm=', '-r']).split('\n').slice(0, 6).map((l) => l.trim().replace(/\s+.*\//, ' '))
  } else if (process.platform === 'linux') {
    top = run('ps', ['-eo', 'pcpu=,comm=', '--sort=-pcpu']).split('\n').slice(0, 6).map((l) => l.trim())
  }
  return { at: new Date().toISOString(), load, cpus: os.cpus().length, top }
}

/** The machine, OS and date a result belongs to. */
export function machineInfo() {
  const info = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 2 ** 30) }
  if (process.platform === 'darwin') {
    info.os = `macOS ${run('sw_vers', ['-productVersion'])} (${run('sw_vers', ['-buildVersion'])})`
    info.model = run('sysctl', ['-n', 'hw.model'])
    info.chip = run('sysctl', ['-n', 'machdep.cpu.brand_string'])
    info.displays = run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const s=$.NSScreen.screens; let o=[]; for (let i=0;i<s.count;i++){const x=s.objectAtIndex(i); o.push(x.frame.size.width+"x"+x.frame.size.height+"@"+x.backingScaleFactor+"x "+x.maximumFramesPerSecond+"Hz")}; o.join(", ")'])
    info.power = run('pmset', ['-g', 'batt']).split('\n')[0]
  } else if (process.platform === 'linux') {
    info.os = run('sh', ['-c', '. /etc/os-release; echo "$PRETTY_NAME"']) + ' ' + os.release()
    info.session = process.env.XDG_SESSION_TYPE || ''
  } else {
    info.os = `${os.version()} ${os.release()}`
  }
  return info
}

/** CPU, memory and disk writes of an app's processes over `seconds` (procs.py, procs-linux.py, procs-windows.ps1). */
export function procs(pid, seconds, prefix) {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'procs-windows.ps1'), String(pid), String(seconds)]]
      : ['python3', [join(HERE, process.platform === 'darwin' ? 'procs.py' : 'procs-linux.py'), String(pid), String(seconds), ...(prefix ? [prefix] : [])]]
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24 }, (err, out) => {
      if (err) { resolve({ error: String(err) }); return }
      try { resolve(JSON.parse(out)) } catch (e) { resolve({ error: String(e), out }) }
    })
  })
}

export function pct(values, p) {
  const s = values.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  return Math.round(s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] * 10) / 10
}

export const median = (values) => pct(values, 0.5)

/** The page hook with its config in front (bench/page-hook.js). */
export function pageHook(cfg) {
  return `window.__BENCH_CFG__ = ${JSON.stringify(cfg)};\n` + readFileSync(join(HERE, 'page-hook.js'), 'utf8')
}
