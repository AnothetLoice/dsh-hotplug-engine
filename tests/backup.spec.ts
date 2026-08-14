import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBackup, finalizeBackup, hash12, loadBackup, rollbackByHandle, backupDir,
} from '../src/host/backup.ts'
import { EMPTY_TEMPLATE, addInsertRow, readInsertRows } from '../src/host/patch.ts'
import { writeManifestAtomic } from '../src/host/manifest.ts'

function setup(): { dshHome: string; profileDir: string; patchPath: string } {
  const dshHome = mkdtempSync(join(tmpdir(), 'hpe-home-'))
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, EMPTY_TEMPLATE, 'utf8')
  writeManifestAtomic(profileDir, { name: 'dsh-profile-web', private: true })
  return { dshHome, profileDir, patchPath }
}

describe('backup: handles and sidecars', () => {
  it('creates backup files and a persisted sidecar', () => {
    const { dshHome, profileDir } = setup()
    const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const handle = createBackup(dshHome, profileDir, 'op-1', 'disable', 'row-a')
    expect(handle.patchBeforeHash).toBe(hash12(before))
    expect(handle.targetRowId).toBe('row-a')
    // sidecar persists
    const loaded = loadBackup(dshHome, 'op-1')
    expect(loaded?.operationId).toBe('op-1')
    expect(loaded?.patchBackup).toBe(handle.patchBackup)
  })

  it('finalizeBackup records the after hash', () => {
    const { dshHome, profileDir, patchPath } = setup()
    const handle = createBackup(dshHome, profileDir, 'op-2', 'disable', 'row-a')
    writeFileSync(patchPath, addInsertRow(EMPTY_TEMPLATE, 'row-a', 'pkg'), 'utf8')
    finalizeBackup(dshHome, handle)
    expect(handle.patchAfterHash).toBe(hash12(readFileSync(patchPath, 'utf8')))
  })
})

describe('backup: rollback paths', () => {
  it('path A restores the full backup when nothing changed concurrently', () => {
    const { dshHome, profileDir, patchPath } = setup()
    const before = readFileSync(patchPath, 'utf8')
    const handle = createBackup(dshHome, profileDir, 'op-3', 'disable', 'row-a')
    writeFileSync(patchPath, addInsertRow(EMPTY_TEMPLATE, 'row-a', 'pkg'), 'utf8')
    finalizeBackup(dshHome, handle)
    const { mode } = rollbackByHandle(dshHome, handle)
    expect(mode).toBe('restore')
    expect(readFileSync(patchPath, 'utf8')).toBe(before)
  })

  it('path B removes only the managed block when a concurrent writer changed the patch', () => {
    const { dshHome, profileDir, patchPath } = setup()
    const handle = createBackup(dshHome, profileDir, 'op-4', 'disable', 'row-a')
    const withBlock = addInsertRow(EMPTY_TEMPLATE, 'row-a', 'pkg')
    writeFileSync(patchPath, withBlock, 'utf8')
    finalizeBackup(dshHome, handle)
    // External concurrent writer appends a user row.
    const concurrent = withBlock + '- id: user-row\n  config:\n    x: 1\n'
    writeFileSync(patchPath, concurrent, 'utf8')
    const { mode } = rollbackByHandle(dshHome, handle)
    expect(mode).toBe('block-scoped')
    const after = readFileSync(patchPath, 'utf8')
    expect(after).toContain('- id: user-row') // user content preserved
    expect(readInsertRows(after)).toHaveLength(0) // engine block removed
  })

  it('path B undoes a user-row inline toggle when a concurrent writer changed the patch', () => {
    const { dshHome, profileDir, patchPath } = setup()
    // user row in the initial patch
    const userBase = '# user\n- id: row-a\n  config:\n    x: 1\n'
    writeFileSync(patchPath, userBase, 'utf8')
    const handle = createBackup(dshHome, profileDir, 'op-6', 'disable', 'row-a')
    // the disable op edits the user row inline (no managed block)
    const disabled = '# user\n- id: row-a\n  config:\n    x: 1\n  disabled: true\n'
    writeFileSync(patchPath, disabled, 'utf8')
    finalizeBackup(dshHome, handle)
    // concurrent writer appends another row
    writeFileSync(patchPath, disabled + '- id: user-row-2\n  config:\n    y: 2\n', 'utf8')
    const { mode } = rollbackByHandle(dshHome, handle)
    expect(mode).toBe('block-scoped')
    const after = readFileSync(patchPath, 'utf8')
    expect(after).toContain('- id: user-row-2') // concurrent content preserved
    expect(after).not.toContain('  disabled: true') // inline toggle undone
  })

  it('throws ROLLBACK_NOT_FOUND for a missing backup file', () => {
    const { dshHome, profileDir, patchPath } = setup()
    const handle = createBackup(dshHome, profileDir, 'op-5', 'disable', 'row-a')
    writeFileSync(patchPath, addInsertRow(EMPTY_TEMPLATE, 'row-a', 'pkg'), 'utf8')
    finalizeBackup(dshHome, handle)
    // Remove the backup files to simulate loss.
    rmSync(handle.patchBackup, { force: true })
    expect(() => rollbackByHandle(dshHome, handle)).toThrow()
  })
})

describe('backup: dir', () => {
  it('resolves the backup dir under the dsh home', () => {
    expect(backupDir('C:/x')).toBe(join('C:/x', 'backups', 'hotplug-engine'))
  })
})
