/**
 * Backup / rollback handles (design §5.1-5.2 / ADR-0003).
 *
 * Every mutating operation backs up the profile's cordis.patch.yml and
 * package.json before writing. rollback() takes two paths:
 *  - Path A (no concurrent modification): current patch hash equals the
 *    after-operation hash → restore the full backup;
 *  - Path B (concurrent writer detected): hash mismatch → remove only the
 *    managed block the operation wrote (block-scoped, user rows untouched)
 *    and warn about the external modification.
 *
 * Handles are persisted as a sidecar JSON under the backup dir, so a handle
 * can be reconstructed across restarts (used by startup reconciliation).
 *
 * @module dsh-hotplug-engine/host/backup
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { EngineError, ErrorCodes } from '../contract/types.ts'
import { writeManifestAtomic, type ProfileManifest } from './manifest.ts'
import { removeManagedBlockForId, writePatchAtomic, applyRowEnabled, applyRowDisabled } from './patch.ts'

/** Short sha1 (12 hex) of a string, matching audit hash fields. */
export function hash12(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Hash of a file's content, or undefined when unreadable. */
export function hashFile(path: string): string | undefined {
  try {
    return hash12(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Persisted rollback handle (sidecar). */
export interface BackupHandle {
  operationId: string
  op: string
  /** Row id the operation targeted (block-scoped rollback). */
  targetRowId?: string
  patchPath: string
  manifestPath: string
  patchBeforeHash: string
  patchAfterHash?: string
  patchBackup: string
  manifestBackup: string
  ts: string
}

/** Backup directory root ($DSH_HOME/backups/hotplug-engine). */
export function backupDir(dshHomePath: string): string {
  return join(dshHomePath, 'backups', 'hotplug-engine')
}

/**
 * Strict rollback-handle format (M5 H2, contract §8): the ONLY accepted
 * operation-id shape is the one OperationQueue generates (queue.ts:41:
 * `op-<Date.now()>-<seq>`). Rejecting everything else closes the path
 * traversal surface before an external string can reach the filesystem.
 */
export function assertSafeOperationId(operationId: string): void {
  if (!/^op-\d+-\d+$/.test(operationId)) {
    throw new EngineError(ErrorCodes.ROLLBACK_INVALID, `invalid rollback handle: ${JSON.stringify(operationId)}`)
  }
}

function sidecarPath(dir: string, operationId: string): string {
  return join(dir, `${operationId}.json`)
}

/** Whether `candidate` resolves to a path inside `root` (defense in depth). */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  // Boundary check is segment-based: only a leading '..' segment escapes the
  // root, so legit sub-names like '...x' are never misclassified (review 2026-08-14).
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/** Create a pre-operation backup for a profile directory. */
export function createBackup(dshHomePath: string, profileDirPath: string, operationId: string, op: string, targetRowId?: string): BackupHandle {
  const dir = backupDir(dshHomePath)
  mkdirSync(dir, { recursive: true })
  const patchPath = join(profileDirPath, 'cordis.patch.yml')
  const manifestPath = join(profileDirPath, 'package.json')
  const patchContent = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const manifestContent = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
  const ts = new Date().toISOString()
  const handle: BackupHandle = {
    operationId,
    op,
    targetRowId,
    patchPath,
    manifestPath,
    patchBeforeHash: hash12(patchContent),
    patchBackup: join(dir, `${ts.replace(/[:.]/g, '-')}-${operationId}.patch.bak`),
    manifestBackup: join(dir, `${ts.replace(/[:.]/g, '-')}-${operationId}.manifest.bak`),
    ts,
  }
  writeFileSync(handle.patchBackup, patchContent, 'utf8')
  writeFileSync(handle.manifestBackup, manifestContent, 'utf8')
  persistSidecar(dir, handle)
  return handle
}

/** Record the after-operation hash once the write succeeded. */
export function finalizeBackup(dshHomePath: string, handle: BackupHandle): void {
  const after = hashFile(handle.patchPath)
  if (after !== undefined) {
    handle.patchAfterHash = after
    persistSidecar(backupDir(dshHomePath), handle)
  }
}

/**
 * Remove a finished operation's sidecar (terminal state). Once an operation
 * has been rolled back it can never be rolled back again, and leaving the
 * sidecar with `patchAfterHash === undefined` would make startup reconcile
 * re-audit it as `OP_INTERRUPTED` on every restart (P1-2). Best-effort: the
 * `.bak` files are kept (they are referenced by audit `backupPath`).
 */
export function deleteSidecar(dshHomePath: string, operationId: string): void {
  try {
    unlinkSync(sidecarPath(backupDir(dshHomePath), operationId))
  } catch {
    // already gone / unreadable — a missing sidecar is the desired end state
  }
}

/** Load a persisted handle from its operation id. */
export function loadBackup(dshHomePath: string, operationId: string): BackupHandle | undefined {
  assertSafeOperationId(operationId)
  const dir = backupDir(dshHomePath)
  const path = sidecarPath(dir, operationId)
  // Defense in depth: even a format-valid id must resolve inside the backup
  // dir (guards against any future caller that skips assertSafeOperationId).
  if (!isWithin(dir, path)) return undefined
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackupHandle
  } catch {
    return undefined
  }
}

function persistSidecar(dir: string, handle: BackupHandle): void {
  writeFileSync(sidecarPath(dir, handle.operationId), JSON.stringify(handle, null, 2) + '\n', 'utf8')
}

/**
 * M5 H2 layer 2: a rollback handle's stored paths must all stay within the
 * engine-owned roots — backups under the backup dir, targets under the
 * profiles root. Throws ROLLBACK_INVALID otherwise (tampered sidecar).
 */
function assertSafeBackupPaths(dshHomePath: string, handle: BackupHandle): void {
  const backups = backupDir(dshHomePath)
  for (const path of [handle.patchBackup, handle.manifestBackup]) {
    if (path.length === 0) continue
    if (!isWithin(backups, path)) {
      throw new EngineError(ErrorCodes.ROLLBACK_INVALID, `unsafe backup path in rollback handle: ${path}`)
    }
  }
  const profilesRoot = join(dshHomePath, 'profiles')
  for (const path of [handle.patchPath, handle.manifestPath]) {
    if (path.length === 0) continue
    if (!isWithin(profilesRoot, path)) {
      throw new EngineError(ErrorCodes.ROLLBACK_INVALID, `unsafe target path in rollback handle: ${path}`)
    }
  }
}

/**
 * Roll back an operation by its handle.
 * @returns { mode: 'restore' | 'block-scoped' } which path was taken.
 * @throws {EngineError} ROLLBACK_NOT_FOUND / ROLLBACK_FAILED.
 */
export function rollbackByHandle(dshHomePath: string, handle: BackupHandle): { mode: 'restore' | 'block-scoped' } {
  // M5 H2 layer 2: re-validate the sidecar's stored paths — they must stay
  // inside the backup dir (backups) and the profile root (targets). This
  // keeps a tampered sidecar from redirecting writes/reads outside the
  // engine's owned directories even if a valid-format id slipped through.
  assertSafeBackupPaths(dshHomePath, handle)
  let current: string
  try {
    current = readFileSync(handle.patchPath, 'utf8')
  } catch {
    current = ''
  }
  const currentHash = hash12(current)

  // Path B: a concurrent writer changed the patch since the operation.
  if (handle.targetRowId !== undefined && handle.patchAfterHash !== undefined && currentHash !== handle.patchAfterHash) {
    // 1) Block-scoped removal (managed disable/insert blocks).
    const { content, removed } = removeManagedBlockForId(current, handle.targetRowId)
    if (removed) {
      writePatchAtomic(handle.patchPath, content)
      deleteSidecar(dshHomePath, handle.operationId)
      return { mode: 'block-scoped' }
    }
    // 2) Row-level undo for user-written rows (inline disabled: toggle,
    //    no managed block): apply the inverse edit of the recorded op.
    const undone = handle.op === 'disable'
      ? applyRowEnabled(current, handle.targetRowId)
      : handle.op === 'enable'
        ? applyRowDisabled(current, handle.targetRowId)
        : { content: current, changed: false }
    if (undone.changed) {
      writePatchAtomic(handle.patchPath, undone.content)
      deleteSidecar(dshHomePath, handle.operationId)
      return { mode: 'block-scoped' }
    }
    throw new EngineError(
      ErrorCodes.ROLLBACK_FAILED,
      `no managed block or row-level undo available for ${handle.targetRowId} under concurrent modification`,
    )
  }

  // Path A: restore the full backup.
  if (!existsSync(handle.patchBackup)) {
    throw new EngineError(ErrorCodes.ROLLBACK_NOT_FOUND, `patch backup missing: ${handle.patchBackup}`)
  }
  const restoredPatch = readFileSync(handle.patchBackup, 'utf8')
  writePatchAtomic(handle.patchPath, restoredPatch)
  // Restore the manifest when it changed during the operation.
  if (existsSync(handle.manifestBackup)) {
    const manifestBefore = readFileSync(handle.manifestBackup, 'utf8')
    const manifestNow = existsSync(handle.manifestPath) ? readFileSync(handle.manifestPath, 'utf8') : ''
    if (manifestNow !== manifestBefore) {
      let parsed: ProfileManifest
      try {
        parsed = JSON.parse(manifestBefore) as ProfileManifest
      } catch {
        parsed = {}
      }
      writeManifestAtomic(dirname(handle.manifestPath), parsed)
    }
  }
  deleteSidecar(dshHomePath, handle.operationId)
  return { mode: 'restore' }
}
