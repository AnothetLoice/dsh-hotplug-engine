# dsh-hotplug-engine

[中文](./README.md)

A service plugin for managing DSH plugins. Marketplaces, agents, and other plugins can call it for the full chain: install, uninstall, enable, disable, rollback, audit.

## What it does

DSH manages plugins through `cordis.patch.yml` and the loader. This plugin wraps those operations into a service: edit the patch, run pnpm, confirm health after install, roll back on failure, audit everything. It only touches files and commands, never the core.

## What it doesn't do

- **Not a marketplace**: no catalog, search, rankings, or curation. The caller supplies `spec` (what to install, from where); the engine doesn't guess.
- **Doesn't rewrite official mechanisms**: HMR, loader, and patch semantics are official; the engine only consumes them.
- **Holds no state of its own**: the official config tree is the single source of truth; the engine only projects and diffs.
- **No install UI**: the UI is a minimal management panel (view, toggle, roll back, audit) — no spec input.

## Entry points

| Scenario | Entry |
|---|---|
| Marketplace / plugin-manager UI | inject `hotplugEngine`, or call REST |
| Agent sessions | `hotplug_*` tools |
| Host plugins | inject `hotplugEngine` |

## Install

```bash
pnpm --dir <profile-dir> add dsh-hotplug-engine
# or dsh plugin add dsh-hotplug-engine
```

Bundle package: restart the profile after install/uninstall; refresh the page for a new client panel.

## Quick start

- **Host inject**: `inject: ['hotplugEngine']`, then call `install` / `rollback` / `enable` on `ctx.hotplugEngine`. The promise resolves when the operation is done.
- **REST**: prefix `/api/dsh-hotplug`, same-origin. Writes: `install` / `uninstall` / `enable` / `disable` / `rollback`. Reads: `snapshot` / `status` / `audit` / `operations` / `events` (SSE).
- **Tools**: `hotplug_status` / `hotplug_install` / `hotplug_uninstall` / `hotplug_toggle` / `hotplug_rollback` / `hotplug_audit`; write tools go through approval.

Full contract: [docs/01-contract.md](docs/01-contract.md).

## License

MIT
