/**
 * v0.1.4 实机验证脚本:真实 pnpm + 真实 npm 包 + 独立临时 profile 的
 * install → snapshot(installedAt/critical) → rollback 链路 + 错误码验证。
 *
 * 运行(管理员 PowerShell):
 *   cd D:\code\dsh\dsh-hotplug-engine
 *   pnpm exec tsx scripts/verify-v014-e2e.ts
 *
 * 约束:全程用独立临时 profile(临时目录,非 web/3080),验证后自动清理。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HotplugEngineService } from '../src/host/service.ts'
import { readInsertRows } from '../src/host/patch.ts'
import { ErrorCodes } from '../src/contract/types.ts'

function makeProfile(dshHome: string): string {
  const profileDir = join(dshHome, 'profiles', 'verify')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-verify', private: true, dependencies: {} }), 'utf8')
  return profileDir
}

async function main(): Promise<void> {
  // ── 场景 1: 真实 install → snapshot → rollback ──────────────────────────
  const dshHome = mkdtempSync(join(tmpdir(), 'hpe-verify-'))
  const profileDir = makeProfile(dshHome)
  const ctx = new Context()
  ctx.provide('loader', { entries: () => [] })
  // 不注入 hmr → engine mode='restart'(install 非 bundle 写 insert 行 + restart,不观察窗口)
  const svc = new HotplugEngineService(ctx, { dshHomePath: dshHome, hostProfile: 'verify' })
  console.log('engine mode:', svc.mode)

  const spec = 'is-number'
  const r = await svc.install(spec)
  console.log('\n=== install ===')
  console.log(JSON.stringify({ ok: r.ok, message: r.message, mode: r.mode, restartRequired: r.restartRequired, installed: r.installed, errors: r.errors }, null, 2))

  if (r.ok) {
    const snap = svc.snapshot()
    const pkg = snap.packages.find(p => p.name === spec)
    console.log('\n=== snapshot ===')
    console.log('package:', JSON.stringify(pkg))
    console.log('installedAt:', pkg?.installedAt, '(应为 ISO 时间)')
    console.log('insertRows:', JSON.stringify(snap.insertRows))
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    console.log('patch 含 insert 行:', readInsertRows(patch).some(row => row.name === spec))

    if (r.rollbackHandle !== undefined) {
      const rb = await svc.rollback(r.rollbackHandle)
      console.log('\n=== rollback ===')
      console.log(JSON.stringify({ ok: rb.ok, message: rb.message }, null, 2))
      const manifestAfter = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      console.log('rollback 后 deps:', JSON.stringify(manifestAfter.dependencies ?? {}), '(应不含 is-number)')
      console.log('rollback 后 patch insert 行:', JSON.stringify(readInsertRows(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))))
    }
  }

  // ── 场景 2: 坏 pnpmPath → PNPM_NOT_EXECUTABLE ───────────────────────────
  const badHome = mkdtempSync(join(tmpdir(), 'hpe-verify-bad-'))
  makeProfile(badHome)
  const badCtx = new Context()
  badCtx.provide('loader', { entries: () => [] })
  // 无扩展名 + 不存在的 pnpmPath → 直接 spawn → ENOENT → PNPM_NOT_EXECUTABLE
  const badSvc = new HotplugEngineService(badCtx, { dshHomePath: badHome, hostProfile: 'verify', pnpmPath: join(badHome, 'no-such-pnpm') })
  const bad = await badSvc.install('is-number')
  console.log('\n=== 坏 pnpmPath 错误码 ===')
  console.log(JSON.stringify({ ok: bad.ok, errors: bad.errors }, null, 2))
  console.log('expect PNPM_NOT_EXECUTABLE:', bad.errors?.[0]?.code === ErrorCodes.PNPM_NOT_EXECUTABLE)

  // 清理
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(badHome, { recursive: true, force: true })
  console.log('\ncleaned up:', dshHome, 'and', badHome)
}

main().catch(e => { console.error(e); process.exit(1) })
