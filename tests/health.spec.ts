import { describe, expect, it } from 'vitest'
import {
  includeRows, isStableRowId, phaseOf, readFiberPhase, rowExists,
  waitForActive, waitForGone, waitForHealthWithBlock, waitForStable,
  type FiberPhase, type LoaderLike,
} from '../src/host/health.ts'

function stateOf(phase: FiberPhase): number | undefined {
  switch (phase) {
    case 'pending': return 0
    case 'loading': return 1
    case 'active': return 2
    case 'failed': return 3
    default: return undefined
  }
}

function fakeLoader(states: Record<string, FiberPhase>): LoaderLike {
  const rows = Object.entries(states).map(([id, phase]) => ({
    options: { id, name: `pkg-${id}`, group: false },
    disabled: false,
    get fiber() {
      const p = states[id]!
      return p === null || p === undefined ? undefined : { state: stateOf(p) }
    },
  }))
  return { entries: () => [{ id: 'include', subtree: { entries: () => rows } }] }
}

describe('health: loader view', () => {
  it('phaseOf maps fiber states', () => {
    expect(phaseOf(0)).toBe('pending')
    expect(phaseOf(1)).toBe('loading')
    expect(phaseOf(2)).toBe('active')
    expect(phaseOf(3)).toBe('failed')
    expect(phaseOf(4)).toBeNull()
    expect(phaseOf(undefined)).toBeNull()
  })

  it('isStableRowId distinguishes include ids from loader-random ids', () => {
    expect(isStableRowId('ui-task-board')).toBe(true)
    expect(isStableRowId('row-a')).toBe(true)
    expect(isStableRowId('a1b2c3d4')).toBe(false)
  })

  it('includeRows / readFiberPhase / rowExists walk the include subtree', () => {
    const loader = fakeLoader({ 'row-a': 'active', 'row-b': 'failed', 'row-c': null })
    expect(includeRows(loader).map(r => r.options?.id)).toEqual(['row-a', 'row-b', 'row-c'])
    expect(readFiberPhase(loader, 'row-a')).toBe('active')
    expect(readFiberPhase(loader, 'row-b')).toBe('failed')
    expect(readFiberPhase(loader, 'row-c')).toBeNull()
    expect(readFiberPhase(loader, 'nope')).toBeUndefined()
    expect(rowExists(loader, 'row-a')).toBe(true)
    expect(rowExists(loader, 'nope')).toBe(false)
  })
})

describe('health: observation windows', () => {
  it('waitForActive resolves on active and fails on failed', async () => {
    let phase: FiberPhase = 'loading'
    const promise = waitForActive(() => phase, 20, 1000)
    setTimeout(() => { phase = 'active' }, 60)
    expect(await promise).toBe('active')

    phase = 'loading'
    const failed = waitForActive(() => phase, 20, 1000)
    setTimeout(() => { phase = 'failed' }, 40)
    expect(await failed).toBe('failed')
  })

  it('waitForActive returns stuck when a live phase stalls', async () => {
    const outcome = await waitForActive(() => 'loading', 10, 120)
    expect(outcome).toBe('stuck')
  })

  it('waitForActive returns absent when the row never leaves the baseline', async () => {
    expect(await waitForActive(() => undefined, 10, 120)).toBe('absent') // install: not in tree
    expect(await waitForActive(() => null, 10, 120)).toBe('absent')     // enable: still disabled
  })

  it('waitForHealthWithBlock distinguishes absent from stuck', async () => {
    expect(await waitForHealthWithBlock(() => undefined, () => [], 10, 120)).toBe('absent')
    expect(await waitForHealthWithBlock(() => null, () => [], 10, 120)).toBe('absent')
    expect(await waitForHealthWithBlock(() => 'loading', () => [], 10, 120)).toBe('stuck')
  })

  it('waitForGone resolves when the row unmounts (disabled)', async () => {
    let phase: FiberPhase = 'active'
    const promise = waitForGone(() => phase, 20, 1000)
    setTimeout(() => { phase = null }, 60)
    expect(await promise).toBe('gone')
  })

  it('waitForGone returns still-active when the row never leaves active', async () => {
    const outcome = await waitForGone(() => 'active', 10, 120)
    expect(outcome).toBe('still-active')
  })

  it('waitForGone returns stuck when the row leaves active but stalls', async () => {
    const outcome = await waitForGone(() => 'loading', 10, 120)
    expect(outcome).toBe('stuck')
  })

  it('waitForStable accepts active or gone and rejects failed', async () => {
    expect(await waitForStable(() => 'active', 10, 300)).toBe('stable')
    expect(await waitForStable(() => null, 10, 300)).toBe('stable')
    expect(await waitForStable(() => 'failed', 10, 100)).toBe('failed')
    expect(await waitForStable(() => 'loading', 10, 100)).toBe('timeout')
  })

  it('waitForHealthWithBlock fails when a sibling row of the block is failed', async () => {
    // target goes active, but a sibling of the managed block stays failed
    let target: FiberPhase = 'loading'
    const siblings: FiberPhase[] = ['failed']
    const promise = waitForHealthWithBlock(() => target, () => siblings, 20, 1000)
    setTimeout(() => { target = 'active' }, 60)
    expect(await promise).toBe('failed')
  })
})
