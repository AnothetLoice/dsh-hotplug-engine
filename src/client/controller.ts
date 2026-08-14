/**
 * Panel open/close state owner (subscribe/getSnapshot store), mirroring the
 * community panel pattern (dsh-ssh / task board).
 *
 * @module dsh-hotplug-engine/client/controller
 */

export interface PanelSnapshot {
  open: boolean
}

/** Minimal external-store: toggle/close + subscribe/getSnapshot. */
export class PanelController {
  private open = false
  private readonly listeners = new Set<() => void>()

  toggle(): void {
    this.open = !this.open
    this.notify()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.notify()
  }

  getSnapshot(): PanelSnapshot {
    return { open: this.open }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // listener errors are non-fatal
      }
    }
  }
}
