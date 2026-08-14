# 发布流程

发布到 GitHub 和 npm。

前置:

- pnpm 可用
- `npm whoami` 能通过(已登录 npm)
- GitHub 仓库已建

步骤:

```bash
cd dsh-hotplug-engine
pnpm typecheck && pnpm test   # 全绿再发
pnpm build                    # 重建 lib(lib 被 gitignore)
git tag v$(node -p "require('./package.json').version")
git push origin main --tags
npm publish
pnpm pack                     # 生成的 tgz 附到 GitHub release
```

说明:

- 版本号在 `package.json` 手动维护,`git tag` 与之一致;每次发版先 bump。
- `npm publish` 只发 `files` 白名单(lib + cordis.patch.yml + README + README.en.md + LICENSE),不带 docs/plans/tests。
