import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IN_BOX_BUNDLES, detectHostProfile, dshHome, isOfficialProfile, profileDir,
  profileDirIn, readBundles, readManifest, readPatch, restoreInBoxBundles,
  withBundleAdded, withBundleRemoved, writeManifestAtomic,
} from '../src/host/manifest.ts'
import { EngineError, ErrorCodes } from '../src/contract/types.ts'

describe('manifest: profile directory resolution', () => {
  it('resolves DSH_HOME/profiles/<name> and rejects traversal', () => {
    expect(profileDir('web')).toBe(join(dshHome(), 'profiles', 'web'))
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(121), 'a b', 'a!b']) {
      expect(() => profileDir(bad), JSON.stringify(bad)).toThrow(EngineError)
    }
  })

  // M5 M1: the whitelist regex admits '.' and '..' — they must be rejected
  // explicitly (path aliases join() would normalize).
  it('rejects the path aliases "." and ".." with PROFILE_UNSAFE', () => {
    const home = join(tmpdir(), 'hpe-m1-home')
    for (const bad of ['.', '..']) {
      expect(() => profileDirIn(home, bad), JSON.stringify(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCodes.PROFILE_UNSAFE }),
      )
    }
    // normal names still resolve (no over-broadening)
    expect(profileDirIn(home, 'web')).toBe(join(home, 'profiles', 'web'))
    expect(profileDirIn(home, 'my.profile-2')).toBe(join(home, 'profiles', 'my.profile-2'))
  })

  it('detects official profiles', () => {
    expect(isOfficialProfile('web')).toBe(true)
    expect(isOfficialProfile('headless')).toBe(true)
    expect(isOfficialProfile('custom')).toBe(false)
  })

  it('detects the host profile from argv', () => {
    expect(detectHostProfile(['C:/node/node.exe', 'C:/dsh/bin.js', '--profile', 'web'])).toBe('web')
    expect(detectHostProfile(['C:/node/node.exe', 'C:/dsh/bin.js', 'web'])).toBe('web')
    expect(detectHostProfile(['C:/node/node.exe', 'C:/dsh/bin.js'])).toBeUndefined()
  })
})

function makeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpe-manifest-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@linxin666/dsh-web-ui-all': '^0.1.7' },
    dsh: { profile: { bundles: [...IN_BOX_BUNDLES, '@linxin666/dsh-web-ui-all'] } },
  }, undefined, 2) + '\n', 'utf8')
  return dir
}

describe('manifest: bundles bookkeeping (official-reconcile semantics)', () => {
  it('withBundleAdded appends only when absent and is idempotent', () => {
    const dir = makeProfile()
    const m = readManifest(dir)
    const added = withBundleAdded(m, '@new/pkg')
    expect(added.changed).toBe(true)
    expect(added.manifest.dsh?.profile?.bundles).toContain('@new/pkg')
    const again = withBundleAdded(added.manifest, '@new/pkg')
    expect(again.changed).toBe(false)
  })

  it('withBundleRemoved removes only non-dependency non-in-box bundles', () => {
    const dir = makeProfile()
    const m = readManifest(dir)
    // in-box: never removed
    const box = withBundleRemoved(m, '@deepseek-ai/dsh-base')
    expect(box.changed).toBe(false)
    // dependency bundle: kept
    const dep = withBundleRemoved(m, '@linxin666/dsh-web-ui-all')
    expect(dep.changed).toBe(false)
    // stray non-dependency bundle: removed
    const withStray = withBundleAdded(m, '@old/pkg')
    const stray = withBundleRemoved(withStray.manifest, '@old/pkg')
    expect(stray.changed).toBe(true)
    expect(stray.manifest.dsh?.profile?.bundles).not.toContain('@old/pkg')
  })

  it('restoreInBoxBundles re-inserts missing in-box bundles', () => {
    const dir = makeProfile()
    const m = readManifest(dir)
    writeManifestAtomic(dir, {
      ...m,
      dsh: { profile: { bundles: ['@linxin666/dsh-web-ui-all'] } },
    })
    restoreInBoxBundles(dir)
    const restored = readBundles(dir)
    for (const box of IN_BOX_BUNDLES) expect(restored).toContain(box)
  })

  it('writeManifestAtomic round-trips', () => {
    const dir = makeProfile()
    const m = readManifest(dir)
    writeManifestAtomic(dir, { ...m, name: 'renamed' })
    expect(readManifest(dir).name).toBe('renamed')
  })

  // M5 M3: readPatch must be defensive like readManifest — an existing but
  // unreadable patch (permission / race) returns '' instead of throwing.
  it('readPatch returns the empty string for an unreadable patch file', () => {
    const dir = makeProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: row-a\n', 'utf8')
    expect(readPatch(dir)).toBe('- id: row-a\n')
    // Simulate an unreadable file: replace it with a directory, whose read
    // throws EISDIR on both platforms (portable unreadable-file stand-in).
    const dirPath = join(dir, 'cordis.patch.yml')
    rmSync(dirPath, { force: true })
    mkdirSync(dirPath)
    expect(readPatch(dir)).toBe('')
    expect(() => readFileSync(dirPath, 'utf8')).toThrow()
  })
})
