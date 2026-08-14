import { describe, expect, it } from 'vitest'
import { OperationQueue } from '../src/host/queue.ts'
import { EngineError, ErrorCodes } from '../src/contract/types.ts'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function codeOfThrow(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof EngineError ? error.code : undefined
  }
  return undefined
}

describe('queue: serial execution', () => {
  it('runs tasks in enqueue order, never in parallel', async () => {
    const q = new OperationQueue()
    const order: string[] = []
    const run = async (name: string, delay: number): Promise<void> => {
      await sleep(delay)
      order.push(name)
    }
    q.enqueue('enable', 'a', () => run('a', 30))
    q.enqueue('disable', 'b', () => run('b', 1))
    q.enqueue('enable', 'c', () => run('c', 10))
    await sleep(150)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('keeps running after a task throws', async () => {
    const q = new OperationQueue()
    q.enqueue('disable', 'x', async () => {
      throw new Error('boom')
    })
    let ran = false
    q.enqueue('disable', 'y', async () => {
      ran = true
    })
    await sleep(50)
    expect(ran).toBe(true)
  })
})

describe('queue: conflict detection', () => {
  it('rejects the same op+target while still queued', async () => {
    const q = new OperationQueue()
    q.enqueue('disable', 'row-a', () => sleep(100))
    expect(codeOfThrow(() => q.enqueue('disable', 'row-a', () => sleep(1)))).toBe(ErrorCodes.OP_CONFLICT)
    await sleep(150)
    // After completion the same op+target is allowed again.
    expect(() => q.enqueue('disable', 'row-a', () => sleep(1))).not.toThrow()
  })

  it('allows different targets and different ops concurrently', () => {
    const q = new OperationQueue()
    expect(() => q.enqueue('disable', 'row-a', () => sleep(100))).not.toThrow()
    expect(() => q.enqueue('enable', 'row-b', () => sleep(100))).not.toThrow()
  })

  it('assigns unique operation ids', () => {
    const q = new OperationQueue()
    const a = q.enqueue('enable', 'x', () => sleep(1))
    const b = q.enqueue('enable', 'y', () => sleep(1))
    expect(a).not.toBe(b)
  })
})
