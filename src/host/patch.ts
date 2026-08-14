/**
 * Write-layer: controlled editing of a profile's cordis.patch.yml.
 *
 * The engine NEVER rewrites the whole file (that would destroy user comments
 * and hand-written rows). It appends/removes a single owner-marked managed
 * block per row id, using line markers that make every edit reversible:
 *
 *   # dsh-hotplug-engine:managed:start
 *   - insert:
 *       - id: <rowId>
 *         name: '<package>'
 *   # dsh-hotplug-engine:managed:end
 *
 * or a disable block:
 *
 *   # dsh-hotplug-engine:managed:start
 *   - id: <entryId>
 *     disabled: true
 *   # dsh-hotplug-engine:managed:end
 *
 * YAML traps handled (community-verified, see harness-research audit §3.2):
 *  - an empty-array document line (`[]`) must be dropped before appending any
 *    row, or the file becomes a two-document YAML and fails to start;
 *  - package names starting with `@` must be single-quoted (bare `@` is a
 *    YAML reserved indicator);
 *  - after removing rows, a file left with no patch row at all (comments or
 *    blank lines only) parses as null and HMR reload fails — restore the
 *    official `[]` template instead.
 *
 * Safety (design §2.2 / ADR-0004):
 *  - entry ids and package names go through strict whitelists; package names
 *    must match the npm naming convention (no `'`/`:`/spaces/control chars —
 *    single-quote escaping injection surface);
 *  - engine-written rows NEVER contain `!!js` expressions;
 *  - every write is atomic (tmp + rename) and validated by re-parsing the
 *    result with the official patch dialect (opaque `!!js`, never executed).
 *
 * Line-level editing semantics follow the community dsh-web-plugin-manager
 * patch.ts (MIT, https://github.com/LX2000WASD/dsh-web-plugin-manager), with
 * engine-specific markers and hardening.
 *
 * @module dsh-hotplug-engine/host/patch
 */

import { load, JSON_SCHEMA, Type } from 'js-yaml'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { EngineError, ErrorCodes } from '../contract/types.ts'

/** Owner label of every managed block written by this engine. */
export const OWNER = 'dsh-hotplug-engine'
const START = `# ${OWNER}:managed:start`
const END = `# ${OWNER}:managed:end`

/** Official empty patch template (a bare-array document, Loader-safe). */
export const EMPTY_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
].join('\n') + '\n'

/** Patch-file dialect: `!!js` scalars round-trip as opaque expression nodes
 * (never executed here — the Loader evaluates them at activation). */
const JsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const patchSchema = JSON_SCHEMA.extend(JsExpr)

/**
 * Validate that content is a structurally sound patch document: parses with
 * the official dialect, is a top-level array, and is not a null document.
 * @throws {EngineError} PATCH_INVALID when any check fails.
 */
export function validatePatchContent(content: string): void {
  let parsed: unknown
  try {
    parsed = load(content, { schema: patchSchema })
  } catch (error) {
    throw new EngineError(
      ErrorCodes.PATCH_INVALID,
      `patch file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null) {
    throw new EngineError(ErrorCodes.PATCH_INVALID, 'patch file parses to null (comments-only document?)')
  }
  if (!Array.isArray(parsed)) {
    throw new EngineError(ErrorCodes.PATCH_INVALID, 'patch file must be a top-level YAML array')
  }
}

/** Validate an entry id so it cannot break the YAML block structure. */
export function assertSafeEntryId(id: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.length === 0 || id.length > 120) {
    throw new EngineError(
      ErrorCodes.PATCH_UNSAFE_TARGET,
      `unsafe entry id: ${JSON.stringify(id)}`,
    )
  }
}

/** npm naming convention (ADR-0004 hardening): lowercase, URL-safe, no
 * `'`/`:`/spaces/control chars; optional @scope/ prefix. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Validate a package name written into a quoted YAML scalar. */
export function assertSafePackageName(name: string): void {
  if (name.length === 0 || name.length > 200 || !NPM_NAME_RE.test(name)) {
    throw new EngineError(
      ErrorCodes.PATCH_UNSAFE_VALUE,
      `unsafe package name: ${JSON.stringify(name)}`,
    )
  }
}

/** Single-quote a YAML scalar (' doubled inside; @ prefixes stay safe). */
export function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** One insert row found in a patch file. */
export interface PatchInsertRow {
  /** Insert row id (the mounted entry id). */
  id: string
  /** Module specifier (package name) the row mounts. */
  name: string
  /** Whether the row lives inside an engine managed block. */
  managed: boolean
  /** `disabled: true` present on the row (file-level state; M4 T4.2). */
  disabled?: boolean
}

/**
 * Read every insert row from a patch file (managed blocks and user rows).
 * Line-level parse of top-level `- insert:` blocks and their indented
 * `- id:` / `name:` / `disabled:` pairs; never parses the whole document.
 */
export function readInsertRows(content: string): PatchInsertRow[] {
  const rows: PatchInsertRow[] = []
  const lines = content.split('\n')
  let inManaged = false
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === START) { inManaged = true; continue }
    if (trimmed === END) { inManaged = false; continue }
    if (trimmed === 'insert:' || trimmed.startsWith('- insert:')) {
      inInsert = true
      continue
    }
    if (!inInsert) continue
    // A top-level list item (non-indented `- id:`) ends the insert block.
    if (/^- id:/.test(trimmed) && !line.startsWith('    ')) {
      inInsert = false
      continue
    }
    const idMatch = /^(\s*)- id:\s*([^\s]+)/.exec(line)
    if (idMatch === null) continue
    const row: PatchInsertRow = { id: idMatch[2]!, name: idMatch[2]!, managed: inManaged }
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!
      const nextTrimmed = next.trim()
      // A new row starts (any indentation) — never let a sibling row's
      // fields pollute this row's name/disabled (M4 freeze arch review M4).
      if (/^(\s*)- id:/.test(nextTrimmed) || nextTrimmed === START || nextTrimmed === END) break
      const nameMatch = /name:\s*(.+)/.exec(nextTrimmed)
      if (nameMatch !== null) {
        row.name = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
        continue
      }
      const disabledMatch = /disabled:\s*(true|false)/.exec(nextTrimmed)
      if (disabledMatch !== null) {
        row.disabled = disabledMatch[1] === 'true'
        continue
      }
    }
    rows.push(row)
  }
  return rows
}

/**
 * Read the ids of top-level rows in a patch file — rows the user (or the
 * engine's managed blocks) explicitly manages. Insert-block child rows
 * (indented) are not targets and are excluded.
 */
export function readManagedIds(content: string): Set<string> {
  const ids = new Set<string>()
  for (const line of content.split('\n')) {
    const match = /^-\s*id:\s*([^\s]+)/.exec(line)
    if (match !== null) ids.add(match[1]!)
  }
  return ids
}

/**
 * Find the managed block containing `entryId` and return ALL row ids in it
 * (observation-window full-block reconciliation, design §5.3). Blocks are
 * single-row today; the helper is correct for multi-row blocks too.
 */
export function blockRowIds(content: string, entryId: string): string[] {
  const lines = content.split('\n')
  let inManaged = false
  let ids: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === START) {
      inManaged = true
      ids = []
      continue
    }
    if (trimmed === END) {
      if (inManaged && ids.includes(entryId)) return [...ids]
      inManaged = false
      ids = []
      continue
    }
    if (!inManaged) continue
    const match = /(?:^-\s*id:|\s{4}- id:)\s*([^\s]+)/.exec(line)
    if (match !== null) ids.push(match[1]!)
  }
  return []
}

/** Whether a patch content already contains a disable block for the entry id. */
export function hasManagedDisable(content: string, entryId: string): boolean {
  const lines = content.split('\n')
  let blockStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trimEnd() === START) { blockStart = i; continue }
    if (line.trimEnd() === END) { blockStart = -1; continue }
    if (blockStart < 0) continue
    const block = scanBlock(lines, blockStart)
    // Only a matching disable block counts; other blocks (e.g. an insert
    // block for the same id) do not short-circuit the scan.
    if (block !== undefined && block.kind === 'disable' && block.id === entryId) return true
  }
  return false
}

/**
 * Find a TOP-LEVEL user row by id (column-0 `- id:` outside managed blocks).
 * Indented insert children never match. Returns { managed } when found.
 */
export function findTopLevelRow(content: string, entryId: string): { managed: boolean } | undefined {
  const lines = content.split('\n')
  let inManaged = false
  const pattern = topRowPattern(entryId)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === START) { inManaged = true; continue }
    if (trimmed === END) { inManaged = false; continue }
    if (!line.startsWith(' ') && pattern.test(line)) return { managed: inManaged }
  }
  return undefined
}

/**
 * Add (or refresh) the disable block for one entry id. Returns the new file
 * content; the caller persists it.
 *
 * Only DISABLE-kind blocks targeting the id are removed first (refresh in
 * place). An INSERT block for the same id (a managed insert row) is
 * preserved — disabling must not unmount the insert (ADR-0004, review 2026-08-14).
 */
export function addDisableBlock(content: string, entryId: string): string {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const without = removeManagedBlocksOfKind(lines, entryId, 'disable').lines
  const block = [
    START,
    `- id: ${entryId}`,
    '  disabled: true',
    END,
  ]
  return joinDocument(without, block)
}

/** Remove the disable block for one entry id (insert blocks untouched). Returns new content. */
export function removeDisableBlock(content: string, entryId: string): string {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const { lines: without } = removeManagedBlocksOfKind(lines, entryId, 'disable')
  return normalizeDocument(without)
}

/**
 * Drop every managed block of a specific kind targeting `entryId`. Used by
 * add/removeDisableBlock so INSERT blocks survive (review 2026-08-14).
 */
function removeManagedBlocksOfKind(
  lines: readonly string[],
  entryId: string,
  kind: 'insert' | 'disable',
): { lines: string[]; removed: boolean } {
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trimEnd() === START) {
      let j = i + 1
      while (j < lines.length && lines[j]!.trimEnd() !== END) j += 1
      if (j >= lines.length) break // unterminated marker: stop, keep the rest
      const block = scanBlock(lines, i)
      if (block !== undefined && block.kind === kind && block.id === entryId) {
        i = j + 1 // skip the whole block
        removed = true
        continue
      }
      out.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  return { lines: out, removed }
}

/**
 * Drop every managed block targeting `entryId` (either a disable block or an
 * insert block whose child row id matches). Block-scoped rollback path
 * (design §5.2): user rows and other content are left untouched.
 */
export function removeManagedBlockForId(content: string, entryId: string): { content: string; removed: boolean } {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const { lines: without, removed } = removeManagedBlocks(lines, entryId)
  if (!removed) return { content, removed: false }
  return { content: normalizeDocument(without), removed: true }
}

/** Escaped literal for one row id inside a line-level regex. */
function rowIdPattern(entryId: string): string {
  return entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Line-level top-row regex for one entry id. */
function topRowPattern(entryId: string): RegExp {
  return new RegExp('^-\\s*id:\\s*' + rowIdPattern(entryId) + '\\s*$')
}

/** Direct-child (2-space) `disabled:` flag of a top-level row. Nested keys
 * (≥4 spaces, e.g. `config.features.context.disabled`) MUST NOT match — the
 * row-level toggle only owns its immediate `disabled:` child (review 2026-08-14). */
const DISABLED_CHILD_RE = /^ {2}disabled:\s*(true|false)\s*$/

/**
 * Line-level enable of a user-written top-level row: drop its `disabled:`
 * child and, when nothing else remains under it, the row itself. Returns the
 * new content and whether anything changed.
 */
export function applyRowEnabled(content: string, entryId: string): { content: string; changed: boolean } {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const pattern = topRowPattern(entryId)
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (pattern.test(line)) {
      out.push(line)
      i += 1
      // Consume the row's indented subtree, dropping the direct disabled child.
      const children: string[] = []
      while (i < lines.length && lines[i]!.startsWith(' ')) {
        const child = lines[i]!
        if (DISABLED_CHILD_RE.test(child)) {
          changed = true
          i += 1
          continue
        }
        children.push(child)
        i += 1
      }
      if (children.length === 0) {
        // Nothing left under the row: drop the empty patch row too.
        out.pop()
      } else {
        out.push(...children)
      }
      continue
    }
    out.push(line)
    i += 1
  }
  return changed ? { content: normalizeDocument(out), changed: true } : { content, changed: false }
}

/**
 * Line-level disable of a user-written top-level row: add or update its
 * `disabled: true` child. Returns the new content and whether anything
 * changed (false when no such top-level row exists — the caller falls back
 * to the managed block).
 */
export function applyRowDisabled(content: string, entryId: string): { content: string; changed: boolean } {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const pattern = topRowPattern(entryId)
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (pattern.test(line)) {
      out.push(line)
      i += 1
      let disabledSeen = false
      while (i < lines.length && lines[i]!.startsWith(' ')) {
        const child = lines[i]!
        if (DISABLED_CHILD_RE.test(child)) {
          out.push('  disabled: true')
          disabledSeen = true
          changed = true
          i += 1
          continue
        }
        out.push(child)
        i += 1
      }
      if (!disabledSeen) {
        out.push('  disabled: true')
        changed = true
      }
      continue
    }
    out.push(line)
    i += 1
  }
  return changed ? { content: out.join('\n') + '\n', changed: true } : { content, changed: false }
}

/**
 * Add (or refresh) the insert block mounting one non-bundle plugin. The name
 * is single-quoted (YAML @ trap) and validated against the npm convention.
 */
export function addInsertRow(content: string, rowId: string, name: string): string {
  assertSafeEntryId(rowId)
  assertSafePackageName(name)
  const lines = content.length === 0 ? [] : content.split('\n')
  const without = removeManagedBlocks(lines, rowId).lines
  const block = [
    START,
    '- insert:',
    `    - id: ${rowId}`,
    `      name: ${yamlQuote(name)}`,
    END,
  ]
  return joinDocument(without, block)
}

/** Remove the insert block for one row id. Returns new content and whether a block was removed. */
export function removeInsertRow(content: string, rowId: string): { content: string; removed: boolean } {
  return removeManagedBlockForId(content, rowId)
}

/** Identify one managed block: its kind and the row id it targets. */
function scanBlock(lines: readonly string[], start: number): { kind: 'insert' | 'disable'; id: string } | undefined {
  let kind: 'insert' | 'disable' | undefined
  let id: string | undefined
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j]!
    const trimmed = line.trim()
    if (trimmed === END) break
    if (trimmed === 'insert:' || trimmed.startsWith('- insert:')) {
      kind = 'insert'
    } else if (kind === undefined && /^-\s*id:/.test(trimmed)) {
      // Any other top-level row line makes this a disable block.
      kind = 'disable'
    }
    if (kind === 'insert') {
      const match = /^\s{4}- id:\s*(.+?)\s*$/.exec(line)
      if (match !== null) id = match[1]!
    } else {
      const match = /^-\s*id:\s*(.+?)\s*$/.exec(line)
      if (match !== null) id = match[1]!
    }
  }
  return kind !== undefined && id !== undefined ? { kind, id } : undefined
}

/**
 * Drop every managed block targeting `entryId` (either a disable block or an
 * insert block whose child row id matches).
 */
function removeManagedBlocks(lines: readonly string[], entryId: string): { lines: string[]; removed: boolean } {
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trimEnd() === START) {
      let j = i + 1
      while (j < lines.length && lines[j]!.trimEnd() !== END) j += 1
      if (j >= lines.length) break // unterminated marker: stop, keep the rest
      const block = scanBlock(lines, i)
      if (block !== undefined && block.id === entryId) {
        i = j + 1 // skip the whole block
        removed = true
        continue
      }
      out.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  return { lines: out, removed }
}

/** Join kept lines with an appended block, dropping empty-doc and blank lines. */
function joinDocument(base: readonly string[], block: readonly string[]): string {
  const significant = base.filter(l => l.trim() !== '[]' && l.trim() !== '')
  const joined = [...significant, ...block].join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

/**
 * Normalize kept lines after a removal: drop empty-doc/blank lines, collapse
 * blank runs, and restore the official `[]` template when no patch row remains
 * (a comments-only file parses as null and HMR reload fails).
 */
function normalizeDocument(lines: readonly string[]): string {
  const significant = lines.filter(l => l.trim() !== '[]' && l.trim() !== '')
  const text = significant.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  const hasRow = text.split('\n').some(
    l => /^- id:/.test(l) || /^- insert:/.test(l) || /^insert:/.test(l),
  )
  return hasRow ? text : EMPTY_TEMPLATE
}

/** Deterministic row id from a package name (`@scope/pkg` → `scope-pkg`). */
export function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

/** Short content hash (8 hex) used for row-id collision disambiguation. */
export function shortHash8(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8)
}

/**
 * Ensure the row id is unique within the patch: if a different package
 * already owns the base id, append a short hash of the package name.
 */
export function ensureUniqueRowId(content: string, baseId: string, packageName: string): string {
  assertSafeEntryId(baseId)
  const rows = readInsertRows(content)
  const conflict = rows.find(row => row.id === baseId && row.name !== packageName)
  if (conflict === undefined) return baseId
  // Truncate the BASE first so the hash suffix always survives (review 2026-08-14).
  const base = baseId.slice(0, 111)
  const candidate = `${base}-${shortHash8(packageName)}`
  assertSafeEntryId(candidate)
  return candidate
}

/**
 * Persist new content atomically (tmp + rename) and verify by read-back.
 * The rename is retried briefly on Windows-style sharing violations
 * (EACCES/EBUSY/EPERM — the HMR watcher may briefly hold the target).
 * @throws {EngineError} PATCH_INVALID when the written file fails to read
 * back or its content mismatches; other fs errors after retries.
 */
export function writePatchAtomic(patchPath: string, content: string): void {
  validatePatchContent(content)
  const tmp = `${patchPath}.${process.pid}.${randomSuffix()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  let lastError: unknown
  for (let attempt = 0; attempt < RENAME_RETRY_LIMIT; attempt += 1) {
    try {
      renameSync(tmp, patchPath)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'EBUSY' && code !== 'EPERM') break
      sleepSync(RENAME_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  if (lastError !== undefined) {
    rmSync(tmp, { force: true })
    throw lastError
  }
  const readBack = readFileSync(patchPath, 'utf8')
  if (readBack !== content) {
    throw new EngineError(ErrorCodes.PATCH_INVALID, 'patch write read-back mismatch')
  }
}

const RENAME_RETRY_LIMIT = 10
const RENAME_RETRY_DELAY_MS = 50

function sleepSync(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* busy wait */ }
}

/** Random suffix for unique tmp names (crypto random, hex). */
function randomSuffix(): string {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)
}

/** Resolve the patch file path inside a profile directory. */
export function patchPathOf(profileDir: string): string {
  return join(profileDir, 'cordis.patch.yml')
}
