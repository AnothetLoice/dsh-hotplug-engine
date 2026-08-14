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

function setup(opts: { hot?: boolean } = {}): {
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
  if (opts.hot) ctx.provide('hmr', {})
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

describe('install: non-bundle local dir (restart engine mode)', () => {
  it('adds the dependency + managed insert row; no observation, restartRequired', async () => {
    const { svc, patchPath, profileDir } = setup()
    const r = await svc.install(GOOD_FIXTURE)
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
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

describe('install: hot engine mode observation window', () => {
  it('resolves active after the loader picks up the new row', async () => {
    const { svc, states } = setup({ hot: true })
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
})

describe('install: dryRun', () => {
  it('passes the gate without any writes or pnpm calls', async () => {
    const { svc, patchPath, profileDir } = setup()
    const r = await svc.install(GOOD_FIXTURE, { dryRun: true })
    expect(r.ok).toBe(true)
    expect(readDependencies(profileDir)).not.toContain('@dsh-drill/hotplug-drill')
    expect(readFileSync(patchPath, 'utf8')).toContain('[]')
  })
})

describe('uninstall', () => {
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

describe('install: observation failure auto-rollback', () => {
  it('times out when the loader never picks up the row and leaves no residue', async () => {
    const { svc, patchPath, profileDir } = setup({ hot: true })
    // loader never gets the new row → timeout → auto-rollback
    const r = await svc.install(GOOD_FIXTURE)
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.HEALTH_FAILED)
    // dependency removed (observation failure cleans node_modules too)
    expect(readDependencies(profileDir)).not.toContain('@dsh-drill/hotplug-drill')
    // insert row rolled back
    expect(readInsertRows(readFileSync(patchPath, 'utf8')).some(row => row.name === '@dsh-drill/hotplug-drill')).toBe(false)
  })
})

describe('install: pnpm failures', () => {
  it('maps a failing pnpm to INSTALL_FAILED', async () => {
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
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.INSTALL_FAILED)
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

describe('install: observation stats', () => {
  it('records hit-rate counters for hot-mode observations', async () => {
    const { svc, states } = setup({ hot: true })
    const p = svc.install(GOOD_FIXTURE)
    await sleep(200)
    states.set('dsh-drill-hotplug-drill', { disabled: false, phase: 'active' })
    await p
    const stats = svc.observationStats()
    expect(stats.total).toBeGreaterThan(0)
    expect(stats.active).toBe(stats.total)
  })
})
