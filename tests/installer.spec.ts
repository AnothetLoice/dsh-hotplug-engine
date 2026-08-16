import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  assertSafeSpec, findPnpm, findPnpmCandidates, packageHasBundlePatch, resolveInstalledName, runPnpm,
} from '../src/host/installer.ts'
import { EngineError, ErrorCodes } from '../src/contract/types.ts'

function codeOfThrow(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof EngineError ? error.code : undefined
  }
  return undefined
}

describe('installer: spec safety', () => {
  it('rejects cmd metacharacters (including %) and empty specs', () => {
    for (const bad of ['a&calc', 'a|b', 'a<b', 'a>b', 'a^b', 'a"b', '%PATH%', 'a%', '', 'x'.repeat(501)]) {
      expect(codeOfThrow(() => assertSafeSpec(bad)), JSON.stringify(bad)).toBe(ErrorCodes.SPEC_UNSAFE)
    }
  })

  it('accepts npm names, paths, and git URLs', () => {
    for (const good of ['dsh-ssh', '@scope/pkg', './local-dir', '/abs/path', 'git+https://github.com/x/y.git', 'file:./x']) {
      expect(() => assertSafeSpec(good), JSON.stringify(good)).not.toThrow()
    }
  })
})

describe('installer: name resolution', () => {
  it('resolves exact specs and locator values', () => {
    expect(resolveInstalledName({ '@dsh-drill/hotplug-drill': 'link:../drill' }, '../drill')).toBe('@dsh-drill/hotplug-drill')
    expect(resolveInstalledName({ '@dsh-drill/hotplug-drill': 'link:../drill' }, '@dsh-drill/hotplug-drill')).toBe('@dsh-drill/hotplug-drill')
    expect(resolveInstalledName({}, 'missing')).toBeNull()
  })

  it('detects bundle shape from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-pkg-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }), 'utf8')
    expect(packageHasBundlePatch(dir)).toBe(true)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    expect(packageHasBundlePatch(dir)).toBe(false)
  })
})

describe('installer: findPnpm', () => {
  it('returns the explicit path', () => {
    expect(findPnpm('C:/custom/pnpm.cmd')).toBe('C:/custom/pnpm.cmd')
  })

  it('finds pnpm on PATH (the harness .tools bin is on PATH in this environment)', () => {
    const found = findPnpm()
    expect(found).toBeTruthy()
  })
})

describe('installer: runPnpm (real spawn)', () => {
  it('runs a fake pnpm .cmd/.sh and captures argv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hpe-fakepnpm-'))
    const output = join(root, 'argv.json')
    const cjs = join(root, 'fake.cjs')
    writeFileSync(cjs, [
      'const fs = require("node:fs")',
      `const out = ${JSON.stringify(output)}`,
      'fs.writeFileSync(out, JSON.stringify(process.argv.slice(2)))',
      'process.exit(0)',
      '',
    ].join('\n'), 'utf8')
    let script: string
    if (process.platform === 'win32') {
      script = join(root, 'fake-pnpm.cmd')
      writeFileSync(script, `@echo off\r\nnode ${JSON.stringify(cjs)} %*\r\n`, 'utf8')
    } else {
      script = join(root, 'fake-pnpm')
      writeFileSync(script, `#!/bin/sh\nnode ${JSON.stringify(cjs)} "$@"\n`, 'utf8')
    }
    const result = await runPnpm(script, ['--dir', 'C:/profiles/web', 'add', 'dsh-ssh'], { cwd: root })
    expect(result.ok).toBe(true)
    const argv = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(output, 'utf8'))) as string[]
    expect(argv).toContain('--dir')
    expect(argv).toContain('dsh-ssh')
  })
})

describe('installer: findPnpm discovery (v0.1.4)', () => {
  const withPath = (dir: string, fn: () => void): void => {
    const prev = process.env.PATH
    process.env.PATH = dir + delimiter + (prev ?? '')
    try { fn() } finally { process.env.PATH = prev }
  }

  it('rejects an explicit path containing cmd metacharacters', () => {
    expect(findPnpm('C:/a&b/pnpm.cmd')).toBeUndefined()
    expect(findPnpmCandidates('C:/a&b/pnpm.cmd')).toEqual([])
  })

  it('lists candidates and prefers PATHEXT order on Windows (exe > cmd > extension-less)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-disc-'))
    writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\n', 'utf8')
    writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\n', 'utf8')
    writeFileSync(join(dir, 'pnpm.exe'), 'MZ', 'utf8')
    withPath(dir, () => {
      const found = findPnpm()
      const names = findPnpmCandidates().filter(c => c.startsWith(dir)).map(c => c.slice(dir.length + 1))
      if (process.platform === 'win32') {
        expect(names[0]).toBe('pnpm.exe')
        expect(names).toContain('pnpm.cmd')
        expect(names[names.length - 1]).toBe('pnpm')
        expect(found).toBe(join(dir, 'pnpm.exe'))
      } else {
        expect(found).toBe(join(dir, 'pnpm'))
        expect(names).toEqual(['pnpm'])
      }
    })
  })

  it('finds pnpm in a custom PATH dir via the platform delimiter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-path-'))
    writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\n', 'utf8')
    withPath(dir, () => {
      expect(findPnpm()).toBe(join(dir, 'pnpm.cmd'))
      expect(findPnpmCandidates()).toContain(join(dir, 'pnpm.cmd'))
    })
  })
})
