/**
 * Hotplug panel (minimal scope, contract §5/§7 + plan T3.4): three list views
 * (entries / packages / insert rows) + operations with rollback + audit.
 * Driven by REST, refreshed by SSE; the snapshot is the final-consistency
 * source. NO marketplace, NO install/spec input (Non-Goal guard — A3.5/A3.8).
 *
 * Display strings are localized (zh/en) via the DSH locale service through
 * the I18n wrapper passed from the client entry.
 *
 * @module dsh-hotplug-engine/client/panels
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { AuditRecord, EngineSnapshot, OperationInfo, RuntimeEntry } from '../contract/types.ts'
import type { HotplugApi } from './api.ts'
import type { I18n } from './i18n.ts'

type View = 'entries' | 'packages' | 'rows' | 'operations' | 'audit'

const VIEWS: { key: View; labelKey: string }[] = [
  { key: 'entries', labelKey: 'tab.entries' },
  { key: 'packages', labelKey: 'tab.packages' },
  { key: 'rows', labelKey: 'tab.rows' },
  { key: 'operations', labelKey: 'tab.operations' },
  { key: 'audit', labelKey: 'tab.audit' },
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
export function HotplugPanel(props: { api: HotplugApi; onClose: () => void; i18n: I18n }): JSX.Element {
  const { api, onClose, i18n } = props
  const t = i18n.t
  // Re-render on locale switch (the locale snapshot reference changes).
  useSyncExternalStore(i18n.subscribe, i18n.getSnapshot)
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
    void act(entry.enabled ? t('action.disable') : t('action.enable'), () =>
      entry.enabled ? api.disable(entry.entryId) : api.enable(entry.entryId))
  }, [act, api, t])

  const rollback = useCallback((op: OperationInfo): void => {
    const handle = op.result?.rollbackHandle ?? op.operationId
    void act(t('action.rollback') + ' ' + op.operationId, () => api.rollback(handle))
  }, [act, api, t])

  return (
    <div className="hpe-panel">
      <header className="hpe-header">
        <h2 className="hpe-title">{t('panel.title')}</h2>
        <span className="hpe-mode">{t('panel.mode', { mode: snap?.mode ?? '…' })}</span>
        <span className="hpe-profile">{snap?.profile ?? ''}</span>
        <button type="button" className="hpe-close" aria-label={t('panel.close')} onClick={onClose}>×</button>
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
            {t(v.labelKey)}
          </button>
        ))}
      </nav>

      {snap?.auditLag === true && (
        <div className="hpe-warn">{t('panel.auditLag')}</div>
      )}

      {busy !== null && <div className="hpe-busy">{t('panel.busy', { label: busy })}</div>}
      {error !== null && <div className="hpe-error">{decodeEntities(error)}</div>}

      <div className="hpe-body">
        {view === 'entries' && (
          <table className="hpe-table">
            <thead>
              <tr><th>{t('th.entryId')}</th><th>{t('th.package')}</th><th>{t('th.source')}</th><th>{t('th.phase')}</th><th>{t('th.managed')}</th><th>{t('th.state')}</th><th>{t('th.actions')}</th></tr>
            </thead>
            <tbody>
              {snap?.entries.map(entry => (
                <tr key={entry.entryId}>
                  <td className="hpe-mono">{entry.entryId}</td>
                  <td>{entry.moduleName}</td>
                  <td><span className="hpe-badge" data-source={entry.source}>{SOURCE_LABEL[entry.source]}</span></td>
                  <td>{entry.fiberPhase ?? t('dash')}</td>
                  <td>{entry.managed ? t('yes') : t('dash')}</td>
                  <td>{entry.enabled ? t('state.enabled') : t('state.disabled')}</td>
                  <td>
                    {entry.patchTargetable
                      ? (
                          <button
                            type="button"
                            className="hpe-btn"
                            disabled={busy !== null}
                            onClick={() => toggleEntry(entry)}
                          >
                            {entry.enabled ? t('action.disable') : t('action.enable')}
                          </button>
                        )
                      : <span className="hpe-muted">{t('entry.notTargetable')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'packages' && (
          <table className="hpe-table">
            <thead>
              <tr><th>{t('th.package')}</th><th>{t('th.bundle')}</th><th>{t('th.version')}</th></tr>
            </thead>
            <tbody>
              {snap?.packages.map(pkg => (
                <tr key={pkg.name}>
                  <td>{pkg.name}</td>
                  <td>{pkg.isBundle ? t('yes') : t('dash')}</td>
                  <td className="hpe-mono">{pkg.version ?? t('dash')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'rows' && (
          <table className="hpe-table">
            <thead>
              <tr><th>{t('th.id')}</th><th>{t('th.package')}</th><th>{t('th.managed')}</th></tr>
            </thead>
            <tbody>
              {snap?.insertRows.map(row => (
                <tr key={row.id}>
                  <td className="hpe-mono">{row.id}</td>
                  <td>{row.name}</td>
                  <td>{row.managed ? t('yes') : t('dash')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'operations' && (
          <table className="hpe-table">
            <thead>
              <tr><th>{t('th.operationId')}</th><th>{t('th.op')}</th><th>{t('th.target')}</th><th>{t('th.status')}</th><th>{t('th.start')}</th><th>{t('th.end')}</th><th>{t('th.actions')}</th></tr>
            </thead>
            <tbody>
              {[...ops].reverse().map(op => (
                <tr key={op.operationId}>
                  <td className="hpe-mono">{op.operationId}</td>
                  <td>{op.op}</td>
                  <td>{op.target ?? t('dash')}</td>
                  <td><span className="hpe-badge" data-status={op.status}>{op.status}</span></td>
                  <td className="hpe-mono">{op.startedAt ? op.startedAt.slice(11, 19) : t('dash')}</td>
                  <td className="hpe-mono">{op.finishedAt ? op.finishedAt.slice(11, 19) : t('dash')}</td>
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
                            {t('action.rollback')}
                          </button>
                        )
                      : t('dash')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'audit' && (
          <table className="hpe-table">
            <thead>
              <tr><th>{t('th.time')}</th><th>{t('th.op')}</th><th>{t('th.target')}</th><th>{t('th.result')}</th><th>{t('th.mode')}</th><th>{t('th.caller')}</th><th>{t('th.errorCode')}</th></tr>
            </thead>
            <tbody>
              {audit.map(record => (
                <tr key={record.operationId + '-' + record.ts}>
                  <td className="hpe-mono">{record.ts.slice(0, 19)}</td>
                  <td>{record.op}</td>
                  <td>{record.target ?? t('dash')}</td>
                  <td><span className="hpe-badge" data-result={record.result}>{record.result}</span></td>
                  <td>{record.mode}</td>
                  <td>{record.caller}</td>
                  <td className="hpe-mono">{record.errorCode ?? t('dash')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="hpe-footer">
        {t('panel.footer')}
      </footer>
    </div>
  )
}
