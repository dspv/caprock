// The fallback page: what the app shows while no compatible daemon answers.
// It renders the supervisor's state (src-tauri/src/supervisor.rs) and calls
// the few commands the capabilities grant this origin.
'use strict'

const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {})
const $ = (id) => document.getElementById(id)

if (navigator.platform.startsWith('Mac')) document.documentElement.classList.add('mac')

let last = ''

function render(s) {
  const key = JSON.stringify(s)
  if (key === last) return
  last = key
  for (const el of document.querySelectorAll('section[data-state]')) {
    el.hidden = !el.dataset.state.split(' ').includes(s.state)
  }
  if (s.state === 'starting') $('step').textContent = s.step + '…'
  if (s.state === 'failed') $('error').textContent = s.error
  if (s.state === 'too_old') {
    const level = s.api_level ? `API level ${s.api_level}` : 'no API level'
    $('old-detail').textContent = `It runs ${s.version || 'an unknown version'} (${level}); the app needs level ${s.min_api_level} or later.`
    for (const el of document.querySelectorAll('[data-ours]')) el.hidden = (el.dataset.ours === 'yes') !== s.ours
    $('command').textContent = s.command || 'Download the latest release from github.com/dspv/caprock/releases'
    $('copy').hidden = !s.command
  }
}

async function poll() {
  try {
    render(await invoke('daemon_status'))
  } catch (err) {
    render({ state: 'failed', error: String(err) })
  }
}

function busy(button) {
  button.disabled = true
  setTimeout(() => { button.disabled = false }, 3000)
}

$('start').addEventListener('click', (e) => {
  busy(e.currentTarget)
  invoke('start_daemon', { background: $('background').checked }).then(poll)
})
// Starting again uses the choice made on the first run.
for (const id of ['restart', 'retry']) {
  $(id).addEventListener('click', (e) => {
    busy(e.currentTarget)
    invoke('start_daemon').then(poll)
  })
}
$('update').addEventListener('click', (e) => {
  busy(e.currentTarget)
  invoke('update_daemon').then(poll)
})
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('command').textContent)
    $('copy').textContent = 'Copied'
  } catch {
    getSelection().selectAllChildren($('command'))
  }
  setTimeout(() => { $('copy').textContent = 'Copy' }, 1500)
})

poll()
setInterval(poll, 500)
