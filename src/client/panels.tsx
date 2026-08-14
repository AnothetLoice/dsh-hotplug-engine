/**
 * Hotplug engine management panel (minimal scope, contract §5/§7 + plan T3.4):
 * three list views (entries / packages / insert rows) + operations with
 * rollback + audit. Driven by REST, refreshed by SSE; the snapshot is the
 * final-consistency source. NO marketplace, NO install/spec input (Non-Goal
 * guard — A3.5/A3.8).
 *
 * @module dsh-hotplug-engine/client/panels
 */

import { useCallback, useEffect, useState } from 'react'
import type { AuditRecord, EngineSnapshot, OperationInfo, RuntimeEntry } from '../contract/types.ts'
import type { HotplugApi } from './api.ts'

type View = 'entries' | 'packages' | 'rows' | 'operations' | 'audit'

const VIEWS: { key: View; label: string }[] = [
  { key: 'entries', label: '条目' },
  { key: 'packages', label: '包' },
  { key: 'rows', label: '插入行' },
  { key: 'operations', label: '操作' },
  { key: 'audit', label: '审计' },
]

const SOURCE_LABEL: Record<RuntimeEntry['source'], string> = {
  bundle: 'bundle',
  insert: 'insert',
  user: 'user',
}

/** Decode the entities the service applies (escapeHtml) so UI text reads
 * naturally. Safe: React text nodes escape on render regardless. */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/** The management panel. */
export function HotplugPanel(props: { api: HotplugApi; onClose: () => void }): JSX.Element {
  const { api, onClose } = props
  const [snap, setSnap] = useState<EngineSnapshot | null>(null)
  const [ops, setOps] = useState<OperationInfo[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [view, setView] = useState<View>('entries')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextSnap, nextOps, nextAudit] = await Promise.all([
        api.snapshot(),
        api.operations(),
        api.audit(50),
      ])
      setSnap(nextSnap)
      setOps(nextOps)
      setAudit([...nextAudit].reverse())
    } catch (e) {
      setError(String(e))
    }
  }, [api])

  // Initial load + SSE-driven refresh (snapshot frame on connect, then
  // operation/entry frames; snapshot remains the final-consistency source).
  useEffect(() => {
    void refresh()
    return api.onEvent(() => { void refresh() })
  }, [api, refresh])

  /** Run one mutation, surface its message, then refresh. */
  const act = useCallback(async (label: string, run: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      const result = await run()
      if (!result.ok) setError(result.message)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      await refresh()
    }
  }, [refresh])

  const toggleEntry = useCallback((entry: RuntimeEntry): void => {
    void act(entry.enabled ? '停用' : '启用', () =>
      entry.enabled ? api.disable(entry.entryId) : api.enable(entry.entryId))
  }, [act, api])

  const rollback = useCallback((op: OperationInfo): void => {
    const handle = op.result?.rollbackHandle ?? op.operationId
    void act(`回滚 ${op.operationId}`, () => api.rollback(handle))
  }, [act, api])

  return (
    <div className="hpe-panel">
      <header className="hpe-header">
        <h2 className="hpe-title">热插拔引擎</h2>
        <span className="hpe-mode">模式:{snap?.mode ?? '…'}</span>
        <span className="hpe-profile">{snap?.profile ?? ''}</span>
        <button type="button" className="hpe-close" aria-label="关闭面板" onClick={onClose}>×</button>
      </header>

      <nav className="hpe-tabs">
        {VIEWS.map(v => (
          <button
            key={v.key}
            type="button"
            className="hpe-tab"
            data-active={view === v.key ? 'true' : undefined}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {snap?.auditLag === true && (
        <div className="hpe-warn">审计滞后:某次审计写入失败,审计轨迹可能不完整。</div>
      )}

      {busy !== null && <div className="hpe-busy">操作中:{busy}…</div>}
      {error !== null && <div className="hpe-error">{decodeEntities(error)}</div>}

      <div className="hpe-body">
        {view === 'entries' && (
          <table className="hpe-table">
            <thead>
              <tr><th>entryId</th><th>包名</th><th>来源</th><th>阶段</th><th>托管</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              {snap?.entries.map(entry => (
                <tr key={entry.entryId}>
                  <td className="hpe-mono">{entry.entryId}</td>
                  <td>{entry.moduleName}</td>
                  <td><span className="hpe-badge" data-source={entry.source}>{SOURCE_LABEL[entry.source]}</span></td>
                  <td>{entry.fiberPhase ?? '—'}</td>
                  <td>{entry.managed ? '是' : '—'}</td>
                  <td>{entry.enabled ? '启用' : '停用'}</td>
                  <td>
                    {entry.patchTargetable
                      ? (
                          <button
                            type="button"
                            className="hpe-btn"
                            disabled={busy !== null}
                            onClick={() => toggleEntry(entry)}
                          >
                            {entry.enabled ? '停用' : '启用'}
                          </button>
                        )
                      : <span className="hpe-muted">随机id不可定位</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'packages' && (
          <table className="hpe-table">
            <thead>
              <tr><th>包名</th><th>bundle</th><th>版本</th></tr>
            </thead>
            <tbody>
              {snap?.packages.map(pkg => (
                <tr key={pkg.name}>
                  <td>{pkg.name}</td>
                  <td>{pkg.isBundle ? '是' : '—'}</td>
                  <td className="hpe-mono">{pkg.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'rows' && (
          <table className="hpe-table">
            <thead>
              <tr><th>id</th><th>包名</th><th>托管</th></tr>
            </thead>
            <tbody>
              {snap?.insertRows.map(row => (
                <tr key={row.id}>
                  <td className="hpe-mono">{row.id}</td>
                  <td>{row.name}</td>
                  <td>{row.managed ? '是' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'operations' && (
          <table className="hpe-table">
            <thead>
              <tr><th>operationId</th><th>op</th><th>目标</th><th>状态</th><th>开始</th><th>结束</th><th>操作</th></tr>
            </thead>
            <tbody>
              {[...ops].reverse().map(op => (
                <tr key={op.operationId}>
                  <td className="hpe-mono">{op.operationId}</td>
                  <td>{op.op}</td>
                  <td>{op.target ?? '—'}</td>
                  <td><span className="hpe-badge" data-status={op.status}>{op.status}</span></td>
                  <td className="hpe-mono">{op.startedAt ? op.startedAt.slice(11, 19) : '—'}</td>
                  <td className="hpe-mono">{op.finishedAt ? op.finishedAt.slice(11, 19) : '—'}</td>
                  <td>
                    {op.status === 'succeeded' && op.op !== 'rollback' && op.result?.rollbackHandle !== undefined
                      ? (
                          <button
                            type="button"
                            className="hpe-btn"
                            data-kind="danger"
                            disabled={busy !== null}
                            onClick={() => rollback(op)}
                          >
                            回滚
                          </button>
                        )
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'audit' && (
          <table className="hpe-table">
            <thead>
              <tr><th>时间</th><th>op</th><th>目标</th><th>结果</th><th>模式</th><th>调用方</th><th>错误码</th></tr>
            </thead>
            <tbody>
              {audit.map(record => (
                <tr key={`${record.operationId}-${record.ts}`}>
                  <td className="hpe-mono">{record.ts.slice(0, 19)}</td>
                  <td>{record.op}</td>
                  <td>{record.target ?? '—'}</td>
                  <td><span className="hpe-badge" data-result={record.result}>{record.result}</span></td>
                  <td>{record.mode}</td>
                  <td>{record.caller}</td>
                  <td className="hpe-mono">{record.errorCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="hpe-footer">
        以快照为最终一致源;新客户端 bundle 需刷新页面才加载;bundle 包安装/卸载需重启后生效。
      </footer>
    </div>
  )
}
