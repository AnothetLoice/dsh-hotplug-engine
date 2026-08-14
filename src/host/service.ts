/**
 * HotplugEngineService — the ctx.hotplugEngine contract implementation
 * (01-contract §4). M1 scope: snapshot / status / enable / disable /
 * rollback / listOperations / onEvent, with serial queue, backup +
 * block-scoped rollback, observation-window health confirmation and JSONL
 * audit. REST / SSE / tools / install arrive in M2-M3.
 *
 * @module dsh-hotplug-engine/host/service
 */

import { Service } from '@deepseek-ai/cordis'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EngineError, ErrorCodes,
  type MutationResult, type EngineSnapshot, type RuntimeEntry,
  type OperationInfo, type OperationOp, type AuditRecord, type EngineEvent,
  type FiberPhase,
} from '../contract/types.ts'
import {
  assertSafeEntryId, assertSafePackageName, addDisableBlock, addInsertRow, applyRowDisabled, applyRowEnabled,
  blockRowIds, ensureUniqueRowId, findTopLevelRow, hasManagedDisable, readInsertRows,
  removeDisableBlock, removeManagedBlockForId, slugify,
  writePatchAtomic, patchPathOf,
} from './patch.ts'
import {
  dshHome, detectHostProfile, isOfficialProfile, profileDirIn,
  readBundles, readDependencies, readManifest, readPatch,
  restoreInBoxBundles, withBundleAdded, withBundleRemoved, writeManifestAtomic,
  IN_BOX_BUNDLES,
} from './manifest.ts'
import {
  createBackup, finalizeBackup, loadBackup, rollbackByHandle,
  backupDir, hashFile, hash12, type BackupHandle,
} from './backup.ts'
import {
  readFiberPhase, rowExists, waitForGone, waitForHealthWithBlock, waitForStable,
  includeRows, phaseOf, isStableRowId, type LoaderLike,
} from './health.ts'
import { OperationQueue } from './queue.ts'
import { AuditLog } from './audit.ts'
import { qualityCheck } from './quality.ts'
import {
  assertSafeSpec, findPnpm, isLocalDirSpec, packageHasBundlePatch,
  pnpmAdd, pnpmRemove, resolveInstalledName,
} from './installer.ts'

/** Service options (tests inject a temp DSH home / host profile). */
export interface HotplugEngineServiceOptions {
  dshHomePath?: string
  hostProfile?: string
  observationWindowMs?: number
  pollIntervalMs?: number
  /** Phase-monitor poll cadence for `entry` events (contract §7); 0 disables. */
  phasePollMs?: number
  /** Explicit pnpm executable path (overrides PATH discovery). */
  pnpmPath?: string
}

/** Common mutating-op options. `caller` is transport-internal audit
 * provenance (REST → 'rest', tools → 'tool'); defaults to 'service'. */
export interface MutateOpts {
  profile?: string
  caller?: AuditRecord['caller']
}

/** Observation-window hit-rate counters (8s default calibration, design §5.3).
 * `rollback` counts post-rollback stabilization waits separately so they do
 * not pollute the install/enable calibration data. */
export interface ObservationStats {
  total: number
  active: number
  failed: number
  timeout: number
  rollback: number
}

/**
 * The hot-plug execution engine service.
 */
export class HotplugEngineService extends Service {
  /** Engine runtime mode (contract §9.1): config HMR availability. */
  readonly mode: 'hot' | 'restart'

  private readonly queue = new OperationQueue()
  private readonly auditLog: AuditLog
  private readonly dshHomePath: string
  private readonly hostProfile: string | undefined
  private readonly observationWindowMs: number
  private readonly pollIntervalMs: number
  private readonly pnpmPath: string | undefined
  private readonly healthStats: ObservationStats = { total: 0, active: 0, failed: 0, timeout: 0, rollback: 0 }
  private readonly operations = new Map<string, OperationInfo>()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  /** Last-known phases of managed rows (entry-event change detection, §7). */
  private readonly lastPhases = new Map<string, FiberPhase>()
  private phaseTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: unknown, options: HotplugEngineServiceOptions = {}) {
    // Service base resolves the name via super(ctx, name) (cordis provider).
    super(ctx as never, 'hotplugEngine')
    this.dshHomePath = options.dshHomePath ?? dshHome()
    this.hostProfile = options.hostProfile ?? detectHostProfile()
    this.observationWindowMs = options.observationWindowMs ?? 8000
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.pnpmPath = options.pnpmPath
    const hmr = (ctx as { get?: (name: string) => unknown }).get?.('hmr')
    // T2.0 verified 2026-08-14: cordis-plugin-hmr registers its service as
    // "hmr" (super(ctx, 'hmr')), so this probe is exact.
    this.mode = hmr === undefined ? 'restart' : 'hot'
    this.auditLog = new AuditLog(join(this.dshHomePath, 'logs', 'hotplug-engine'))
    this.startupReconcile()
    this.startPhaseMonitor(options.phasePollMs)
  }

  /** Observation-window hit-rate stats (diagnostic, 8s calibration). */
  observationStats(): ObservationStats {
    return { ...this.healthStats }
  }

  // ── state surface ────────────────────────────────────────────────────────

  /** Full state projection (official tree is the single source of truth for
   * the HOST profile; non-host profiles project from their files — they are
   * not running in this process, so no loader/fiber states exist). */
  snapshot(profile?: string): EngineSnapshot {
    const name = this.resolveProfile(profile)
    const isHost = this.isHostProfile(name)
    const dir = this.dirOf(name)
    const patchContent = readPatch(dir)
    const bundles = readBundles(dir)
    const deps = readDependencies(dir)
    const insertRows = readInsertRows(patchContent).map(row => ({ id: row.id, name: row.name, managed: row.managed }))
    const insertIds = new Set(insertRows.filter(row => row.managed).map(row => row.id))
    const entries: RuntimeEntry[] = isHost
      ? includeRows(this.loader())
          .filter(row => row.options?.id !== undefined)
          .map((row): RuntimeEntry => {
            const entryId = row.options!.id!
            const moduleName = row.options?.name ?? ''
            const managed = insertIds.has(entryId)
            const source = bundles.includes(moduleName) ? 'bundle' : managed ? 'insert' : 'user'
            return {
              entryId,
              moduleName,
              source,
              enabled: !row.disabled,
              patchTargetable: isStableRowId(entryId),
              fiberPhase: phaseOf(row.fiber?.state),
              managed,
            }
          })
      : // Non-host: file-based projection (patch insert rows; no fiber).
          readInsertRows(patchContent).map((row): RuntimeEntry => ({
            entryId: row.id,
            moduleName: row.name,
            source: bundles.includes(row.name) ? 'bundle' : row.managed ? 'insert' : 'user',
            enabled: !(row.disabled ?? false),
            patchTargetable: true,
            fiberPhase: null,
            managed: row.managed,
          }))
    const packages = deps.map(name => ({
      name,
      isBundle: bundles.includes(name),
      version: versionOf(dir, name),
    }))
    return {
      profile: name,
      // Non-host targets are file/restart-committed: their engine mode is
      // not this process's mode (M4 freeze arch review M3).
      mode: isHost ? this.mode : 'restart',
      entries,
      packages,
      insertRows,
      // Audit lag indicator (design §6 / M4 T4.1): sticky once a write
      // failed, so consumers know the trail may be incomplete.
      auditLag: this.auditLog.lag,
    }
  }

  /** Audit lag indicator: true when a JSONL write failed at some point
   * (additive contract §4 method, M4 T4.1). */
  auditLag(): boolean {
    return this.auditLog.lag
  }

  /** Single-row health view. */
  status(entryId?: string, profile?: string): RuntimeEntry | undefined {
    const snap = this.snapshot(profile)
    if (entryId === undefined) return undefined
    return snap.entries.find(entry => entry.entryId === entryId)
  }

  /** Operation history (most recent last). */
  listOperations(): OperationInfo[] {
    return [...this.operations.values()]
  }

  /** Query the audit trail (contract §4). */
  audit(query: { op?: string; from?: string; limit?: number } = {}): AuditRecord[] {
    return this.auditLog.query(query)
  }

  /** Subscribe to engine events (SSE transport arrives in M3). */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ── mutating surface (M1: enable / disable / rollback) ──────────────────

  /** Enable one include row (stable id). Resolves after observation-window
   * confirmation on the HOST profile — ok:true means APPLIED, not queued
   * (contract §4). Non-host profiles: file-only, restart-required. */
  enable(entryId: string, opts: MutateOpts = {}): Promise<MutationResult> {
    return this.mutateRow('enable', entryId, opts, (dir, id) => this.writeEnable(dir, id), (dir, id) => this.observeEnable(dir, id))
  }

  /** Disable one include row (stable id). */
  disable(entryId: string, opts: MutateOpts = {}): Promise<MutationResult> {
    return this.mutateRow('disable', entryId, opts, (dir, id) => this.writeDisable(dir, id), (dir, id) => this.observeDisable(dir, id))
  }

  /** Roll back a mutating operation by its handle (operation id). */
  rollback(handle: string, opts: MutateOpts = {}): Promise<MutationResult> {
    let dir: string
    let isHost: boolean
    try {
      const target = this.resolveProfile(opts.profile)
      dir = this.dirOf(target)
      isHost = this.isHostProfile(target)
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    const caller = opts.caller ?? 'service'
    let queued: { operationId: string; done: Promise<void> }
    try {
      queued = this.queue.enqueue('rollback', handle, async () => {
        const operationId = queued.operationId
        const started = new Date().toISOString()
        this.setOperation(operationId, 'rollback', handle, 'running', started)
        let loaded: BackupHandle | undefined
        try {
          loaded = loadBackup(this.dshHomePath, handle)
          if (loaded === undefined) {
            throw new EngineError(ErrorCodes.ROLLBACK_NOT_FOUND, `no backup for handle ${handle}`)
          }
          const { mode } = rollbackByHandle(this.dshHomePath, loaded)
          // Post-rollback stabilization reads the host loader — skip for
          // non-host targets (not running here).
          if (isHost) await this.waitStable(dir, loaded.targetRowId)
          const finished = new Date().toISOString()
          const effective = this.effectiveMode()
          const result: MutationResult = {
            ok: true,
            message: `rollback ${handle} succeeded (${mode})`,
            operationId,
            mode: effective.mode,
            restartRequired: effective.restartRequired,
          }
          this.auditLog.append(this.auditRecord(operationId, 'rollback', loaded.targetRowId, 'succeeded', caller, loaded))
          this.recordResult(operationId, result, finished)
          this.emit({ type: 'operation', operationId, op: 'rollback', status: 'succeeded', ts: finished })
        } catch (error) {
          await this.failWithRollback(operationId, 'rollback', handle, loaded, caller, error)
        }
      })
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    return queued.done.then(() => this.operations.get(queued.operationId)?.result ?? failureResult(new EngineError(ErrorCodes.OP_CONFLICT, 'lost operation result')))
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Install a plugin (design §3 / contract §9.2): quality gate → pnpm →
   * bundle (restart) or managed insert row (hot) → observation window (host
   * profile only; non-host installs are file/restart-committed). */
  install(spec: string, opts: { profile?: string; dryRun?: boolean; caller?: AuditRecord['caller'] } = {}): Promise<MutationResult> {
    let dir: string
    let isHost: boolean
    try {
      const target = this.resolveProfile(opts.profile)
      dir = this.dirOf(target)
      isHost = this.isHostProfile(target)
      assertSafeSpec(spec)
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    if (opts.dryRun === true) {
      return Promise.resolve(this.dryRunInstall(dir, spec))
    }
    const caller = opts.caller ?? 'service'
    let queued: { operationId: string; done: Promise<void> }
    try {
      queued = this.queue.enqueue('install', spec, async () => {
        const operationId = queued.operationId
        const started = new Date().toISOString()
        this.setOperation(operationId, 'install', spec, 'running', started)
        let handle: BackupHandle | undefined
        let pnpm: string | undefined
        let installedName: string | undefined
        try {
          // Pre-gate for local-dir specs: check the source before installing.
          if (isLocalDirSpec(spec)) {
            const pre = qualityCheck(this.resolveLocalDir(spec))
            if (!pre.ok) throw gateError(pre.issues)
          }
          handle = createBackup(this.dshHomePath, dir, operationId, 'install', undefined)
          pnpm = findPnpm(this.pnpmPath)
          if (pnpm === undefined) {
            throw new EngineError(ErrorCodes.INSTALL_FAILED, 'pnpm not found on PATH (install pnpm to manage plugins)')
          }
          const add = await pnpmAdd(dir, spec, pnpm)
          if (!add.ok) {
            throw new EngineError(ErrorCodes.INSTALL_FAILED, `pnpm add failed (exit ${add.exitCode}):\n${add.output.slice(0, 2000)}`)
          }
          const manifest = readManifest(dir)
          const name = resolveInstalledName(manifest.dependencies ?? {}, spec)
          if (name === null) {
            throw new EngineError(ErrorCodes.INSTALL_NOT_FOUND, `could not resolve installed package name for ${spec}`)
          }
          installedName = name
          const pkgDir = join(dir, 'node_modules', name)
          const gate = qualityCheck(pkgDir)
          if (!gate.ok) {
            await pnpmRemove(dir, name, pnpm).catch(() => undefined)
            installedName = undefined
            throw gateError(gate.issues)
          }
          const isBundle = packageHasBundlePatch(pkgDir)
          const clientNote = declaresClient(pkgDir)
            ? '; 客户端 bundle 需刷新页面加载;若该包曾被扫描为"非客户端包",需重启后生效(pkgMeta 负缓存)'
            : ''
          let effective: { mode: 'hot' | 'restart'; restartRequired: boolean }
          if (isBundle) {
            const added = withBundleAdded(manifest, name)
            if (added.changed) writeManifestAtomic(dir, added.manifest)
            restoreInBoxBundles(dir)
            effective = { mode: 'restart', restartRequired: true }
          } else {
            const patch = readPatch(dir)
            const rowId = ensureUniqueRowId(patch, slugify(name), name)
            writePatchAtomic(patchPathOf(dir), addInsertRow(patch, rowId, name))
            // Observation window only for the HOST profile in hot mode; a
            // non-host target is not running here, so its change is
            // file/restart-committed (applies at the target's next boot).
            if (isHost && this.mode === 'hot') {
              // Full-block reconciliation (design §5.3): sibling rows of the
              // managed block count toward the outcome.
              const outcome = await this.observe(() => waitForHealthWithBlock(
                () => readFiberPhase(this.loader(), rowId),
                () => blockRowIds(readPatch(dir), rowId).map(id => readFiberPhase(this.loader(), id) ?? null),
                this.pollIntervalMs,
                this.observationWindowMs,
              ))
              if (outcome !== 'active') {
                throw new EngineError(ErrorCodes.HEALTH_FAILED, `install ${name} observation ${outcome}; auto-rollback`)
              }
              effective = { mode: 'hot', restartRequired: false }
            } else {
              // Engine restart mode / non-host target: the insert row loads
              // on the target's next boot.
              effective = { mode: 'restart', restartRequired: true }
            }
          }
          finalizeBackup(this.dshHomePath, handle)
          const finished = new Date().toISOString()
          const result: MutationResult = {
            ok: true,
            message: `install ${name} succeeded (${effective.mode})${clientNote}`,
            operationId,
            mode: effective.mode,
            restartRequired: effective.restartRequired,
            installed: [name],
            rollbackHandle: operationId,
          }
          this.auditLog.append(this.auditRecord(operationId, 'install', undefined, 'succeeded', caller, handle, undefined, spec))
          this.recordResult(operationId, result, finished)
          this.emit({ type: 'operation', operationId, op: 'install', status: 'succeeded', ts: finished })
        } catch (error) {
          // Observation/gate failures must also remove the installed package
          // (patch/manifest backups do not clean node_modules).
          if (installedName !== undefined && pnpm !== undefined) {
            await pnpmRemove(dir, installedName, pnpm).catch(() => undefined)
          }
          await this.failWithRollback(operationId, 'install', spec, handle, caller, error)
        }
      })
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    return queued.done.then(() => this.operations.get(queued.operationId)?.result ?? failureResult(new EngineError(ErrorCodes.OP_CONFLICT, 'lost operation result')))
  }

  /** Uninstall a package: pnpm remove + bundles cleanup + managed-row cleanup. */
  uninstall(name: string, opts: MutateOpts = {}): Promise<MutationResult> {
    let dir: string
    try {
      const target = this.resolveProfile(opts.profile)
      dir = this.dirOf(target)
      assertSafePackageName(name)
      // Self-host protection (ADR-0007 §3): the engine cannot uninstall its
      // own package from the profile it is running in.
      if (name === ENGINE_PACKAGE_NAME && target === this.hostProfile) {
        throw new EngineError(ErrorCodes.PROFILE_PROTECTED, `cannot uninstall ${name} from the self-host profile ${target}`)
      }
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    const caller = opts.caller ?? 'service'
    let queued: { operationId: string; done: Promise<void> }
    try {
      queued = this.queue.enqueue('uninstall', name, async () => {
        const operationId = queued.operationId
        const started = new Date().toISOString()
        this.setOperation(operationId, 'uninstall', name, 'running', started)
        let handle: BackupHandle | undefined
        try {
          handle = createBackup(this.dshHomePath, dir, operationId, 'uninstall', undefined)
          const pnpm = findPnpm(this.pnpmPath)
          if (pnpm === undefined) {
            throw new EngineError(ErrorCodes.INSTALL_FAILED, 'pnpm not found on PATH (install pnpm to manage plugins)')
          }
          const rm = await pnpmRemove(dir, name, pnpm)
          if (!rm.ok) {
            throw new EngineError(ErrorCodes.INSTALL_FAILED, `pnpm remove failed (exit ${rm.exitCode}):\n${rm.output.slice(0, 2000)}`)
          }
          const manifest = readManifest(dir)
          const wasBundle = readBundles(dir).includes(name)
          const removed = withBundleRemoved(manifest, name)
          if (removed.changed) writeManifestAtomic(dir, removed.manifest)
          restoreInBoxBundles(dir)
          // Cleanup managed insert rows for this package (else next boot fails).
          const patch = readPatch(dir)
          let next = patch
          for (const row of readInsertRows(patch)) {
            if (row.managed && row.name === name) {
              next = removeManagedBlockForId(next, row.id).content
            }
          }
          if (next !== patch) writePatchAtomic(patchPathOf(dir), next)
          finalizeBackup(this.dshHomePath, handle)
          // A bundle-layer removal only takes effect at the next boot
          // (bundles are read at startup) → restart mode (review 2026-08-14).
          const effective = wasBundle
            ? { mode: 'restart' as const, restartRequired: true }
            : this.effectiveMode()
          const finished = new Date().toISOString()
          const result: MutationResult = {
            ok: true,
            message: `uninstall ${name} succeeded (${effective.mode})`,
            operationId,
            mode: effective.mode,
            restartRequired: effective.restartRequired,
            installed: [name],
            rollbackHandle: operationId,
          }
          this.auditLog.append(this.auditRecord(operationId, 'uninstall', name, 'succeeded', caller, handle))
          this.recordResult(operationId, result, finished)
          this.emit({ type: 'operation', operationId, op: 'uninstall', status: 'succeeded', ts: finished })
        } catch (error) {
          await this.failWithRollback(operationId, 'uninstall', name, handle, caller, error)
        }
      })
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    return queued.done.then(() => this.operations.get(queued.operationId)?.result ?? failureResult(new EngineError(ErrorCodes.OP_CONFLICT, 'lost operation result')))
  }

  /** dryRun: quality-gate only, no disk writes (contract §4). Shares the
   * same qualityCheck path as the real install. */
  private dryRunInstall(dir: string, spec: string): MutationResult {
    if (isLocalDirSpec(spec)) {
      const pre = qualityCheck(this.resolveLocalDir(spec))
      if (!pre.ok) {
        return { ok: false, message: `dryRun: quality gate rejected ${spec}`, errors: [{ code: ErrorCodes.GATE_REJECTED, detail: pre.issues.map(escapeHtml).join('; ') }] }
      }
      return { ok: true, message: `dryRun: ${spec} would pass the quality gate` }
    }
    // npm spec: shared resolution when the package is already installed.
    const installed = resolveInstalledName(readManifest(dir).dependencies ?? {}, spec)
    if (installed !== null) {
      const gate = qualityCheck(join(dir, 'node_modules', installed))
      if (!gate.ok) {
        return { ok: false, message: `dryRun: quality gate rejected installed ${installed}`, errors: [{ code: ErrorCodes.GATE_REJECTED, detail: gate.issues.map(escapeHtml).join('; ') }] }
      }
      return { ok: true, message: `dryRun: installed ${installed} passes the quality gate` }
    }
    return { ok: true, message: `dryRun: ${spec} (npm spec not yet installed — post-install recheck applies)` }
  }

  /** Shared failure path: best-effort rollback + audit + operation record. */
  private async failWithRollback(
    operationId: string, op: OperationOp, target: string | undefined,
    handle: BackupHandle | undefined, caller: AuditRecord['caller'], error: unknown,
  ): Promise<void> {
    let rolledBack = false
    let rollbackNote = ''
    try {
      const h = loadBackup(this.dshHomePath, operationId) ?? handle
      if (h !== undefined) {
        rollbackByHandle(this.dshHomePath, h)
        rolledBack = true
      }
    } catch {
      rollbackNote = '; auto-rollback also failed'
    }
    const finished = new Date().toISOString()
    const result = failureResult(error, operationId, rollbackNote)
    const auditHandle = handle ?? emptyBackupRef
    this.auditLog.append(this.auditRecord(operationId, op, target, rolledBack ? 'rolled-back' : 'failed', caller, auditHandle, codeOf(error)))
    this.recordResult(operationId, result, finished, rolledBack ? 'rolled-back' : undefined)
    this.emit({ type: 'operation', operationId, op, status: 'failed', ts: finished })
  }

  /** Wrap an observation-window wait, recording hit-rate stats. */
  private async observe<T extends string>(wait: () => Promise<T>): Promise<T> {
    const outcome = await wait()
    this.healthStats.total += 1
    if (outcome === 'active' || outcome === 'gone' || outcome === 'stable') this.healthStats.active += 1
    else if (outcome === 'failed') this.healthStats.failed += 1
    else this.healthStats.timeout += 1
    return outcome
  }

  private resolveLocalDir(spec: string): string {
    if (spec.startsWith('file:')) return spec.slice('file:'.length)
    if (spec.startsWith('link:')) return spec.slice('link:'.length)
    return spec
  }

  private mutateRow(
    op: 'enable' | 'disable',
    entryId: string,
    opts: MutateOpts,
    write: (dir: string, id: string) => Promise<{ changed: boolean }>,
    observe: (dir: string, id: string) => Promise<void>,
  ): Promise<MutationResult> {
    let dir: string
    let isHost: boolean
    try {
      const target = this.resolveProfile(opts.profile)
      dir = this.dirOf(target)
      isHost = this.isHostProfile(target)
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    const caller = opts.caller ?? 'service'
    // Target must be a stable include-row id. The loader-tree existence check
    // only applies to the HOST profile; non-host targets check the patch file
    // (their rows are not in this process's loader).
    try {
      assertSafeEntryId(entryId)
      // Self-destruct protection (M4 freeze arch review): enabling/disabling
      // the engine's OWN bundle row on the host profile would unload the
      // running service (external profile patches may still disable it as a
      // documented degradation path, but the engine API must not self-unmount).
      if (isHost && entryId === ENGINE_ROW_ID) {
        throw new EngineError(ErrorCodes.PROFILE_PROTECTED, `cannot ${op} the engine's own row ${entryId} on the host profile`)
      }
      if (isHost && !isStableRowId(entryId)) {
        throw new EngineError(ErrorCodes.PATCH_UNSAFE_TARGET, `${entryId} is a loader-random id, not patch-targetable`)
      }
      if (isHost) {
        if (!rowExists(this.loader(), entryId)) {
          throw new EngineError(ErrorCodes.PATCH_UNSAFE_TARGET, `entry ${entryId} not found in the loader tree`)
        }
      } else {
        const patch = readPatch(dir)
        const inPatch = findTopLevelRow(patch, entryId) !== undefined
          || readInsertRows(patch).some(row => row.id === entryId)
        if (!inPatch) {
          throw new EngineError(ErrorCodes.PATCH_UNSAFE_TARGET, `entry ${entryId} not found in profile patch (${entryId})`)
        }
      }
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    let queued: { operationId: string; done: Promise<void> }
    try {
      queued = this.queue.enqueue(op, entryId, async () => {
        const operationId = queued.operationId
        const started = new Date().toISOString()
        this.setOperation(operationId, op, entryId, 'running', started)
        let handle: BackupHandle | undefined
        try {
          handle = createBackup(this.dshHomePath, dir, operationId, op, entryId)
          const { changed } = await write(dir, entryId)
          // Observation-window confirmation only for the HOST profile (the
          // non-host profile is not running here; its changes apply at boot).
          if (changed && isHost) await observe(dir, entryId)
          finalizeBackup(this.dshHomePath, handle)
          const finished = new Date().toISOString()
          const effective = isHost ? this.effectiveMode() : { mode: 'restart' as const, restartRequired: true }
          const result: MutationResult = {
            ok: true,
            message: `${op} ${entryId} succeeded (${effective.mode})${isHost ? '' : '; 目标 profile 重启后生效'}`,
            operationId,
            mode: effective.mode,
            restartRequired: effective.restartRequired,
            rollbackHandle: operationId,
          }
          this.auditLog.append(this.auditRecord(operationId, op, entryId, 'succeeded', caller, handle))
          this.recordResult(operationId, result, finished)
          this.emit({ type: 'operation', operationId, op, status: 'succeeded', ts: finished })
        } catch (error) {
          await this.failWithRollback(operationId, op, entryId, handle, caller, error)
        }
      })
    } catch (error) {
      return Promise.resolve(failureResult(error))
    }
    return queued.done.then(() => this.operations.get(queued.operationId)?.result ?? failureResult(new EngineError(ErrorCodes.OP_CONFLICT, 'lost operation result')))
  }

  /** Enable FILE write (no observation). Returns whether the patch changed. */
  private async writeEnable(dir: string, entryId: string): Promise<{ changed: boolean }> {
    const before = readPatch(dir)
    let next = before
    if (hasManagedDisable(before, entryId)) {
      next = removeDisableBlock(before, entryId)
    } else {
      const edited = applyRowEnabled(before, entryId)
      next = edited.changed ? edited.content : before
    }
    if (next === before) return { changed: false } // already enabled: no-op
    writePatchAtomic(patchPathOf(dir), next)
    return { changed: true }
  }

  /** Enable observation-window confirmation (block-reconciled). */
  private async observeEnable(dir: string, entryId: string): Promise<void> {
    const outcome = await this.observe(() => waitForHealthWithBlock(
      () => readFiberPhase(this.loader(), entryId),
      () => blockRowIds(readPatch(dir), entryId).map(id => readFiberPhase(this.loader(), id) ?? null),
      this.pollIntervalMs,
      this.observationWindowMs,
    ))
    if (outcome !== 'active') {
      throw new EngineError(ErrorCodes.HEALTH_FAILED, `enable ${entryId} observation ${outcome}; auto-rollback`)
    }
  }

  /** Disable FILE write (no observation). Returns whether the patch changed. */
  private async writeDisable(dir: string, entryId: string): Promise<{ changed: boolean }> {
    const before = readPatch(dir)
    let next = before
    const top = findTopLevelRow(before, entryId)
    if (top !== undefined && !top.managed) {
      const edited = applyRowDisabled(before, entryId)
      next = edited.changed ? edited.content : before
    } else if (hasManagedDisable(before, entryId)) {
      next = before // already disabled
    } else {
      next = addDisableBlock(before, entryId)
    }
    if (next === before) return { changed: false } // already disabled: no-op
    writePatchAtomic(patchPathOf(dir), next)
    return { changed: true }
  }

  /** Disable observation-window confirmation (row unmounts). */
  private async observeDisable(dir: string, entryId: string): Promise<void> {
    const outcome = await this.observe(() => waitForGone(
      () => readFiberPhase(this.loader(), entryId),
      this.pollIntervalMs,
      this.observationWindowMs,
    ))
    if (outcome !== 'gone') {
      throw new EngineError(ErrorCodes.HEALTH_FAILED, `disable ${entryId} observation ${outcome}; auto-rollback`)
    }
  }

  /** Post-rollback stabilization: wait for the row to leave 'failed'.
   * Counted under `rollback` (separate from the 8s install/enable
   * calibration stats — re-review 2026-08-14). */
  private async waitStable(_dir: string, targetRowId: string | undefined): Promise<void> {
    if (targetRowId === undefined) return
    const outcome = await waitForStable(
      () => readFiberPhase(this.loader(), targetRowId),
      this.pollIntervalMs,
      Math.min(this.observationWindowMs, 2000),
    )
    this.healthStats.total += 1
    this.healthStats.rollback += 1
    if (outcome === 'failed') this.healthStats.failed += 1
    else if (outcome === 'timeout') this.healthStats.timeout += 1
    else this.healthStats.active += 1
    if (outcome === 'failed') {
      throw new EngineError(ErrorCodes.ROLLBACK_FAILED, `target row ${targetRowId} is failed after rollback`)
    }
    // 'timeout' is tolerated: HMR settles asynchronously.
  }

  private auditRecord(
    operationId: string, op: string, target: string | undefined,
    result: AuditRecord['result'], caller: AuditRecord['caller'],
    handle: { patchBeforeHash: string; patchAfterHash?: string; patchBackup: string },
    errorCode?: string,
    spec?: string,
  ): AuditRecord {
    return {
      ts: new Date().toISOString(),
      operationId,
      op,
      target,
      spec,
      mode: this.mode,
      result,
      errorCode,
      caller,
      patchBeforeHash: handle.patchBeforeHash,
      patchAfterHash: handle.patchAfterHash,
      backupPath: handle.patchBackup,
    }
  }

  private setOperation(operationId: string, op: OperationOp, target: string, status: OperationInfo['status'], startedAt: string): void {
    this.operations.set(operationId, { operationId, op, status, target, startedAt })
  }

  /**
   * Per-operation effective mode (contract §9.2 — separate from the engine
   * runtime mode in EngineSnapshot.mode, §9.1). For enable/disable/rollback
   * the write always targets a patch row, so the effective mode equals the
   * engine mode; M2 extends this by package shape (bundle → restart).
   */
  private effectiveMode(): { mode: 'hot' | 'restart'; restartRequired: boolean } {
    if (this.mode === 'hot') return { mode: 'hot', restartRequired: false }
    return { mode: 'restart', restartRequired: true }
  }

  private recordResult(operationId: string, result: MutationResult, finishedAt: string, statusOverride?: 'rolled-back'): void {
    const existing = this.operations.get(operationId)
    if (existing !== undefined) {
      existing.status = statusOverride ?? (result.ok ? 'succeeded' : 'failed')
      existing.finishedAt = finishedAt
      existing.result = result
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* listener errors are non-fatal */ }
    }
  }

  // ── phase monitor (contract §7 entry frames) ──────────────────────────────

  /** Start the entry-phase monitor: seed once (no emission), then poll and
   * emit `entry` events on phase change / row unmount. The timer is unref'd
   * so it never keeps the process alive; cleanup rides ctx.effect. */
  private startPhaseMonitor(phasePollMs?: number): void {
    if (phasePollMs === 0) return
    this.scanPhases()
    this.phaseTimer = setInterval(() => this.scanPhases(), phasePollMs ?? 1000)
    this.phaseTimer.unref?.()
    const ctx = this.ctx as { effect?: (fn: () => void | (() => void), label?: string) => void }
    ctx.effect?.(() => () => this.stopPhaseMonitor(), 'hotplug-engine: phase monitor')
  }

  /** Compare loader phases against the last-known map and emit changes.
   * Contract §7 limits `entry` frames to MANAGED rows, so rows outside the
   * engine's managed insert blocks are not tracked/emitted. Non-fatal on
   * loader/patch errors. */
  private scanPhases(): void {
    try {
      const managedIds = this.managedRowIds()
      const seen = new Set<string>()
      for (const row of includeRows(this.loader())) {
        const id = row.options?.id
        if (id === undefined) continue
        if (!managedIds.has(id)) continue // contract §7: 被管理条目 only
        seen.add(id)
        const phase = phaseOf(row.fiber?.state)
        const last = this.lastPhases.get(id)
        if (last !== undefined && last !== phase) {
          this.emit({ type: 'entry', entryId: id, phase, ts: new Date().toISOString() })
        }
        this.lastPhases.set(id, phase)
      }
      for (const id of [...this.lastPhases.keys()]) {
        if (seen.has(id)) continue
        this.emit({ type: 'entry', entryId: id, phase: null, ts: new Date().toISOString() })
        this.lastPhases.delete(id)
      }
    } catch {
      // loader errors are non-fatal for the monitor
    }
  }

  /** Ids of rows inside the engine's managed insert blocks (the patch is the
   * authoritative source; non-fatal when unreadable). */
  private managedRowIds(): Set<string> {
    const ids = new Set<string>()
    try {
      const dir = this.hostProfile === undefined ? undefined : profileDirIn(this.dshHomePath, this.hostProfile)
      if (dir === undefined) return ids
      for (const row of readInsertRows(readPatch(dir))) {
        if (row.managed) ids.add(row.id)
      }
    } catch {
      // non-fatal: fall back to an empty set (no entry events this tick)
    }
    return ids
  }

  private stopPhaseMonitor(): void {
    if (this.phaseTimer !== undefined) {
      clearInterval(this.phaseTimer)
      this.phaseTimer = undefined
    }
  }

  /** The loader service (empty loader fallback when absent — mutating ops
   * then fail at the row-existence check instead of crashing). */
  private loader(): LoaderLike {
    const ctx = this.ctx as { get?: (name: string) => unknown }
    return (ctx.get?.('loader') as LoaderLike | undefined) ?? EMPTY_LOADER
  }

  /**
   * Resolve a profile name (M4 multi-profile, ADR-0007 §3):
   *  - whitelist via profileDirIn (PROFILE_UNSAFE on traversal/illegal names);
   *  - official profiles (web/headless) other than the SELF host profile are
   *    not manageable from here (PROFILE_PROTECTED);
   *  - missing profile directory → PROFILE_NOT_FOUND;
   *  - the self host profile is always manageable (that is where the engine
   *    runs and its primary management target).
   */
  private resolveProfile(profile?: string): string {
    const host = this.hostProfile ?? 'web'
    const target = profile ?? host
    const dir = profileDirIn(this.dshHomePath, target)
    if (target !== host && isOfficialProfile(target)) {
      throw new EngineError(ErrorCodes.PROFILE_PROTECTED, `official profile ${target} is not manageable from ${host}`)
    }
    if (!existsSync(dir)) {
      throw new EngineError(ErrorCodes.PROFILE_NOT_FOUND, `profile ${target} does not exist (${dir})`)
    }
    return target
  }

  /** Resolve a profile directory under THIS engine's DSH home (never the
   * global DSH_HOME when an explicit home was configured). */
  private dirOf(name: string): string {
    return profileDirIn(this.dshHomePath, name)
  }

  /** Whether a profile name is the engine's own host profile. */
  private isHostProfile(name: string): boolean {
    return name === (this.hostProfile ?? 'web')
  }

  /**
   * Startup reconciliation (design §5.4 / ADR-0003):
   *  1. in-memory unfinished operations → interrupted (M1 baseline);
   *  2. orphan managed insert blocks (block present, package not a dep) → removed;
   *  3. unfinished backup sidecars (no patchAfterHash) → audited as interrupted;
   *  4. orphan dependencies (dep with no engine trace) → warning only.
   * Never blocks startup; failures are best-effort with stderr logging.
   */
  private startupReconcile(): void {
    // In-memory operations never survive a restart (the map is process-local
    // and empty at construction), so the authoritative interrupted-op audit
    // comes from the backup sidecar scan below. No dead loop here.
    const dir = this.hostProfile === undefined ? undefined : profileDirIn(this.dshHomePath, this.hostProfile)
    if (dir === undefined) return
    try {
      const deps = readDependencies(dir)
      const patch = readPatch(dir)
      let next = patch
      for (const row of readInsertRows(patch)) {
        if (row.managed && !deps.includes(row.name)) {
          next = removeManagedBlockForId(next, row.id).content
        }
      }
      if (next !== patch) writePatchAtomic(patchPathOf(dir), next)
    } catch (error) {
      console.error('[hotplug-engine] startup reconcile (orphan blocks) failed:', error)
    }
    try {
      const backupRoot = backupDir(this.dshHomePath)
      if (existsSync(backupRoot)) {
        for (const file of readdirSync(backupRoot).filter(f => f.endsWith('.json'))) {
          try {
            const sidecar = JSON.parse(readFileSync(join(backupRoot, file), 'utf8')) as BackupHandle
            if (sidecar.patchAfterHash === undefined) {
              this.auditLog.append({
                ts: new Date().toISOString(),
                operationId: sidecar.operationId,
                op: sidecar.op,
                target: sidecar.targetRowId,
                mode: this.mode,
                result: 'failed',
                errorCode: ErrorCodes.OP_INTERRUPTED,
                caller: 'service',
                patchBeforeHash: sidecar.patchBeforeHash,
                backupPath: sidecar.patchBackup,
              })
            }
          } catch {
            // skip unreadable sidecars
          }
        }
      }
    } catch {
      // best-effort
    }
    try {
      const deps = readDependencies(dir)
      const bundles = readBundles(dir)
      const rows = readInsertRows(readPatch(dir))
      for (const dep of deps) {
        if (IN_BOX_BUNDLES.includes(dep as (typeof IN_BOX_BUNDLES)[number])) continue
        if (bundles.includes(dep)) continue
        if (rows.some(row => row.name === dep)) continue
        console.warn(`[hotplug-engine] orphan dependency (no engine trace; possibly user-installed): ${dep}`)
      }
    } catch {
      // best-effort
    }
  }
}

function versionOf(dir: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** Fallback handle reference for audit records when no backup was created. */
const emptyBackupRef: BackupHandle = {
  operationId: '',
  op: '',
  patchPath: '',
  manifestPath: '',
  patchBeforeHash: '',
  patchBackup: '',
  manifestBackup: '',
  ts: '',
}

/** The engine's own package name (self-host protection, ADR-0007 §3). */
const ENGINE_PACKAGE_NAME = 'dsh-hotplug-engine'

/** The engine's own bundle row id (cordis.patch.yml insert id). Enabling or
 * disabling it on the host profile would unmount the running service. */
const ENGINE_ROW_ID = 'hotplug-engine'

/** Empty loader (no entries) used when the loader service is absent. */
const EMPTY_LOADER: LoaderLike = { entries: () => [] }

function codeOf(error: unknown): string | undefined {
  return error instanceof EngineError ? error.code : undefined
}

/** Quality-gate rejection error (issues escaped for UI output, design §4). */
function gateError(issues: string[]): EngineError {
  const escaped = issues.map(escapeHtml)
  return new EngineError(ErrorCodes.GATE_REJECTED, `quality gate rejected: ${escaped.join('; ')}`, escaped.join('\n'))
}

/** HTML-escape a string for UI/detail output (design §4 security note). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Whether an installed package declares a client half (dsh.client). */
function declaresClient(pkgDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { dsh?: { client?: unknown } }
    return manifest.dsh?.client !== undefined
  } catch {
    return false
  }
}

function failureResult(error: unknown, operationId?: string, note = ''): MutationResult {
  const message = error instanceof Error ? error.message : String(error)
  const code = codeOf(error)
  return {
    ok: false,
    message: message + note,
    operationId,
    errors: code !== undefined ? [{ code, detail: message }] : undefined,
  }
}
