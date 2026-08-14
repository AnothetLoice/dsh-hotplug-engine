/**
 * Global serial operation queue (design §8 / ADR-0003). Config HMR replay is
 * not reentrant, so every mutating operation runs through a single promise
 * chain — tasks never run in parallel. Same op+target still queued →
 * HOTPLUG.OP.CONFLICT (locked, no merging).
 *
 * @module dsh-hotplug-engine/host/queue
 */

import { EngineError, ErrorCodes, type OperationOp } from '../contract/types.ts'

/** Key for the pending-conflict map. */
function keyOf(op: OperationOp, target: string | undefined): string {
  return `${op}:${target ?? ''}`
}

/**
 * A serial queue over mutating operations.
 */
export class OperationQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, string>()
  private seq = 0

  /**
   * Enqueue a task. Assigns the operation id immediately.
   * The returned `done` promise resolves only AFTER the pending-conflict
   * entry is cleaned up, so consumers observing completion can immediately
   * re-enqueue the same op+target.
   * @throws {EngineError} OP_CONFLICT when the same op+target is still queued.
   */
  enqueue(op: OperationOp, target: string | undefined, run: () => Promise<void>): { operationId: string; done: Promise<void> } {
    const key = keyOf(op, target)
    const existing = this.pending.get(key)
    if (existing !== undefined) {
      throw new EngineError(
        ErrorCodes.OP_CONFLICT,
        `${op} on ${target ?? '(profile)'} is already queued (${existing})`,
      )
    }
    const operationId = `op-${Date.now()}-${++this.seq}`
    this.pending.set(key, operationId)
    const task = this.chain.then(run, run).finally(() => {
      this.pending.delete(key)
    })
    this.chain = task.then(() => {}, () => {})
    // `done` never rejects: consumers read the recorded result from the
    // operation registry, not from the task's value.
    return { operationId, done: task.then(() => {}, () => {}) }
  }

  /** Whether a task is currently queued (or running). */
  isPending(op: OperationOp, target: string | undefined): boolean {
    return this.pending.has(keyOf(op, target))
  }
}
