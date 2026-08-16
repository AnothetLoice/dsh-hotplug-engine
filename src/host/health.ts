/**
 * Health monitor: observation-window confirmation over the loader tree
 * (design §5.3 / ADR-0003). Polls a target row's fiber phase. v0.1.5
 * three-way: reflected success (active/gone), reflected failure (failed/stuck
 * → rollback), or unreflected (absent/still-active → restart). The M1 monitor
 * also supports all-row reconciliation of a managed block.
 *
 * Loader walking follows the include-tree row view (row.options.id is the
 * stable include-row id; loader random ids are 8-hex).
 *
 * @module dsh-hotplug-engine/host/health
 */

import type { FiberPhase } from '../contract/types.ts'

/** Structural loader entry view (only the fields we read). */
export interface RowEntryLike {
  id?: string
  options?: { id?: string; name?: string; group?: boolean | null }
  disabled?: boolean
  fiber?: { state?: number }
  subtree?: { entries(): Iterable<RowEntryLike> }
}

/** Minimal loader surface used by the health monitor. */
export interface LoaderLike {
  entries(): Iterable<RowEntryLike>
}

/** Fiber-state → phase mapping (cordis loader semantics). */
export function phaseOf(state: number | undefined): FiberPhase {
  if (state === undefined) return null
  if (state === 0) return 'pending'
  if (state === 1) return 'loading'
  if (state === 2) return 'active'
  if (state === 3) return 'failed'
  if (state === 4) return null
  return 'unloading'
}

/** Loader random-mount ids are 8-hex (Math.random().toString(16).slice(2, 10)). */
export function isStableRowId(id: string): boolean {
  return !/^[0-9a-f]{8}$/.test(id)
}

/** Find the include tree's rows (the config rows, stable ids). */
export function includeRows(loader: LoaderLike): RowEntryLike[] {
  for (const entry of loader.entries()) {
    if (entry.id === 'include' && entry.subtree !== undefined) {
      return [...entry.subtree.entries()]
    }
  }
  return []
}

/** Read the fiber phase of one include row by stable id. */
export function readFiberPhase(loader: LoaderLike, entryId: string): FiberPhase | undefined {
  for (const row of includeRows(loader)) {
    if (row.options?.id === entryId) return phaseOf(row.fiber?.state)
  }
  return undefined
}

/** Whether the row exists in the include tree at all. */
export function rowExists(loader: LoaderLike, entryId: string): boolean {
  return includeRows(loader).some(row => row.options?.id === entryId)
}

/** Observation result of an install/enable health poll (v0.1.5 three-way). */
export type ActiveOutcome = 'active' | 'failed' | 'stuck' | 'absent'
/** Observation result of a disable health poll (v0.1.5 three-way). */
export type GoneOutcome = 'gone' | 'failed' | 'still-active' | 'stuck'

/**
 * Poll until the target row is ACTIVE (enable confirmation). 'failed' beats
 * timeout. Outcome distinguishes 'stuck' (entered a live phase then stalled)
 * from 'absent' (never left the null/undefined baseline — no reflection).
 */
export async function waitForActive(
  readPhase: () => FiberPhase | undefined,
  intervalMs = 500,
  timeoutMs = 8000,
): Promise<ActiveOutcome> {
  const deadline = Date.now() + timeoutMs
  let sawLive = false
  for (;;) {
    const phase = readPhase()
    if (phase === 'active') return 'active'
    if (phase === 'failed') return 'failed'
    if (phase !== undefined && phase !== null) sawLive = true
    if (Date.now() >= deadline) return sawLive ? 'stuck' : 'absent'
    await sleep(intervalMs)
  }
}

/**
 * Poll until the target row is GONE (disabled confirmation: a disabled row
 * has no fiber → phase null/undefined). 'failed' beats timeout. Outcome
 * distinguishes 'still-active' (never left active — no reflection) from
 * 'stuck' (left active but stalled before gone/failed).
 */
export async function waitForGone(
  readPhase: () => FiberPhase | undefined,
  intervalMs = 500,
  timeoutMs = 8000,
): Promise<GoneOutcome> {
  const deadline = Date.now() + timeoutMs
  let everLeftActive = false
  for (;;) {
    const phase = readPhase()
    if (phase === undefined || phase === null) return 'gone'
    if (phase === 'failed') return 'failed'
    if (phase !== 'active') everLeftActive = true
    if (Date.now() >= deadline) return everLeftActive ? 'stuck' : 'still-active'
    await sleep(intervalMs)
  }
}

/**
 * Poll until the target row is STABLE (active or gone — neither failed).
 * Used for post-rollback stabilization. 'failed' beats timeout.
 */
export async function waitForStable(
  readPhase: () => FiberPhase | undefined,
  intervalMs = 500,
  timeoutMs = 2000,
): Promise<'stable' | 'failed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const phase = readPhase()
    if (phase === 'failed') return 'failed'
    if (phase === 'active' || phase === undefined || phase === null) return 'stable'
    if (Date.now() >= deadline) return 'timeout'
    await sleep(intervalMs)
  }
}

/**
 * Same as waitForActive but also reconciles sibling rows of the managed block
 * (design §5.3): a failed sibling marks the whole operation failed even when
 * the target row itself is active.
 */
export async function waitForHealthWithBlock(
  readPhase: () => FiberPhase | undefined,
  readBlockPhases: () => FiberPhase[],
  intervalMs = 500,
  timeoutMs = 8000,
): Promise<ActiveOutcome> {
  const deadline = Date.now() + timeoutMs
  let sawLive = false
  for (;;) {
    const phase = readPhase()
    if (phase === 'failed') return 'failed'
    if (phase === 'active') {
      const siblings = readBlockPhases()
      if (siblings.some(p => p === 'failed')) return 'failed'
      return 'active'
    }
    if (phase !== undefined && phase !== null) sawLive = true
    if (Date.now() >= deadline) return sawLive ? 'stuck' : 'absent'
    await sleep(intervalMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
