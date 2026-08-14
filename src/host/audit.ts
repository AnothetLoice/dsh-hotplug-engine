/**
 * Audit log (design §6 / ADR-0007): append-only JSONL under
 * $DSH_HOME/logs/hotplug-engine/<YYYY-MM-DD>.jsonl. Writing must never block
 * or break an operation — failures set the lag indicator and log to stderr.
 *
 * @module dsh-hotplug-engine/host/audit
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditRecord } from '../contract/types.ts'

/** Audit log for one engine instance. */
export class AuditLog {
  /** Set when a write failed (audit lag; exposed via audit()/status). */
  lag = false

  constructor(private readonly dir: string) {}

  /** Append one record (never throws). */
  append(record: AuditRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const day = record.ts.slice(0, 10)
      appendFileSync(join(this.dir, `${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8')
    } catch (error) {
      this.lag = true
      // eslint-disable-next-line no-console
      console.error('[hotplug-engine] audit write failed:', error)
    }
  }

  /** Query records (op/from/limit filters). */
  query(filter: { op?: string; from?: string; limit?: number } = {}): AuditRecord[] {
    const records: AuditRecord[] = []
    try {
      if (!existsSync(this.dir)) return records
      const files = listJsonl(this.dir)
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try {
            const record = JSON.parse(line) as AuditRecord
            if (filter.op !== undefined && record.op !== filter.op) continue
            if (filter.from !== undefined && record.ts < filter.from) continue
            records.push(record)
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // read failures are non-fatal
    }
    const limit = filter.limit ?? 1000
    return records.slice(-limit)
  }
}

function listJsonl(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .sort()
    .map(name => join(dir, name))
}
