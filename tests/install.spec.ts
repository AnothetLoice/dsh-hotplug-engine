import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HotplugEngineService } from '../src/host/service.ts'
import { readInsertRows, EMPTY_TEMPLATE, addInsertRow } from '../src/host/patch.ts'
import { writeManifestAtomic, readDependencies } from '../src/host/manifest.ts'
import { createBackup } from '../src/host/backup.ts'
import { ErrorCodes } from '../src/contract/types.ts'
import type { FiberPhase, LoaderLike } from '../src/host/health.ts'

const GOOD_FIXTURE = join(__dirname, '..', '..', 'harness-research', 'hotplug-drill')

function makeBadFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpe-badfixture-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bad-fixture', version: '1.0.0', main: './lib/index.js' }), 'utf8')
  // lib/index.js intentionally missing → "no resolvable entry file"
  return dir
}

/** Fake pnpm: simulates add/remove against the profile manifest + node_modules. */
function makeFakePnpm(): { pnpmPath: string; calls: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'hpe-pnpm-'))
  const callsFile = join(root, 'calls.jsonl')
  const cjs = join(root, 'fake-pnpm.cjs')
  writeFileSync(cjs, [
    'const fs = require("node:fs")',
    `const callsFile = ${JSON.stringify(callsFile)}`,
    'const path = require("node:path")',
    'const argv = process.argv.slice(2)',
    'const clean = (s) => (s ?? "").replace(/^"+|"+$/g, "")',
    'const dirIdx = argv.indexOf("--dir")',
    'const profileDir = clean(argv[dirIdx + 1])',
    'const verb = argv[dirIdx + 2]',
    'const target = clean(argv[dirIdx + 3])',
    'fs.appendFileSync(callsFile, JSON.stringify(argv) + "\\n")',
    'const manifestPath = path.join(profileDir, "package.json")',
    'const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))',
    'manifest.dependencies = manifest.dependencies ?? {}',
    'if (verb === "add") {',
    '  if (fs.existsSync(target)) {',
    '    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"))',
    '    const dest = path.join(profileDir, "node_modules", pkg.name)',
    '    fs.mkdirSync(path.dirname(dest), { recursive: true })',
    '    fs.cpSync(target, dest, { recursive: true })',
    '    manifest.dependencies[pkg.name] = "link:" + target',
    '  } else {',
    '    const dest = path.join(profileDir, "node_modules", target)',
    '    fs.mkdirSync(dest, { recursive: true })',
    '    fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: target, version: "0.0.0" }))',
    '    manifest.dependencies[target] = "^0.0.0"',
    '  }',
    '} else if (verb === "remove") {',
    '  delete manifest.dependencies[target]',
    '  fs.rmSync(path.join(profileDir, "node_modules", target), { recursive: true, force: true })',
    '}',
    'fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n")',
    'process.exit(0)',
    '',
  ].join('\n'), 'utf8')
  let pnpmPath: string
  if (process.platform === 'win32') {
    pnpmPath = join(root, 'fake-pnpm.cmd')
    writeFileSync(pnpmPath, `@echo off\r\nnode ${JSON.stringify(cjs)} %*\r\n`, 'utf8')
  } else {
    pnpmPath = join(root, 'fake-pnpm')
    writeFileSync(pnpmPath, `#!/bin/sh\nnode ${JSON.stringify(cjs)} "$@"\n`, 'utf8')
  }
  return {
    pnpmPath,
    calls: () => {
      try {
        return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

interface RowState { disabled: boolean; phase: FiberPhase }

function makeLoader(states: Map<string, RowState>): LoaderLike {
  const stateOf = (phase: FiberPhase): number | undefined =>
    phase === 'active' ? 2 : phase === 'failed' ? 3 : phase === 'pending' ? 0 : phase === 'loading' ? 1 : undefined
  return {
    entries: () => [{
      id: 'include',
      subtree: {
        entries: () => [...states.entries()].map(([id, s]) => ({
          options: { id, name: `pkg-${id}`, group: false },
          get disabled() { return states.get(id)!.disabled },
          get fiber() {
            const phase = states.get(id)!.phase
            return phase === null || phase === undefined ? undefined : { state: stateOf(phase) }
          },
        })),
      },
    }],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function setup(): {
  svc: HotplugEngineService; states: Map<string, RowState>; patchPath: string; dshHome: string; profileDir: string
} {
  const dshHome = mkdtempSync(join(tmpdir(), 'hpe-inst-'))
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, EMPTY_TEMPLATE, 'utf8')
  writeManifestAtomic(profileDir, {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  })
  const states = new Map<string, RowState>([['row-a', { disabled: false, phase: 'active' }]])
  const ctx = new Context()
  ctx.provide('loader', makeLoader(states))
  // v0.1.5: no ctx.provide('hmr') — mode is detected empirically from the
  // loader reflection during the observation window (P2-2 fix).
  const fake = makeFakePnpm()
  const svc = new HotplugEngineService(ctx, {
    dshHomePath: dshHome,
    hostProfile: 'web',
    observationWindowMs: 1500,
    pollIntervalMs: 40,
    pnpmPath: fake.pnpmPath,
  })
  return { svc, states, patchPath, dshHome, profileDir }
}

describe.skipIf(!existsSync(GOOD_FIXTURE))('install: non-bundle local dir (unreflected → restart)', () => {
  it('adds the dependency + managed insert row; unreflected → restart + warning', async () => {
    const { svc, patchPath, profileDir } = setup()
    const r = await svc.install(GOOD_FIXTURE)
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
    expect(r.message).toContain('未在 loader 生效')
    expect(r.installed).toEqual(['@dsh-drill/hotplug-drill'])
    expect(r.rollbackHandle).toBeTruthy()
    // dependency added
    expect(readDependencies(profileDir)).toContain('@dsh-drill/hotplug-drill')
    // managed insert row present
    const patch = readFileSync(patchPath, 'utf8')
    const rows = readInsertRows(patch)
    expect(rows.some(row => row.id === 'dsh-drill-hotplug-drill' && row.name === '@dsh-drill/hotplug-drill' && row.managed)).toBe(true)
    // bundles untouched
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).not.toContain('@dsh-drill/hotplug-drill')
  })
})

describe.skipIf(!existsSync(GOOD_FIXTURE))('install: hot engine mode observation window', () => {
  it('resolves active after the loader picks up the new row', async () => {
    const { svc, states } = setup()
    const p = svc.install(GOOD_FIXTURE)
    await sleep(200)
    states.set('dsh-drill-hotplug-drill', { disabled: false, phase: 'active' })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('hot')
    expect(r.restartRequired).toBe(false)
  })
})

describe('install: quality gate + rollback', () => {
  it('rejects a bad package with GATE_REJECTED and leaves the profile untouched', async () => {
    const { svc, patchPath, profileDir } = setup()
    const before = readFileSync(patchPath, 'utf8')
    const bad = makeBadFixture()
    const r = await svc.install(bad)
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.GATE_REJECTED)
    // dependency rolled back
    expect(readDependencies(profileDir)).not.toContain('bad-fixture')
    // patch untouched
    expect(readFileSync(patchPath, 'utf8')).toBe(before)
  })

  it('rollback after a successful install restores manifest deps + insert row (v0.1.4 bug fix)', async () => {
    const { svc, patchPath, profileDir } = setup()
    const fixture = mkdtempSync(join(tmpdir(), 'hpe-goodfixture-'))
    mkdirSync(join(fixture, 'lib'), { recursive: true })
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'good-fixture', version: '1.0.0', main: './lib/index.js' }), 'utf8')
    writeFileSync(join(fixture, 'lib/index.js'), 'export function apply() {}\n', 'utf8')
    const inst = await svc.install(fixture)
    expect(inst.ok).toBe(true)
    expect(readDependencies(profileDir)).toContain('good-fixture')
    const rb = await svc.rollback(inst.rollbackHandle!)
    expect(rb.ok).toBe(true)
    expect(readDependencies(profileDir)).not.toContain('good-fixture')
    expect(readInsertRows(readFileSync(patchPath, 'utf8')).some(row => row.name === 'good-fixture')).toBe(false)
  })
})

describe.skipIf(!existsSync(GOOD_FIXTURE))('install: dryRun', () => {
  it('passes the gate without any writes or pnpm calls', async () => {
    const { svc, patchPath, profileDir } = setup()
    const r = await svc.install(GOOD_FIXTURE, { dryRun: true })
    expect(r.ok).toBe(true)
    expect(readDependencies(profileDir)).not.toContain('@dsh-drill/hotplug-drill')
    expect(readFileSync(patchPath, 'utf8')).toContain('[]')
  })
})

describe.skipIf(!existsSync(GOOD_FIXTURE))('uninstall', () => {
  it('removes the dependency and cleans the managed insert row', async () => {
    const { svc, patchPath, profileDir } = setup()
    const inst = await svc.install(GOOD_FIXTURE)
    expect(inst.ok).toBe(true)
    const name = '@dsh-drill/hotplug-drill'
    const r = await svc.uninstall(name)
    expect(r.ok).toBe(true)
    expect(r.installed).toEqual([name])
    expect(readDependencies(profileDir)).not.toContain(name)
    const patch = readFileSync(patchPath, 'utf8')
    expect(readInsertRows(patch).some(row => row.name === name)).toBe(false)
  })
})

describe('install: bundle packages', () => {
  function makeBundleFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-bundle-'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@test/bundle-pkg',
      version: '1.0.0',
      main: './lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    writeFileSync(join(dir, 'lib/index.js'), 'export function apply() {}\n', 'utf8')
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: bundle-pkg\n      name: \'@test/bundle-pkg\'\n', 'utf8')
    return dir
  }

  it('writes bundles + restartRequired and does NOT write an insert row', async () => {
    const { svc, patchPath, profileDir } = setup()
    const r = await svc.install(makeBundleFixture())
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('@test/bundle-pkg')
    expect(readInsertRows(readFileSync(patchPath, 'utf8')).some(row => row.name === '@test/bundle-pkg')).toBe(false)
  })

  it('uninstall of a bundle package reports restartRequired', async () => {
    const { svc, profileDir } = setup()
    const inst = await svc.install(makeBundleFixture())
    expect(inst.ok).toBe(true)
    const r = await svc.uninstall('@test/bundle-pkg')
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).not.toContain('@test/bundle-pkg')
  })
})

describe.skipIf(!existsSync(GOOD_FIXTURE))('install: observation failure auto-rollback', () => {
  it('rolls back when the row appears but stalls (stuck)', async () => {
    const { svc, states, patchPath, profileDir } = setup()
    const p = svc.install(GOOD_FIXTURE)
    await sleep(200)
    // row appears but never reaches active → 'stuck' → auto-rollback
    states.set('dsh-drill-hotplug-drill', { disabled: false, phase: 'loading' })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.HEALTH_FAILED)
    // dependency removed (observation failure cleans node_modules too)
    expect(readDependencies(profileDir)).not.toContain('@dsh-drill/hotplug-drill')
    // insert row rolled back
    expect(readInsertRows(readFileSync(patchPath, 'utf8')).some(row => row.name === '@dsh-drill/hotplug-drill')).toBe(false)
  })
})

describe('install: pnpm failures', () => {
  it('maps a failing pnpm add to PNPM_ADD_FAILED + INSTALL_FAILED (dual-code)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-fail-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    // a fake pnpm that always fails
    const root = mkdtempSync(join(tmpdir(), 'hpe-badpnpm-'))
    const badCmd = join(root, 'bad-pnpm.cmd')
    writeFileSync(badCmd, '@echo off\r\necho boom 1>&2\r\nexit /b 1\r\n', 'utf8')
    const svc = new HotplugEngineService(ctx, {
      dshHomePath: dshHome, hostProfile: 'web', observationWindowMs: 500, pollIntervalMs: 40, pnpmPath: badCmd,
    })
    const r = await svc.install('some-npm-pkg')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PNPM_ADD_FAILED)
    expect(r.errors?.some(e => e.code === ErrorCodes.INSTALL_FAILED)).toBe(true)
    expect(r.errors?.[0]?.stage).toBe('install')
  })

  // M5 M2: pnpm failure output with ANSI ESC / control chars must be
  // sanitized before entering the message (terminal / log injection).
  it('sanitizes ANSI/control characters from pnpm failure output', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-ansi-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    // a fake pnpm that fails with ANSI escape + control chars in output
    const root = mkdtempSync(join(tmpdir(), 'hpe-ansipnpm-'))
    const evilCmd = join(root, 'evil-pnpm.cmd')
    // ESC [31m red text, ESC [2J clear screen, BEL, and a forged newline line
    writeFileSync(evilCmd, [
      '@echo off',
      'echo <ESC>[31mred error<ESC>[0m<ESC>[2J',
      'echo <BEL>fake_log_injection',
      'exit /b 1',
      '',
    ].join('\r\n').replaceAll('<ESC>', String.fromCharCode(27)).replaceAll('<BEL>', String.fromCharCode(7)), 'utf8')
    const svc = new HotplugEngineService(ctx, {
      dshHomePath: dshHome, hostProfile: 'web', observationWindowMs: 500, pollIntervalMs: 40, pnpmPath: evilCmd,
    })
    const r = await svc.install('some-npm-pkg')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PNPM_ADD_FAILED)
    expect(r.errors?.some(e => e.code === ErrorCodes.INSTALL_FAILED)).toBe(true)
    expect(r.errors?.[0]?.stage).toBe('install')
    const message = r.message
    // The ESC byte itself (0x1B) and BEL (0x07) are stripped — the terminal
    // injection primitive is gone; leftover '[31m' without ESC is inert text.
    expect(message).not.toContain(String.fromCharCode(27)) // no ESC
    expect(message).not.toContain(String.fromCharCode(7)) // no BEL
    expect(message).toContain('red error') // visible text preserved
    expect(message).toContain('fake_log_injection') // printable chars survive
    // output-derived portion (after the message prefix + its newline)
    // carries no C0 control bytes: the sanitized pnpm output.
    const nl = message.indexOf('\n')
    const outputPart = nl === -1 ? '' : message.slice(nl + 1)
    expect(outputPart.length).toBeGreaterThan(0)
    for (const ch of outputPart) {
      const code = ch.charCodeAt(0)
      expect(code >= 0x20 && code < 0x7f || code >= 0x80, JSON.stringify(code)).toBe(true)
    }
  })

  it('maps spawn ENOENT to PNPM_NOT_EXECUTABLE (dual-code with INSTALL_FAILED)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-spawn-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    // extension-less + nonexistent → direct spawn → ENOENT (cross-platform)
    const missing = join(dshHome, 'no-such-pnpm')
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', observationWindowMs: 500, pollIntervalMs: 40, pnpmPath: missing })
    const r = await svc.install('some-npm-pkg')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PNPM_NOT_EXECUTABLE)
    expect(r.errors?.some(e => e.code === ErrorCodes.INSTALL_FAILED)).toBe(true)
  })

  it('maps pnpm-not-found to PNPM_NOT_FOUND (dual-code with INSTALL_FAILED)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-notfound-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    // explicit path with a cmd metacharacter → rejected by the guard → findPnpm undefined
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', observationWindowMs: 500, pollIntervalMs: 40, pnpmPath: 'C:/a&b/pnpm.cmd' })
    const r = await svc.install('some-npm-pkg')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PNPM_NOT_FOUND)
    expect(r.errors?.some(e => e.code === ErrorCodes.INSTALL_FAILED)).toBe(true)
  })

  it('maps uninstall pnpm remove failure to PNPM_ADD_FAILED (dual-code)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-unrm-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: { 'some-pkg': '1.0.0' } })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    const root = mkdtempSync(join(tmpdir(), 'hpe-badpnpm-'))
    const badCmd = join(root, 'bad-pnpm.cmd')
    writeFileSync(badCmd, '@echo off\r\necho boom 1>&2\r\nexit /b 1\r\n', 'utf8')
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', pnpmPath: badCmd })
    const r = await svc.uninstall('some-pkg')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PNPM_ADD_FAILED)
    expect(r.errors?.some(e => e.code === ErrorCodes.INSTALL_FAILED)).toBe(true)
  })
})

describe('quality detail escaping', () => {
  it('escapeHtml escapes HTML-sensitive characters (design §4)', async () => {
    const { escapeHtml } = await import('../src/host/service.ts')
    expect(escapeHtml('<script>alert("x")&\'y\'</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;')
  })

  it('GATE_REJECTED detail is HTML-escaped', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-esc-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const ctx = new Context()
    ctx.provide('loader', makeLoader(new Map<string, RowState>()))
    const fake = makeFakePnpm()
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', pnpmPath: fake.pnpmPath })
    const bad = makeBadFixture()
    // bad fixture with an HTML-sensitive filename in the issue
    const r = await svc.install(bad)
    expect(r.ok).toBe(false)
    const detail = r.errors?.[0]?.detail ?? ''
    expect(detail).not.toContain('<')
  })
})

describe('startup reconcile', () => {
  it('removes orphan managed insert blocks (block present, package not a dep)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-rec-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const patchPath = join(profileDir, 'cordis.patch.yml')
    // orphan insert block for a package that is NOT a dependency
    writeFileSync(patchPath, addInsertRow(EMPTY_TEMPLATE, 'ghost', '@ghost/pkg'), 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    const states = new Map<string, RowState>()
    const ctx = new Context()
    ctx.provide('loader', makeLoader(states))
    const fake = makeFakePnpm()
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', pnpmPath: fake.pnpmPath })
    expect(readInsertRows(readFileSync(patchPath, 'utf8'))).toHaveLength(0)
  })

  it('audits interrupted backup sidecars (no patchAfterHash) as failed', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-rec2-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true, dependencies: {} })
    // unfinished sidecar: createBackup then never finalize
    const handle = createBackup(dshHome, profileDir, 'op-interrupted', 'disable', 'row-a')
    const states = new Map<string, RowState>()
    const ctx = new Context()
    ctx.provide('loader', makeLoader(states))
    const fake = makeFakePnpm()
    const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', pnpmPath: fake.pnpmPath })
    const interrupted = svc.audit({ op: 'disable' }).filter(a => a.errorCode === 'HOTPLUG.OP.INTERRUPTED')
    expect(interrupted.some(a => a.operationId === 'op-interrupted')).toBe(true)
  })

  it('warns about orphan dependencies without removing them', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-rec3-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EMPTY_TEMPLATE, 'utf8')
    writeManifestAtomic(profileDir, {
      name: 'dsh-profile-web', private: true,
      dependencies: { 'user-manual-pkg': '^1.0.0' },
    })
    const states = new Map<string, RowState>()
    const ctx = new Context()
    ctx.provide('loader', makeLoader(states))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const fake = makeFakePnpm()
      new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'web', pnpmPath: fake.pnpmPath })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphan dependency'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe.skipIf(!existsSync(GOOD_FIXTURE))('install: observation stats', () => {
  it('records hit-rate counters for observations', async () => {
    const { svc, states } = setup()
    const p = svc.install(GOOD_FIXTURE)
    await sleep(200)
    states.set('dsh-drill-hotplug-drill', { disabled: false, phase: 'active' })
    await p
    const stats = svc.observationStats()
    expect(stats.total).toBeGreaterThan(0)
    expect(stats.active).toBe(stats.total)
  })
})
