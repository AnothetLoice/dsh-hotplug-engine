/**
 * Contract types — derived from `docs/01-contract.md` §3 (single source of
 * truth: the contract document). Consumers type-check against this module.
 *
 * @module dsh-hotplug-engine/contract
 */

/** Result envelope for all mutating operations (contract §3). */
export interface MutationResult {
  ok: boolean
  message: string
  /** Queue-assigned tracking id for the mutating operation. */
  operationId?: string
  /** How THIS operation takes effect (contract §9.2); engine runtime mode
   * lives on `EngineSnapshot.mode` (§9.1) — the two axes are separate. */
  mode?: 'hot' | 'restart'
  restartRequired?: boolean
  /** Packages actually installed/removed by install/uninstall. */
  installed?: string[]
  /** Rollback handle (backup reference) consumable by rollback(). */
  rollbackHandle?: string
  errors?: { code: string; detail: string; stage?: 'gate' | 'install' | 'observe' }[]
}

/** Cordis fiber phase (loader semantics). */
export type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** One projection row of the official tree (contract §3). */
export interface RuntimeEntry {
  /** Stable include-row id (patch-targetable). Random loader ids are not. */
  entryId: string
  /** Package name. */
  moduleName: string
  source: 'bundle' | 'insert' | 'user'
  enabled: boolean
  /** Whether this row can be targeted by enable/disable (stable id). */
  patchTargetable: boolean
  fiberPhase: FiberPhase
  /** Whether the row lives inside an engine-owned managed block. */
  managed: boolean
  /** Official core-plugin classification for the critical-disable warning
   * (v0.1.4 additive optional field). */
  critical?: boolean
}

/** Installed package view — a projection (npm deps are not all plugins). */
export interface InstalledPackage {
  name: string
  /** Whether the package sits in the dsh.profile.bundles layer. */
  isBundle: boolean
  version?: string
  installedAt?: string
}

/** One insert-row view from the profile patch. */
export interface InsertRowView {
  /** Insert row id (== the mounted RuntimeEntry.entryId). */
  id: string
  name: string
  managed: boolean
}

/** Full state projection (contract §3). */
export interface EngineSnapshot {
  profile: string
  /** Engine runtime mode (contract §9.1). */
  mode: 'hot' | 'restart'
  entries: RuntimeEntry[]
  packages: InstalledPackage[]
  insertRows: InsertRowView[]
  /** Audit lag indicator: true when a JSONL write failed at some point, so
   * the trail may be incomplete (design §6; additive v1 field). */
  auditLag?: boolean
}

export type OperationOp = 'install' | 'uninstall' | 'enable' | 'disable' | 'rollback'
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back'

/** One operation record (contract §3). */
export interface OperationInfo {
  operationId: string
  op: OperationOp
  status: OperationStatus
  target?: string
  startedAt?: string
  finishedAt?: string
  result?: MutationResult
}

/** One audit line (JSONL row, contract §3). */
export interface AuditRecord {
  ts: string
  operationId: string
  op: string
  target?: string
  spec?: string
  mode: 'hot' | 'restart'
  result: 'succeeded' | 'failed' | 'rolled-back'
  errorCode?: string
  caller: 'service' | 'rest' | 'tool'
  patchBeforeHash?: string
  patchAfterHash?: string
  backupPath?: string
  /** v0.1.5 (P2-2): free-text warning — e.g. the unreflected-write caveat. */
  note?: string
}

/** SSE event frames (contract §7). */
export type EngineEvent =
  | { type: 'operation'; operationId: string; op: string; status: OperationStatus; ts: string }
  | { type: 'entry'; entryId: string; phase: FiberPhase; ts: string }
  | { type: 'snapshot'; rev: string; ts: string }

/** Error codes (contract §8). */
export const ErrorCodes = {
  PROFILE_UNSAFE: 'HOTPLUG.PROFILE.UNSAFE',
  PROFILE_PROTECTED: 'HOTPLUG.PROFILE.PROTECTED',
  PROFILE_NOT_FOUND: 'HOTPLUG.PROFILE.NOT_FOUND',
  PATCH_INVALID: 'HOTPLUG.PATCH.INVALID',
  PATCH_UNSAFE_TARGET: 'HOTPLUG.PATCH.UNSAFE_TARGET',
  PATCH_UNSAFE_VALUE: 'HOTPLUG.PATCH.UNSAFE_VALUE',
  GATE_REJECTED: 'HOTPLUG.GATE.REJECTED',
  HEALTH_FAILED: 'HOTPLUG.HEALTH.FAILED',
  PNPM_NOT_FOUND: 'HOTPLUG.PNPM_NOT_FOUND',
  PNPM_NOT_EXECUTABLE: 'HOTPLUG.PNPM_NOT_EXECUTABLE',
  PNPM_ADD_FAILED: 'HOTPLUG.PNPM_ADD_FAILED',
  INSTALL_FAILED: 'HOTPLUG.INSTALL.FAILED',
  INSTALL_NOT_FOUND: 'HOTPLUG.INSTALL.NOT_FOUND',
  ROLLBACK_NOT_FOUND: 'HOTPLUG.ROLLBACK.NOT_FOUND',
  ROLLBACK_FAILED: 'HOTPLUG.ROLLBACK.FAILED',
  ROLLBACK_INVALID: 'HOTPLUG.ROLLBACK.INVALID',
  OP_CONFLICT: 'HOTPLUG.OP.CONFLICT',
  OP_INTERRUPTED: 'HOTPLUG.OP.INTERRUPTED',
  SPEC_UNSAFE: 'HOTPLUG.SPEC.UNSAFE',
  HMR_UNAVAILABLE: 'HOTPLUG.HMR.UNAVAILABLE',
  // Transport-level REST codes (contract §8 extension, 2026-08-14 M3).
  REST_INVALID_BODY: 'HOTPLUG.REST.INVALID_BODY',
  REST_FORBIDDEN: 'HOTPLUG.REST.FORBIDDEN',
  REST_METHOD_NOT_ALLOWED: 'HOTPLUG.REST.METHOD_NOT_ALLOWED',
  REST_INTERNAL: 'HOTPLUG.REST.INTERNAL',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** Error with a contract error code (thrown inside the service layer). */
export class EngineError extends Error {
  readonly code: ErrorCode
  readonly detail?: string
  /** Legacy compatibility code emitted alongside `code` in errors[] (dual-code
   * strategy, v0.1.4 — keeps old consumers matching INSTALL_FAILED). */
  readonly compatCode?: ErrorCode
  /** Failure-stage classification (v0.1.4 direction D). */
  readonly stage?: 'gate' | 'install' | 'observe'
  constructor(code: ErrorCode, message: string, detail?: string, compatCode?: ErrorCode, stage?: 'gate' | 'install' | 'observe') {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.detail = detail
    this.compatCode = compatCode
    this.stage = stage
  }
}
