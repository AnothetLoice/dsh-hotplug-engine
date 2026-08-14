/**
 * Client i18n for the hotplug panel (M7): a thin wrapper over the DSH locale
 * service (dsh-client-locale) so the panel follows the host's zh/en setting
 * instead of hard-coding Simplified Chinese.
 *
 * The locale service is probed (not injected) so the panel still mounts when
 * it is absent — falling back to Simplified Chinese.
 *
 * @module dsh-hotplug-engine/client/i18n
 */

/** Shipped locale ids (mirrors dsh-client-locale LOCALE_IDS). */
export type Lang = 'zh' | 'en'

/** Minimal structural view of the DSH locale service (LocaleRuntime). */
export interface LocaleLike {
  getLocale(): { active: string }
  getSnapshot(): { active: string; revision: number }
  subscribe(fn: () => void): () => void
}

/** Translate surface the panel and sidebar consume. */
export interface I18n {
  /** Translate a key, interpolating {name} placeholders. */
  t(key: string, params?: Record<string, string>): string
  /** Active language ('zh' | 'en'). */
  lang(): Lang
  /** LocaleFace subscribe (re-render on locale switch). */
  subscribe(fn: () => void): () => void
  /** LocaleFace snapshot (stable reference between changes). */
  getSnapshot(): { active: string; revision: number }
}

const zh: Record<string, string> = {
  'panel.title': 'HPE看板',
  'panel.close': '关闭面板',
  'panel.mode': '模式:{mode}',
  'panel.busy': '操作中:{label}…',
  'panel.auditLag': '审计滞后:某次审计写入失败,审计轨迹可能不完整。',
  'panel.footer': '以快照为最终一致源;新客户端 bundle 需刷新页面才加载;bundle 包安装/卸载需重启后生效。',
  'tab.entries': '条目',
  'tab.packages': '包',
  'tab.rows': '插入行',
  'tab.operations': '操作',
  'tab.audit': '审计',
  'source.bundle': 'bundle',
  'source.insert': 'insert',
  'source.user': 'user',
  'yes': '是',
  'dash': '—',
  'state.enabled': '启用',
  'state.disabled': '停用',
  'action.enable': '启用',
  'action.disable': '停用',
  'action.rollback': '回滚',
  'entry.notTargetable': '随机id不可定位',
  'th.entryId': 'entryId',
  'th.package': '包名',
  'th.source': '来源',
  'th.phase': '阶段',
  'th.managed': '托管',
  'th.state': '状态',
  'th.actions': '操作',
  'th.bundle': 'bundle',
  'th.version': '版本',
  'th.id': 'id',
  'th.operationId': 'operationId',
  'th.op': 'op',
  'th.target': '目标',
  'th.status': '状态',
  'th.start': '开始',
  'th.end': '结束',
  'th.time': '时间',
  'th.result': '结果',
  'th.mode': '模式',
  'th.caller': '调用方',
  'th.errorCode': '错误码',
}

const en: Record<string, string> = {
  'panel.title': 'HPE Board',
  'panel.close': 'Close panel',
  'panel.mode': 'Mode: {mode}',
  'panel.busy': 'Working: {label}…',
  'panel.auditLag': 'Audit lag: an audit write failed; the trail may be incomplete.',
  'panel.footer': 'Snapshot is the final consistency source; new client bundles load on page refresh; bundle installs/uninstalls take effect after restart.',
  'tab.entries': 'Entries',
  'tab.packages': 'Packages',
  'tab.rows': 'Insert Rows',
  'tab.operations': 'Operations',
  'tab.audit': 'Audit',
  'source.bundle': 'bundle',
  'source.insert': 'insert',
  'source.user': 'user',
  'yes': 'Yes',
  'dash': '—',
  'state.enabled': 'Enabled',
  'state.disabled': 'Disabled',
  'action.enable': 'Enable',
  'action.disable': 'Disable',
  'action.rollback': 'Rollback',
  'entry.notTargetable': 'random id not targetable',
  'th.entryId': 'entryId',
  'th.package': 'Package',
  'th.source': 'Source',
  'th.phase': 'Phase',
  'th.managed': 'Managed',
  'th.state': 'State',
  'th.actions': 'Actions',
  'th.bundle': 'bundle',
  'th.version': 'Version',
  'th.id': 'id',
  'th.operationId': 'operationId',
  'th.op': 'op',
  'th.target': 'Target',
  'th.status': 'Status',
  'th.start': 'Start',
  'th.end': 'End',
  'th.time': 'Time',
  'th.result': 'Result',
  'th.mode': 'Mode',
  'th.caller': 'Caller',
  'th.errorCode': 'Error Code',
}

const DICTS: Record<Lang, Record<string, string>> = { zh, en }
const FALLBACK_SNAPSHOT = { active: 'zh', revision: 0 }

/** Build the translate surface. Absent locale service → zh fallback. */
export function makeI18n(locale: LocaleLike | undefined): I18n {
  const lang = (): Lang => (locale?.getLocale().active === 'en' ? 'en' : 'zh')
  const t = (key: string, params?: Record<string, string>): string => {
    const l = lang()
    let value = DICTS[l][key] ?? DICTS.zh[key] ?? key
    if (params !== undefined) {
      for (const [name, v] of Object.entries(params)) {
        value = value.replaceAll('{' + name + '}', v)
      }
    }
    return value
  }
  const subscribe = (fn: () => void): () => void => locale?.subscribe(fn) ?? (() => {})
  const getSnapshot = (): { active: string; revision: number } => locale?.getSnapshot() ?? FALLBACK_SNAPSHOT
  return { t, lang, subscribe, getSnapshot }
}
