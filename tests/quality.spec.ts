import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualityCheck, scanImports, LOADER_PROVIDED } from '../src/host/quality.ts'

/** Path to the reusable good fixture (drill package). */
const GOOD_FIXTURE = join(__dirname, '..', '..', 'harness-research', 'hotplug-drill')

function makeBadPackage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpe-bad-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content, 'utf8')
  }
  return dir
}

const ENTRY_OK = {
  'package.json': JSON.stringify({ name: 'bad-pkg', version: '1.0.0', main: './lib/index.js' }),
  'lib/index.js': 'export function apply() {}\n',
}

describe('quality: package gate', () => {
  it('passes the reusable good fixture (hotplug-drill)', () => {
    const result = qualityCheck(GOOD_FIXTURE)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('rejects a missing/unreadable package.json', () => {
    const dir = makeBadPackage({})
    const result = qualityCheck(dir)
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatch(/package\.json/)
  })

  it('rejects a package with no resolvable entry', () => {
    const dir = makeBadPackage({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }) })
    const result = qualityCheck(dir)
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => /no resolvable entry/i.test(i))).toBe(true)
  })

  it('rejects undeclared bare imports', () => {
    const dir = makeBadPackage({
      ...ENTRY_OK,
      'lib/index.js': 'import x from "undeclared-dep"\nexport function apply() {}\n',
    })
    const result = qualityCheck(dir)
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => /undeclared-dep/.test(i))).toBe(true)
  })

  it('allows imports the loader provides without declaration', () => {
    const dir = makeBadPackage({
      ...ENTRY_OK,
      'lib/index.js': 'import { Context } from "@deepseek-ai/cordis"\nexport function apply() {}\n',
    })
    expect(qualityCheck(dir).ok).toBe(true)
  })

  it('rejects a dsh.client declaration without a built client bundle', () => {
    const dir = makeBadPackage({
      'package.json': JSON.stringify({
        name: 'x', version: '1.0.0', main: './lib/index.js',
        dsh: { client: { platform: 'web' } },
      }),
      'lib/index.js': 'export function apply() {}\n',
    })
    const result = qualityCheck(dir)
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => /client bundle|".\/client"/.test(i))).toBe(true)
  })

  it('scanImports ignores relative and node: imports', () => {
    const dir = makeBadPackage({
      ...ENTRY_OK,
      'lib/index.js': 'import a from "./a"\nimport b from "node:fs"\nexport function apply() {}\n',
    })
    const imports = scanImports(join(dir, 'lib/index.js'))
    expect(imports).toEqual([])
  })

  it('LOADER_PROVIDED is locked to the official platform table', () => {
    expect(LOADER_PROVIDED.has('@deepseek-ai/cordis')).toBe(true)
    expect(LOADER_PROVIDED.has('react/jsx-runtime')).toBe(true)
  })
})
