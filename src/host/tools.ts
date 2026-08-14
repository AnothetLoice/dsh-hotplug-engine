/**
 * Agent tools (contract §6): six `hotplug_*` tools over the same service the
 * REST surface uses (A3.7: one behavior, three consumption paths).
 *
 * - Read tools (`hotplug_status`, `hotplug_audit`) pass through unchanged;
 * - Write tools (`hotplug_install/uninstall/toggle/rollback`) are gated by a
 *   `tools/pre-execute` listener returning `{ kind: 'ask' }`, which routes
 *   through the existing approval service (`ctx.get('approval')`) — the
 *   deployment's approval policy decides (ask → user prompt; never → deny).
 *   No approval service / no agent → fail closed (official degrade).
 * - Descriptions state the mechanism hints the contract requires (client
 *   refresh / bundle restart).
 *
 * @module dsh-hotplug-engine/host/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  AuditRecord, EngineSnapshot, MutationResult, RuntimeEntry,
} from '../contract/types.ts'

/** Mechanism hints required by contract §6 in every tool description. */
export const MECHANISM_NOTE =
  '机制提示:新客户端插件需刷新页面才加载;bundle 包(dsh.bundle)安装/卸载需重启后才生效。'

/** Write-tool names that MUST pass the approval gate (contract §6). */
export const HOTPLUG_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'hotplug_install',
  'hotplug_uninstall',
  'hotplug_toggle',
  'hotplug_rollback',
])

/** The host service subset consumed by the tools (contract §4). `caller`
 * marks audit provenance (tools always pass 'tool'). */
export interface ToolService {
  snapshot(profile?: string): EngineSnapshot
  status(entryId?: string, profile?: string): RuntimeEntry | undefined
  install(spec: string, opts?: { profile?: string; dryRun?: boolean; caller?: 'tool' }): Promise<MutationResult>
  uninstall(name: string, opts?: { profile?: string; caller?: 'tool' }): Promise<MutationResult>
  enable(entryId: string, opts?: { profile?: string; caller?: 'tool' }): Promise<MutationResult>
  disable(entryId: string, opts?: { profile?: string; caller?: 'tool' }): Promise<MutationResult>
  rollback(handle: string, opts?: { profile?: string; caller?: 'tool' }): Promise<MutationResult>
  audit(query?: { op?: string; from?: string; limit?: number }): AuditRecord[]
}

/**
 * Pre-execute gate for the write tools. Register it as
 * `ctx.on('tools/pre-execute', gate)`; read tools fall through to `next()`,
 * write tools ask through the existing approval policy.
 */
export function makePreExecuteGate(reason = 'hotplug 引擎写操作需要审批'): (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision> {
  return async (exec, next) => {
    if (!HOTPLUG_WRITE_TOOLS.has(exec.name)) return next()
    return { kind: 'ask', reason: `${reason}(工具:${exec.name})` }
  }
}

/** Build the six `hotplug_*` tools over one service. */
export function makeTools(service: ToolService): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: 'hotplug_status',
      description: `Query the hotplug engine state: full snapshot (entries / packages / insert rows) or one entry by stable entryId. 只读。Triggers: 查看插件状态/插件列表/某插件是否启用。${MECHANISM_NOTE}`,
      parameters: {
        profile: { type: 'string', description: 'Profile name (v1: host profile only).' },
        entryId: { type: 'string', description: 'Stable include-row id to query; omitted = full snapshot.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profile: { type: 'string', required: true },
            mode: { type: 'string', enum: ['hot', 'restart'], required: true },
            entry: { oneOf: [runtimeEntrySchema, { type: 'null' }], required: true },
            snapshot: { oneOf: [snapshotSchema, { type: 'null' }], required: true },
          },
        },
        render: (_args, value) => {
          const lines = [`profile=${value.profile} mode=${value.mode}`]
          if (value.entry !== null) {
            const e = value.entry
            lines.push(`entry: ${e.entryId} ${e.moduleName} [${e.source}] enabled=${e.enabled} targetable=${e.patchTargetable} phase=${e.fiberPhase ?? 'none'} managed=${e.managed}`)
          } else if (value.snapshot !== null) {
            const s = value.snapshot
            lines.push(
              `entries: ${s.entries.length} enabled=${s.entries.filter(e => e.enabled).length} failed=${s.entries.filter(e => e.fiberPhase === 'failed').length}`,
              `packages: ${s.packages.length} bundles=${s.packages.filter(p => p.isBundle).length}`,
              `insert rows: ${s.insertRows.length} managed=${s.insertRows.filter(r => r.managed).length}`,
            )
            for (const e of s.entries) {
              lines.push(`- ${e.entryId} ${e.moduleName} [${e.source}] enabled=${e.enabled} phase=${e.fiberPhase ?? 'none'}${e.managed ? ' (managed)' : ''}`)
            }
          }
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const snap = service.snapshot(args.profile)
        if (args.entryId !== undefined) {
          const entry = snap.entries.find(e => e.entryId === args.entryId) ?? null
          return { profile: snap.profile, mode: snap.mode, entry, snapshot: null }
        }
        return { profile: snap.profile, mode: snap.mode, entry: null, snapshot: snap }
      },
    }),

    defineTool({
      name: 'hotplug_install',
      description: `Install a plugin by spec (npm package name / local path / git URL — 由市场解析后传入,引擎不猜来源): quality gate → pnpm add → bundle (restart) or managed insert row (hot) → observation window with auto-rollback on failure. 写操作,需审批。${MECHANISM_NOTE}`,
      parameters: {
        spec: { type: 'string', required: true, description: 'Install source (npm package / file: path / link: path / git URL).' },
        profile: { type: 'string', description: 'Profile name (v1: host profile only).' },
        dryRun: { type: 'boolean', description: 'Only run the quality gate; no disk writes.' },
      },
      output: {
        schema: mutationResultSchema,
        render: renderMutation,
      },
      execute: async (args) => service.install(args.spec, { profile: args.profile, dryRun: args.dryRun, caller: 'tool' }),
    }),

    defineTool({
      name: 'hotplug_uninstall',
      description: `Uninstall a package: pnpm remove + bundles-layer cleanup + managed insert-row cleanup (else next boot fails). 写操作,需审批。${MECHANISM_NOTE}`,
      parameters: {
        name: { type: 'string', required: true, description: 'Installed package name.' },
        profile: { type: 'string', description: 'Profile name (v1: host profile only).' },
      },
      output: {
        schema: mutationResultSchema,
        render: renderMutation,
      },
      execute: async (args) => service.uninstall(args.name, { profile: args.profile, caller: 'tool' }),
    }),

    defineTool({
      name: 'hotplug_toggle',
      description: `Enable or disable one include row by stable entryId (enabled 缺省=当前态取反). 写操作,需审批。${MECHANISM_NOTE}`,
      parameters: {
        entryId: { type: 'string', required: true, description: 'Stable include-row id (patch-targetable).' },
        enabled: { type: 'boolean', description: 'Target state; omitted = invert current state.' },
        profile: { type: 'string', description: 'Profile name (v1: host profile only).' },
      },
      output: {
        schema: mutationResultSchema,
        render: renderMutation,
      },
      execute: async (args) => {
        const snap = service.snapshot(args.profile)
        const current = snap.entries.find(e => e.entryId === args.entryId)
        const target = args.enabled ?? !(current?.enabled ?? true)
        return target
          ? service.enable(args.entryId, { profile: args.profile, caller: 'tool' })
          : service.disable(args.entryId, { profile: args.profile, caller: 'tool' })
      },
    }),

    defineTool({
      name: 'hotplug_rollback',
      description: `Roll back a mutating operation by its handle (the operationId returned by install/uninstall/enable/disable). 写操作,需审批。${MECHANISM_NOTE}`,
      parameters: {
        handle: { type: 'string', required: true, description: 'Rollback handle (operation id).' },
        profile: { type: 'string', description: 'Profile name (v1: host profile only).' },
      },
      output: {
        schema: mutationResultSchema,
        render: renderMutation,
      },
      execute: async (args) => service.rollback(args.handle, { profile: args.profile, caller: 'tool' }),
    }),

    defineTool({
      name: 'hotplug_audit',
      description: `Query the audit trail (JSONL): op / from (ISO-8601 UTC) / limit filters. 只读。${MECHANISM_NOTE}`,
      parameters: {
        op: { type: 'string', description: 'Filter by operation kind (install/uninstall/enable/disable/rollback).' },
        from: { type: 'string', description: 'Only records at or after this ISO-8601 UTC timestamp.' },
        limit: { type: 'integer', description: 'Max records (default 1000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            records: { type: 'array', items: auditRecordSchema, required: true },
          },
        },
        render: (args, value) => {
          if (value.records.length === 0) return text('no audit records match')
          const lines = ['ts | op | target | result | mode | caller | errorCode']
          for (const r of value.records) {
            lines.push(`${r.ts} | ${r.op} | ${r.target ?? '-'} | ${r.result} | ${r.mode} | ${r.caller} | ${r.errorCode ?? '-'}`)
          }
          if (args.limit !== undefined && value.count >= args.limit) {
            lines.push(`(limited to ${value.count} records; refine with limit/op/from)`)
          }
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const records = service.audit({ op: args.op, from: args.from, limit: args.limit })
        return { count: records.length, records }
      },
    }),
  ]
}

// ── shared output schemas (kept literal so defineTool infers precise types) ─

const runtimeEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entryId: { type: 'string', required: true },
    moduleName: { type: 'string', required: true },
    source: { type: 'string', enum: ['bundle', 'insert', 'user'], required: true },
    enabled: { type: 'boolean', required: true },
    patchTargetable: { type: 'boolean', required: true },
    fiberPhase: { oneOf: [{ type: 'string', enum: ['pending', 'loading', 'active', 'failed', 'unloading'] }, { type: 'null' }], required: true },
    managed: { type: 'boolean', required: true },
  },
} satisfies ValueSchemaSpec

const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    profile: { type: 'string', required: true },
    mode: { type: 'string', enum: ['hot', 'restart'], required: true },
    auditLag: { type: 'boolean' }, // M4 T4.1 additive field
    entries: { type: 'array', items: runtimeEntrySchema, required: true },
    packages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          isBundle: { type: 'boolean', required: true },
          version: { type: 'string' },
        },
      },
      required: true,
    },
    insertRows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          managed: { type: 'boolean', required: true },
        },
      },
      required: true,
    },
  },
} satisfies ValueSchemaSpec

const mutationResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    operationId: { type: 'string' },
    mode: { type: 'string', enum: ['hot', 'restart'] },
    restartRequired: { type: 'boolean' },
    installed: { type: 'array', items: { type: 'string' } },
    rollbackHandle: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
    },
  },
} satisfies ValueSchemaSpec

const auditRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ts: { type: 'string', required: true },
    operationId: { type: 'string', required: true },
    op: { type: 'string', required: true },
    target: { type: 'string' },
    spec: { type: 'string' },
    mode: { type: 'string', enum: ['hot', 'restart'], required: true },
    result: { type: 'string', enum: ['succeeded', 'failed', 'rolled-back'], required: true },
    errorCode: { type: 'string' },
    caller: { type: 'string', enum: ['service', 'rest', 'tool'], required: true },
    patchBeforeHash: { type: 'string' },
    patchAfterHash: { type: 'string' },
    backupPath: { type: 'string' },
  },
} satisfies ValueSchemaSpec

/** One text content block (the only render shape these tools emit). */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** Shared render for mutation results (ok + message + restart hint). */
function renderMutation(args: unknown, value: { ok: boolean; message: string; restartRequired?: boolean }): { type: 'text'; text: string }[] {
  const dryRun = (args as { dryRun?: boolean }).dryRun
  const prefix = dryRun === true ? 'dryRun' : value.ok ? 'ok' : 'FAILED'
  return text(`${prefix}: ${value.message}${value.restartRequired === true ? ' [restart required]' : ''}`)
}
