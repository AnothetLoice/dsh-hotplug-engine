import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// M5 L1/L2: partial fs mock so tests can inject one-shot renameSync
// failures (Windows sharing violation) and observe tmp paths — everything
// else delegates to the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => actual.renameSync(...args)),
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => actual.writeFileSync(...args)),
  } as typeof import('node:fs')
})
import {
  EMPTY_TEMPLATE, addDisableBlock, addInsertRow, applyRowDisabled, applyRowEnabled,
  assertSafeEntryId, assertSafePackageName, ensureUniqueRowId, findTopLevelRow,
  hasManagedDisable, readInsertRows, removeDisableBlock, removeInsertRow,
  slugify, validatePatchContent, writePatchAtomic,
} from '../src/host/patch.ts'
import { EngineError, ErrorCodes } from '../src/contract/types.ts'

/** Error code thrown by a synchronous call (undefined when none thrown). */
function codeOfThrow(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof EngineError ? error.code : undefined
  }
  return undefined
}

const TEMPLATE = EMPTY_TEMPLATE
/** Comment-only base without the [] document (as after any join/normalize). */
const BASE = '# user rows\n'

describe('patch: managed insert blocks', () => {
  it('adds an insert block onto the empty template (drops the [] line)', () => {
    const next = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    expect(next).not.toContain('[]')
    expect(next).toContain('# dsh-hotplug-engine:managed:start')
    expect(next).toContain('- id: hotplug-drill')
    expect(next).toContain("name: '@dsh-drill/hotplug-drill'")
    expect(() => validatePatchContent(next)).not.toThrow()
    expect(readInsertRows(next)).toEqual([{ id: 'hotplug-drill', name: '@dsh-drill/hotplug-drill', managed: true }])
  })

  it('is idempotent for the same row id and package', () => {
    const once = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    const twice = addInsertRow(once, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    expect(twice).toBe(once)
    expect(readInsertRows(twice)).toHaveLength(1)
  })

  it('parses a MULTI-row insert block without name pollution (M4 freeze M4)', () => {
    const content = [
      '# dsh-hotplug-engine:managed:start',
      '- insert:',
      '    - id: row-a',
      "      name: 'pkg-a'",
      '    - id: row-b',
      "      name: 'pkg-b'",
      '      disabled: true',
      '# dsh-hotplug-engine:managed:end',
      '',
    ].join('\n')
    const rows = readInsertRows(content)
    expect(rows).toEqual([
      { id: 'row-a', name: 'pkg-a', managed: true },
      { id: 'row-b', name: 'pkg-b', managed: true, disabled: true },
    ])
  })

  it('removes an insert block and restores the template when empty', () => {
    const withRow = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    const { content, removed } = removeInsertRow(withRow, 'hotplug-drill')
    expect(removed).toBe(true)
    expect(content).toBe(EMPTY_TEMPLATE)
    expect(() => validatePatchContent(content)).not.toThrow()
  })

  it('keeps user rows when removing an engine block', () => {
    const user = BASE + '- id: row-a\n  config:\n    x: 1\n'
    const withBlock = addInsertRow(user, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    const { content, removed } = removeInsertRow(withBlock, 'hotplug-drill')
    expect(removed).toBe(true)
    expect(content).toContain('- id: row-a')
    expect(content).not.toContain('hotplug-drill')
  })
})

describe('patch: disable blocks', () => {
  it('adds and removes a disable block', () => {
    const next = addDisableBlock(TEMPLATE, 'ui-task-board')
    expect(hasManagedDisable(next, 'ui-task-board')).toBe(true)
    expect(next).toContain('- id: ui-task-board')
    expect(next).toContain('disabled: true')
    const back = removeDisableBlock(next, 'ui-task-board')
    expect(hasManagedDisable(back, 'ui-task-board')).toBe(false)
    expect(back).toBe(EMPTY_TEMPLATE)
  })

  it('refreshes in place (no duplicate blocks)', () => {
    const once = addDisableBlock(TEMPLATE, 'ui-task-board')
    const twice = addDisableBlock(once, 'ui-task-board')
    expect((twice.match(/dsh-hotplug-engine:managed:start/g) ?? []).length).toBe(1)
  })

  it('targets a managed insert row (disable block added, insert block preserved)', () => {
    const withInsert = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    const disabled = addDisableBlock(withInsert, 'hotplug-drill')
    expect(readInsertRows(disabled)).toHaveLength(1) // insert preserved (review 2026-08-14)
    expect(hasManagedDisable(disabled, 'hotplug-drill')).toBe(true)
  })
})

describe('patch: user-row enable/disable (column-0 only)', () => {
  const USER_ROW = BASE + '- id: row-a\n  config:\n    x: 1\n'

  it('findTopLevelRow finds a user row and ignores indented children', () => {
    const withChild = BASE + '- insert:\n    - id: child-a\n      name: pkg\n' + '- id: row-a\n  config:\n    x: 1\n'
    expect(findTopLevelRow(withChild, 'row-a')).toEqual({ managed: false })
    expect(findTopLevelRow(withChild, 'child-a')).toBeUndefined()
    const blocked = addDisableBlock(TEMPLATE, 'row-b')
    expect(findTopLevelRow(blocked, 'row-b')).toEqual({ managed: true })
  })

  it('applyRowDisabled adds disabled:true to a user row', () => {
    const { content, changed } = applyRowDisabled(USER_ROW, 'row-a')
    expect(changed).toBe(true)
    expect(content).toContain('- id: row-a')
    expect(content).toContain('disabled: true')
    expect(content).toContain('config:')
    expect(() => validatePatchContent(content)).not.toThrow()
  })

  it('applyRowDisabled does not touch an indented insert child with the same id', () => {
    const child = BASE + '- insert:\n    - id: row-a\n      name: pkg\n'
    const { content, changed } = applyRowDisabled(child, 'row-a')
    // The child row lives at 4-space indent; the row-level edit must not match.
    expect(changed).toBe(false)
    expect(content).toBe(child)
  })

  it('applyRowEnabled drops the disabled child', () => {
    const disabled = applyRowDisabled(USER_ROW, 'row-a').content
    const { content, changed } = applyRowEnabled(disabled, 'row-a')
    expect(changed).toBe(true)
    expect(content).not.toContain('disabled:')
    expect(content).toContain('- id: row-a')
  })

  it('applyRowEnabled is a no-op when already enabled', () => {
    const { content, changed } = applyRowEnabled(USER_ROW, 'row-a')
    expect(changed).toBe(false)
    expect(content).toBe(USER_ROW)
  })

  it('does NOT corrupt nested `disabled` keys in user config (review 2026-08-14)', () => {
    const nested = BASE + [
      '- id: row-a',
      '  config:',
      '    features:',
      '      context:',
      '        disabled: true',
      '',
    ].join('\n')
    const { content, changed } = applyRowDisabled(nested, 'row-a')
    expect(changed).toBe(true)
    // the nested key keeps its indentation and value
    expect(content).toContain('        disabled: true')
    // the direct child toggle was added
    expect(content).toContain('  disabled: true')
    // the nesting structure is untouched
    expect(content).toContain('    features:')
    expect(content).toContain('      context:')
    // and enable does not drop the nested key either
    const { content: enabled, changed: changed2 } = applyRowEnabled(content, 'row-a')
    expect(changed2).toBe(true)
    expect(enabled).toContain('        disabled: true')
    expect(enabled).toContain('    features:')
  })

  it('managed insert rows survive a disable round-trip (review 2026-08-14)', () => {
    const withInsert = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    // disable: add a disable block WITHOUT removing the insert block
    const disabled = addDisableBlock(withInsert, 'hotplug-drill')
    expect(readInsertRows(disabled)).toHaveLength(1) // insert survives
    expect(hasManagedDisable(disabled, 'hotplug-drill')).toBe(true)
    // enable: remove only the disable block → insert still present
    const enabled = removeDisableBlock(disabled, 'hotplug-drill')
    expect(readInsertRows(enabled)).toHaveLength(1)
    expect(hasManagedDisable(enabled, 'hotplug-drill')).toBe(false)
    expect(enabled).toContain("name: '@dsh-drill/hotplug-drill'")
  })

  it('engine-written rows never contain !!js expressions', () => {
    // Assert on the managed block portion only (the official template's
    // comment legitimately mentions `!!js`).
    const withRow = addInsertRow(TEMPLATE, 'p', '@scope/pkg')
    const rowBlock = withRow.slice(withRow.indexOf('# dsh-hotplug-engine:managed:start'))
    expect(rowBlock).not.toMatch(/!!js/)
    const disabled = addDisableBlock(withRow, 'p')
    const disabledBlock = disabled.slice(disabled.indexOf('# dsh-hotplug-engine:managed:start'))
    expect(disabledBlock).not.toMatch(/!!js/)
  })
})

describe('patch: whitelists (npm naming convention)', () => {
  it('assertSafePackageName rejects injection-prone names', () => {
    for (const bad of ["pkg'name", 'a:b', 'Uppercase', 'a b', 'a\tb', 'a\u0000b', '', 'x'.repeat(201), '../pkg']) {
      expect(codeOfThrow(() => assertSafePackageName(bad)), JSON.stringify(bad)).toBe(ErrorCodes.PATCH_UNSAFE_VALUE)
    }
  })

  it('assertSafePackageName accepts valid npm names', () => {
    for (const good of ['pkg', '@scope/pkg', '@s/p-1.2_3~x', 'a-b.c_d']) {
      expect(() => assertSafePackageName(good), JSON.stringify(good)).not.toThrow()
    }
  })

  it('assertSafeEntryId rejects unsafe ids', () => {
    for (const bad of ['a!b', 'a b', '', 'x'.repeat(121)]) {
      expect(codeOfThrow(() => assertSafeEntryId(bad)), JSON.stringify(bad)).toBe(ErrorCodes.PATCH_UNSAFE_TARGET)
    }
    for (const good of ['row-a', 'ui.task/board', 'a.b-c']) {
      expect(() => assertSafeEntryId(good), JSON.stringify(good)).not.toThrow()
    }
  })
})

describe('patch: slugify + row id collisions', () => {
  it('slugifies scoped names', () => {
    expect(slugify('@scope/pkg')).toBe('scope-pkg')
    expect(slugify('@a/b')).toBe('a-b')
    expect(slugify('dsh-ssh')).toBe('dsh-ssh')
  })

  it('ensureUniqueRowId disambiguates collisions with a hash suffix', () => {
    const existing = addInsertRow(TEMPLATE, 'a-b', '@a/b')
    const unique = ensureUniqueRowId(existing, 'a-b', '@x-y')
    expect(unique).not.toBe('a-b')
    expect(unique).toMatch(/^a-b-[0-9a-f]{8}$/)
    // No collision → unchanged
    expect(ensureUniqueRowId(existing, 'a-b', '@a/b')).toBe('a-b')
  })
})

describe('patch: validation + atomic write', () => {
  it('validatePatchContent accepts an array and rejects others', () => {
    expect(() => validatePatchContent('[]')).not.toThrow()
    expect(codeOfThrow(() => validatePatchContent('# only comments\n'))).toBe(ErrorCodes.PATCH_INVALID)
    expect(codeOfThrow(() => validatePatchContent('not: an array'))).toBe(ErrorCodes.PATCH_INVALID)
    expect(codeOfThrow(() => validatePatchContent('- id: x\n  config: [unclosed'))).toBe(ErrorCodes.PATCH_INVALID)
  })

  it('writePatchAtomic writes and read-backs; invalid content throws without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-patch-'))
    const file = join(dir, 'cordis.patch.yml')
    const content = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    writePatchAtomic(file, content)
    expect(readFileSync(file, 'utf8')).toBe(content)
    const before = readFileSync(file, 'utf8')
    expect(codeOfThrow(() => writePatchAtomic(file, '- id: broken\n  x: ['))).toBe(ErrorCodes.PATCH_INVALID)
    expect(readFileSync(file, 'utf8')).toBe(before) // untouched
  })

  // M5 L1: the sync rename retry must survive a transient rename failure
  // (Windows sharing violation) and converge within the tightened budget.
  it('writePatchAtomic retries a transient rename failure (M5 L1 budget)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-retry-'))
    const file = join(dir, 'cordis.patch.yml')
    const content = addInsertRow(TEMPLATE, 'hotplug-drill', '@dsh-drill/hotplug-drill')
    const spy = vi.mocked(renameSync)
    spy.mockClear() // ignore calls from earlier tests (shared module mock)
    // Fail the first rename with EACCES (the HMR watcher briefly holds the
    // target); the retry loop must converge on the next attempt.
    spy.mockImplementationOnce(() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    })
    writePatchAtomic(file, content)
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(spy).toHaveBeenCalledTimes(2) // failed attempt + successful retry
    spy.mockClear()
  })

  // M5 L2: tmp names use a crypto-random hex suffix (unique, non-guessable).
  it('writePatchAtomic tmp names carry a crypto hex suffix, unique per write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-tmp-'))
    const file = join(dir, 'cordis.patch.yml')
    // Capture every tmp path the atomic writer touches (before rename).
    const writeSpy = vi.mocked(writeFileSync)
    const tmpPaths: string[] = []
    const orig = writeSpy.getMockImplementation()
    writeSpy.mockImplementation((p, data, opts) => {
      const path = String(p)
      if (path.endsWith('.tmp')) tmpPaths.push(path)
      return orig ? orig(p, data, opts) : undefined
    })
    try {
      for (let i = 0; i < 5; i += 1) {
        writePatchAtomic(file, addInsertRow(TEMPLATE, `row-${i}`, `pkg-${i}`))
      }
      expect(tmpPaths.length).toBe(5)
      // format: <patchPath>.<pid>.<16 hex>.tmp (crypto random, full 64-bit)
      const hexRe = /^[0-9a-f]{16}$/
      const suffixes = tmpPaths.map(p => p.match(/\.([0-9a-f]{16})\.tmp$/)?.[1] ?? '')
      for (const s of suffixes) expect(hexRe.test(s), s).toBe(true)
      // uniqueness across the five writes (collision probability ~2^-64)
      expect(new Set(suffixes).size).toBe(5)
    } finally {
      writeSpy.mockImplementation(orig ?? (() => {}))
      writeSpy.mockClear()
    }
    // no .tmp residue after successful writes
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(file, 'utf8')).toContain('row-4')
  })
})

describe('patch: YAML dialect traps', () => {
  it('a comments-only document is rejected (null document)', () => {
    expect(codeOfThrow(() => validatePatchContent('# your patch layer\n# nothing here\n'))).toBe(ErrorCodes.PATCH_INVALID)
  })

  it('scoped package names are single-quoted (@ is a YAML indicator)', () => {
    const next = addInsertRow(TEMPLATE, 'p', '@scope/pkg')
    expect(next).toContain("name: '@scope/pkg'")
  })
})
