/**
 * Installer: pnpm discovery + spawn + package-shape detection (design §3 /
 * ADR-0005).
 *
 * Spawn strategy (empirically verified on Windows 2026-08-14):
 *  - direct spawn of a .cmd shim → EINVAL;
 *  - bare command name via PATH → ENOENT (Node does not resolve .cmd via
 *    PATHEXT for spawn);
 *  - `cmd.exe /d /s /c "<quoted-cmd> <args>"` with `windowsVerbatimArguments:
 *    true` works. Args are validated against cmd metacharacters before being
 *    embedded (injection guard), then each arg is quoted.
 *
 * @module dsh-hotplug-engine/host/installer
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import { EngineError, ErrorCodes } from '../contract/types.ts'

/** Result of a pnpm invocation. */
export interface CommandResult {
  ok: boolean
  exitCode: number | null
  output: string
  /** Spawn-stage error code (e.g. 'ENOENT'); undefined when the process
   * spawned and exited normally. v0.1.4 (direction B) — lets the service map
   * spawn failures to HOTPLUG.PNPM_NOT_EXECUTABLE. */
  spawnError?: string
}

/** Spec metacharacters rejected before embedding into a cmd command line
 * (`%` included: cmd expands %VAR% even inside quotes — review 2026-08-14). */
const CMD_METACHARS = /[&|<>^"%\r\n]/

/**
 * Validate an install spec (npm name / path / git URL / file:).
 * Rejects anything that could break out of the spawned command line.
 * @throws {EngineError} SPEC_UNSAFE (contract §8, review 2026-08-14).
 */
export function assertSafeSpec(spec: string): void {
  if (spec.length === 0 || spec.length > 500 || CMD_METACHARS.test(spec)) {
    throw new EngineError(ErrorCodes.SPEC_UNSAFE, `unsafe install spec: ${JSON.stringify(spec)}`)
  }
}

/** pnpm candidate basenames in PATHEXT order: on Windows `.exe`/`.com`
 * first (directly spawnable), then `.cmd`/`.bat` (spawned via cmd.exe),
 * with the extension-less POSIX sh script last (not directly spawnable on
 * Windows). v0.1.4 (direction B). */
function pnpmCandidateNames(): string[] {
  return process.platform === 'win32'
    ? ['pnpm.exe', 'pnpm.com', 'pnpm.cmd', 'pnpm.bat', 'pnpm']
    : ['pnpm']
}

/** Directories searched for a pnpm executable: PATH (split by the platform
 * delimiter — fixes the POSIX ';' bug) plus common install locations.
 * Corepack-provided pnpm shims live in the node install directory (covered by
 * PATH and %ProgramFiles%\nodejs), so no separate corepack probe is needed.
 * v0.1.4 (direction A). */
function pnpmSearchDirs(): string[] {
  const dirs: string[] = []
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== '') dirs.push(dir)
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const appData = process.env.APPDATA
    const programFiles = process.env.ProgramFiles
    if (localAppData !== undefined) dirs.push(join(localAppData, 'pnpm'))
    if (appData !== undefined) dirs.push(join(appData, 'npm'))
    if (programFiles !== undefined) dirs.push(join(programFiles, 'nodejs'))
  }
  return dirs
}

/** All pnpm candidate paths in discovery order (explicit first). Used by the
 * error detail to show where the engine searched. v0.1.4 (direction A). */
export function findPnpmCandidates(explicit?: string): string[] {
  const found: string[] = []
  const push = (candidate: string): void => {
    if (candidate !== '' && !found.includes(candidate)) found.push(candidate)
  }
  if (explicit !== undefined && explicit.length > 0) {
    // Injection guard (direction A): on Windows the explicit path is embedded
    // into a cmd /c command line, so reject cmd metacharacters there. POSIX
    // spawns the path directly (array args, no shell), so no such guard needed.
    if (process.platform !== 'win32' || !CMD_METACHARS.test(explicit)) push(explicit)
    return found
  }
  for (const dir of pnpmSearchDirs()) {
    for (const name of pnpmCandidateNames()) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) push(candidate)
    }
  }
  return found
}

/** First available pnpm executable (explicit → PATH/common locations).
 * Returns undefined when none is found; use findPnpmCandidates for the full
 * searched list to build an actionable error. v0.1.4 (direction A/B). */
export function findPnpm(explicit?: string): string | undefined {
  return findPnpmCandidates(explicit)[0]
}

/** Whether a spec looks like a local directory (path or file:/link: prefix). */
export function isLocalDirSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:') || spec.startsWith('link:')
}

/**
 * Run one pnpm command with an argument array (no shell string building).
 * On Windows the .cmd shim is launched via cmd.exe with windowsVerbatimArguments.
 */
export function runPnpm(
  pnpmPath: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(pnpmPath)
  const spawnArgs: readonly string[] = isWinCmd
    // cmd /s strips the OUTERMOST quote pair, so the whole command string is
    // wrapped in an extra pair of quotes to keep the inner quoting balanced
    // (empirically verified 2026-08-14; without the outer wrap multi-quoted
    // args unbalance and cmd reports "filename syntax is incorrect").
    ? ['/d', '/s', '/c', `""${pnpmPath}" ${args.map(quoteArg).join(' ')}""`]
    : args
  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    windowsVerbatimArguments: isWinCmd,
    timeout: opts.timeoutMs ?? 10 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  return new Promise((resolve) => {
    const child = spawn(isWinCmd ? 'cmd.exe' : pnpmPath, spawnArgs, spawnOptions)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error: Error) => {
      const code = (error as { code?: string }).code
      resolve({ ok: false, exitCode: null, output, spawnError: code ?? error.message })
    })
    child.on('close', (code: number | null) => {
      resolve({ ok: code === 0, exitCode: code, output })
    })
  })
}

/** Quote one arg for embedding in a cmd /c command line (metachars rejected upstream). */
function quoteArg(arg: string): string {
  // Safe chars pass through unquoted; anything else is double-quoted
  // (embedded quotes are rejected by assertSafeSpec for specs and by the
  // package-name whitelist for names).
  return /^[A-Za-z0-9._\/@:~=-]+$/.test(arg) ? arg : `"${arg}"`
}

/** `pnpm --dir <profile> add <spec>`. */
export function pnpmAdd(profileDir: string, spec: string, pnpmPath: string, timeoutMs?: number): Promise<CommandResult> {
  return runPnpm(pnpmPath, ['--dir', profileDir, 'add', spec], { cwd: profileDir, timeoutMs })
}

/** `pnpm --dir <profile> remove <name>`. */
export function pnpmRemove(profileDir: string, name: string, pnpmPath: string, timeoutMs?: number): Promise<CommandResult> {
  return runPnpm(pnpmPath, ['--dir', profileDir, 'remove', name], { cwd: profileDir, timeoutMs })
}

/**
 * Resolve the real package name after an install: pnpm writes the package's
 * own name as the dependency key while the requested source may have been a
 * path/git/tarball locator. Exact match first, then a dependency value
 * containing the source string.
 */
export function resolveInstalledName(dependencies: Record<string, string>, source: string): string | null {
  if (dependencies[source] !== undefined) return source
  const hit = Object.keys(dependencies).find(key => dependencies[key] === source || dependencies[key]?.includes(source))
  return hit ?? null
}

/** Whether an installed package declares dsh.bundle (bundle-plugin shape). */
export function packageHasBundlePatch(pkgDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}
