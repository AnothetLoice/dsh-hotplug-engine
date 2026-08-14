// Definitive e2e: does the engine's cmd-spawn mechanism pass clean args to the REAL pnpm?
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpe-real-'))
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies: {} }))
fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')

const pnpm = 'D:/code/dsh/harness-research/.tools/bin/pnpm.cmd'
const spec = 'D:/code/dsh/harness-research/hotplug-drill'
const cmdline = `""${pnpm}" --dir "${profileDir}" add "${spec}""`
const r = spawnSync('cmd.exe', ['/d', '/s', '/c', cmdline], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 120000 })
console.log('status:', r.status)
console.log('stdout tail:', JSON.stringify((r.stdout || '').slice(-400)))
console.log('stderr tail:', JSON.stringify((r.stderr || '').slice(-400)))
const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
console.log('manifest deps:', JSON.stringify(manifest.dependencies))
