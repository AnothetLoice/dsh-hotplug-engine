/**
 * Profile manifest bookkeeping: profile directory resolution, package.json
 * read/write (dependencies + dsh.profile.bundles), in-box bundle protection,
 * and self-host detection.
 *
 * Bundles bookkeeping semantics MUST match the official `dsh plugin`
 * reconcile (see ADR-0005 §等价性, source `@deepseek-ai/dsh/lib/plugin-*.js`):
 *  - a dependency declaring dsh.bundle.patch joins the layer stack (appended
 *    in dependency order if absent);
 *  - a dependency-listed name that no longer is a bundle leaves the stack;
 *  - in-box bundles (base/web-app/headless) are not dependencies and are
 *    NEVER touched;
 *  - the manifest is persisted atomically.
 *
 * @module dsh-hotplug-engine/host/manifest
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { EngineError, ErrorCodes } from '../contract/types.ts'

/** Profile name whitelist (path traversal guard). */
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/

/** Official built-in profiles that the engine never manages as targets. */
export const OFFICIAL_PROFILES = ['web', 'headless'] as const

/** Installation-owned (in-box) bundles: never dependencies, always layers. */
export const IN_BOX_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
] as const

export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Resolve the DSH home directory (DSH_HOME env, default ~/.dsh). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Validate a profile name and resolve its physical directory. */
export function profileDir(name: string): string {
  return profileDirIn(dshHome(), name)
}

/**
 * Validate a profile name and resolve its directory under an explicit DSH
 * home (used by the engine service so tests/embedded homes never touch the
 * real $DSH_HOME).
 */
export function profileDirIn(dshHomePath: string, name: string): string {
  if (!PROFILE_NAME_RE.test(name) || name.length === 0 || name.length > 120) {
    throw new EngineError(ErrorCodes.PROFILE_UNSAFE, `unsafe profile name: ${JSON.stringify(name)}`)
  }
  return join(dshHomePath, 'profiles', name)
}

/** Whether a profile name is an official built-in. */
export function isOfficialProfile(name: string): boolean {
  return (OFFICIAL_PROFILES as readonly string[]).includes(name)
}

/**
 * Detect the profile that hosts the running instance (self-host).
 * `dsh --profile <name>` flag wins; `dsh web|headless` command mode falls
 * back to the command word. Returns undefined when undetectable.
 */
export function detectHostProfile(argv: readonly string[] = process.argv): string | undefined {
  const flagIndex = argv.indexOf('--profile')
  if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined) {
    return argv[flagIndex + 1]!
  }
  const candidate = argv.find(
    arg => !arg.startsWith('-') && !arg.endsWith('bin.js') && !arg.includes('node'),
  )
  return candidate !== undefined && !candidate.includes('.') ? candidate : undefined
}

/** Read the profile manifest defensively ({} when absent/unreadable). */
export function readManifest(dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
  } catch {
    return {}
  }
}

/** The profile's cordis.patch.yml path (may not exist yet). */
export function patchPath(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

/** Read patch file content, or the empty string when absent. */
export function readPatch(dir: string): string {
  const path = patchPath(dir)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Read the current bundle layer stack of a profile. */
export function readBundles(dir: string): string[] {
  const manifest = readManifest(dir)
  return [...(manifest.dsh?.profile?.bundles ?? [])]
}

/** Read the dependency names of a profile. */
export function readDependencies(dir: string): string[] {
  const manifest = readManifest(dir)
  return Object.keys(manifest.dependencies ?? {})
}

/**
 * Persist a manifest atomically (tmp + rename).
 * @throws when the write fails.
 */
export function writeManifestAtomic(dir: string, manifest: ProfileManifest): void {
  const path = join(dir, 'package.json')
  const content = JSON.stringify(manifest, null, 2) + '\n'
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Add a bundle to the layer stack if absent (appended in dependency order
 * would be official behavior; we append at the end, mirroring reconcile).
 * In-box bundles are never touched. Returns the new manifest (not yet
 * persisted) and whether anything changed.
 */
export function withBundleAdded(manifest: ProfileManifest, packageName: string): { manifest: ProfileManifest; changed: boolean } {
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  if (bundles.includes(packageName)) return { manifest, changed: false }
  bundles.push(packageName)
  return { manifest: { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } }, changed: true }
}

/**
 * Remove a bundle from the layer stack (only if it is no longer a
 * dependency; in-box bundles are never removed by the engine). Returns the
 * new manifest and whether anything changed.
 */
export function withBundleRemoved(manifest: ProfileManifest, packageName: string): { manifest: ProfileManifest; changed: boolean } {
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  const dependencies = Object.keys(manifest.dependencies ?? {})
  if (!bundles.includes(packageName)) return { manifest, changed: false }
  if (IN_BOX_BUNDLES.includes(packageName as (typeof IN_BOX_BUNDLES)[number])) {
    return { manifest, changed: false }
  }
  // Official reconcile keeps a bundle while it is still a bundle dependency.
  if (dependencies.includes(packageName)) return { manifest, changed: false }
  const next = bundles.filter(b => b !== packageName)
  return { manifest: { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } } }, changed: true }
}

/**
 * Restore the in-box bundles' positions after any external change (e.g. the
 * official reconcile). In-box bundles are never dependencies; re-insert any
 * that went missing, preserving their relative order at the end.
 */
export function restoreInBoxBundles(dir: string): void {
  const manifest = readManifest(dir)
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  let changed = false
  for (const box of IN_BOX_BUNDLES) {
    if (!bundles.includes(box)) {
      bundles.push(box)
      changed = true
    }
  }
  if (!changed) return
  writeManifestAtomic(dir, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } })
}
