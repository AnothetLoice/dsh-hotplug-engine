/**
 * Pre/post-install quality gate (design §4 / ADR-0005): reject packages that
 * would fail-loud at boot (missing entry, undeclared bare imports, missing
 * client bundle) BEFORE they break the profile.
 *
 * The "Loader-provided" set is locked to the official 0.1.0-rc.6 client
 * platform table (mirrors the community dsh-web-plugin-manager LOADER_PROVIDED,
 * MIT, https://github.com/LX2000WASD/dsh-web-plugin-manager); re-verify when
 * the kernel is upgraded.
 *
 * @module dsh-hotplug-engine/host/quality
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Specifiers the loader provides without the plugin declaring them. */
export const LOADER_PROVIDED: ReadonlySet<string> = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
])

export interface QualityResult {
  ok: boolean
  /** Human-readable issue list (escaped for UI output by the caller). */
  issues: string[]
}

/**
 * Static quality check of one package directory.
 * @param pkgDir the package directory (installed entity or local source dir).
 */
export function qualityCheck(pkgDir: string): QualityResult {
  const issues: string[] = []
  const manifestPath = join(pkgDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return {
      ok: false,
      issues: [`cannot read its package.json: ${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const entry = packageEntry(pkgDir, manifest)
  if (entry === null) {
    issues.push('no resolvable entry file (exports["."].default / main / index.js)')
  }

  if (entry !== null) {
    const declared = new Set([
      ...Object.keys((manifest['dependencies'] ?? {}) as Record<string, unknown>),
      ...Object.keys((manifest['peerDependencies'] ?? {}) as Record<string, unknown>),
    ])
    for (const spec of scanImports(entry)) {
      if (declared.has(spec) || LOADER_PROVIDED.has(spec)) continue
      issues.push(`imports ${spec} but does not declare it (would fail at boot)`)
    }
  }

  const dsh = manifest['dsh'] as { client?: { platform?: unknown } } | undefined
  if (dsh?.client !== undefined) {
    const clientPath = clientBundlePath(pkgDir, manifest)
    if (clientPath === undefined) {
      issues.push('declares dsh.client but exports no "./client" bundle (MissingClientBundleError at boot)')
    } else if (!existsSync(clientPath)) {
      issues.push(`client bundle missing at ${clientPath} (run the build before publishing)`)
    }
  }

  return { ok: issues.length === 0, issues }
}

/** Resolve a package's entry file (exports["."] string/object, main, module, index.js). */
export function packageEntry(pkgDir: string, manifest: Record<string, unknown>): string | null {
  const exportsField = manifest['exports'] as Record<string, unknown> | undefined
  const dot = exportsField !== undefined && typeof exportsField === 'object' && exportsField !== null
    ? exportsField['.']
    : undefined
  const candidates: unknown[] = [
    typeof dot === 'string' ? dot : typeof dot === 'object' && dot !== null ? (dot as Record<string, unknown>)['default'] : undefined,
    manifest['main'],
    manifest['module'],
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const resolved = join(pkgDir, candidate)
    if (existsSync(resolved)) return resolved
  }
  const index = join(pkgDir, 'index.js')
  return existsSync(index) ? index : null
}

/** Resolve exports["./client"] to a file path (or undefined). */
export function clientBundlePath(pkgDir: string, manifest: Record<string, unknown>): string | undefined {
  const exportsField = manifest['exports'] as Record<string, unknown> | undefined
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (typeof client === 'string') return join(pkgDir, client)
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>)['default']
    if (typeof fallback === 'string') return join(pkgDir, fallback)
  }
  return undefined
}

/** Bare specifiers imported by a JS entry (relative/node: paths excluded). */
export function scanImports(filePath: string): string[] {
  try {
    const code = readFileSync(filePath, 'utf8')
    const found = new Set<string>()
    const pattern = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g
    for (const match of code.matchAll(pattern)) {
      const spec = match[1]!
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      found.add(spec)
    }
    return [...found]
  } catch {
    return []
  }
}
