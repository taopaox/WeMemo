import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ChevronDown,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Wallet,
  X
} from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { useChatStore } from '../stores/chatStore'
import { displayNameOrFallback } from '../utils/displayName'
import './PaymentsPage.scss'

type PaymentKind = 'all' | 'transfer' | 'redpacket'
type TransferState = 'pending' | 'received' | 'returned' | 'expired' | 'unknown'
type PaymentStatusFilter = 'all' | TransferState
type PaymentItem = NonNullable<Awaited<ReturnType<typeof window.electronAPI.payments.list>>['items']>[number]

const PAGE_SIZE = 80
const KIND_OPTIONS: Array<{ value: PaymentKind; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'transfer', label: '转账' },
  { value: 'redpacket', label: '红包' }
]
const STATUS_OPTIONS: Array<{ value: PaymentStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待收款' },
  { value: 'received', label: '已收款' },
  { value: 'returned', label: '已退还' },
  { value: 'expired', label: '已过期' },
  { value: 'unknown', label: '未知状态' }
]
const HB_TYPE_LABELS: Record<number, string> = {
  0: '普通红包',
  1: '拼手气红包',
  2: '普通红包',
  3: '口令红包'
}
const RECEIVE_STATUS_LABELS: Record<number, string> = {
  0: '未领取',
  1: '已领取',
  2: '已过期'
}

function recordKey(item: PaymentItem): string {
  return item.kind === 'transfer'
    ? `transfer-${item.transferId || ''}-${item.messageServerId}`
    : `redpacket-${item.sendId || ''}-${item.messageServerId}`
}

function amountText(item: PaymentItem): string {
  const value = String(item.amountText || item.amount || '').trim()
  if (!value) return ''
  return /^[¥￥]/.test(value) ? value.replace(/^￥/, '¥') : `¥${value}`
}

function amountDisplay(item: PaymentItem): string {
  const amount = amountText(item)
  if (amount) return amount
  if (item.kind === 'redpacket') {
    return item.amountUnavailableReason ? '库中没有金额字段' : '金额未保存'
  }
  return '金额未解析'
}

function transferMemoText(item: PaymentItem): string {
  const value = String(item.transferMemo || '').trim()
  if (!value || value === '微信转账' || value === amountText(item)) return ''
  return value
}

function transferStatusText(item: PaymentItem): string {
  const value = String(item.transferStatus || '').trim()
  if (value && value !== '转账' && value !== '发起转账') return value
  if (item.transferState === 'returned') return '已退还'
  if (item.transferState === 'received') return '已收款'
  if (item.transferState === 'expired') return '已过期'
  if (item.transferState === 'pending') return '待收款'
  if (item.paySubType === 4) return '已退还'
  if (item.paySubType === 3) return '已收款'
  if (item.paySubType === 2 || item.paySubType === 1) return '待收款'
  return '状态未记录'
}

function transferStatusTone(item: PaymentItem): TransferState {
  if (item.transferState) return item.transferState
  if (item.paySubType === 4) return 'returned'
  if (item.paySubType === 3) return 'received'
  if (item.paySubType === 2 || item.paySubType === 1) return 'pending'
  return 'unknown'
}

function recordTimeText(item: PaymentItem): string {
  return String(
    item.beginTransferTimeText
    || item.lastUpdateTimeText
    || item.messageCreateTimeText
    || ''
  ).trim() || '时间未记录'
}

function hbTypeText(value?: number): string {
  if (value === undefined || value === null) return '未记录'
  return HB_TYPE_LABELS[value] || String(value)
}

function receiveStatusText(value?: number): string {
  if (value === undefined || value === null) return '未记录'
  return RECEIVE_STATUS_LABELS[value] || String(value)
}

function PaymentsPage() {
  const navigate = useNavigate()
  const setCurrentSession = useChatStore(state => state.setCurrentSession)
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [kind, setKind] = useState<PaymentKind>('all')
  const [status, setStatus] = useState<PaymentStatusFilter>('all')
  const [items, setItems] = useState<PaymentItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [stats, setStats] = useState({ transferCount: 0, redPacketCount: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')
  const requestIdRef = useRef(0)
  const keywordTimerRef = useRef<number | null>(null)
  const itemsLengthRef = useRef(0)

  useEffect(() => {
    itemsLengthRef.current = items.length
  }, [items.length])

  useEffect(() => {
    if (keywordTimerRef.current) window.clearTimeout(keywordTimerRef.current)
    keywordTimerRef.current = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 250)
    return () => {
      if (keywordTimerRef.current) window.clearTimeout(keywordTimerRef.current)
    }
  }, [keyword])

  const loadItems = useCallback(async (options: { append?: boolean } = {}) => {
    const append = !!options.append
    const requestId = ++requestIdRef.current
    setLoading(true)
    if (!append) setError('')
    try {
      const result = await window.electronAPI.payments.list({
        q: debouncedKeyword,
        kind,
        status,
        limit: PAGE_SIZE,
        offset: append ? itemsLengthRef.current : 0
      })
      if (requestId !== requestIdRef.current) return
      if (!result.success) {
        if (!append) {
          setItems([])
          setTotal(0)
          setHasMore(false)
        }
        setError(result.error || '加载转账与红包数据失败')
        return
      }
      const next = Array.isArray(result.items) ? result.items : []
      setItems(append ? (prev) => [...prev, ...next] : next)
      setTotal(Number(result.total || 0))
      setHasMore(!!result.hasMore)
      setStats({
        transferCount: Number(result.stats?.transferCount || 0),
        redPacketCount: Number(result.stats?.redPacketCount || 0)
      })
    } catch (loadError) {
      if (requestId === requestIdRef.current && !append) {
        setItems([])
        setError(String(loadError))
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [debouncedKeyword, kind, status])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const selectKind = (value: PaymentKind) => {
    setKind(value)
    if (value === 'redpacket') setStatus('all')
  }

  const selectStatus = (value: PaymentStatusFilter) => {
    setStatus(value)
    if (value !== 'all' && kind !== 'transfer') setKind('transfer')
  }

  const openChat = (item: PaymentItem) => {
    const username = String(item.sessionName || item.senderUserName || '').trim()
    if (!username) return
    setCurrentSession(username)
    navigate('/chat')
  }

  const handleExport = async (format: 'json' | 'csv') => {
    try {
      setExporting(true)
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const separator = downloadsPath && downloadsPath.includes('\\') ? '\\' : '/'
      const suggestedName = `wechat_payments_${Date.now()}.${format}`
      const defaultPath = downloadsPath ? `${downloadsPath}${separator}${suggestedName}` : suggestedName
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: format === 'csv' ? '导出转账与红包 CSV' : '导出转账与红包 JSON',
        defaultPath,
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
      })
      if (saveResult.canceled || !saveResult.filePath) return
      const result = await window.electronAPI.payments.export({
        filePath: saveResult.filePath,
        format,
        q: debouncedKeyword,
        kind,
        status
      })
      if (!result.success) {
        setMessage(result.error || '导出失败')
        window.setTimeout(() => setMessage(''), 2200)
        return
      }
      setMessage('已导出')
      window.setTimeout(() => setMessage(''), 1800)
    } catch (exportError) {
      setMessage(String(exportError))
      window.setTimeout(() => setMessage(''), 2200)
    } finally {
      setExporting(false)
    }
  }

  const titleCount = useMemo(() => total.toLocaleString(), [total])

  return (
    <div className="payments-page">
      <header className="payments-header">
        <div className="payments-title-block">
          <div className="payments-title-line">
            <Wallet size={22} />
            <h2>转账与红包</h2>
          </div>
          <div className="payments-stats-line">
            <span>共 {titleCount} 笔记录</span>
            <span>转账 {stats.transferCount.toLocaleString()}</span>
            <span>红包 {stats.redPacketCount.toLocaleString()}</span>
          </div>
        </div>
        <div className="payments-header-actions">
          <label className="payments-search">
            <Search size={15} />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索会话、付款方或收款方"
            />
            {keyword ? (
              <button type="button" onClick={() => setKeyword('')} aria-label="清空搜索">
                <X size={14} />
              </button>
            ) : null}
          </label>
          <button className="payments-icon-btn" title="导出 CSV" disabled={exporting} onClick={() => { void handleExport('csv') }}>
            <Download size={16} />
          </button>
          <button className="payments-icon-btn" title="刷新" disabled={loading} onClick={() => { void loadItems() }}>
            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </header>

      <div className="payments-toolbar">
        <div className="payments-kind-tabs">
          {KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={kind === option.value ? 'active' : ''}
              onClick={() => selectKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className={`payments-status-filter ${kind === 'redpacket' ? 'is-disabled' : ''}`}>
          <select
            value={status}
            disabled={kind === 'redpacket'}
            onChange={(event) => selectStatus(event.target.value as PaymentStatusFilter)}
            aria-label="按转账状态筛选"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      {message ? <div className="payments-toast">{message}</div> : null}

      <section className="payments-body">
        {loading && items.length === 0 ? (
          <div className="payments-state">
            <Loader2 size={22} className="spinning" />
            <strong>正在加载转账记录</strong>
            <span>请稍候</span>
          </div>
        ) : error ? (
          <div className="payments-state">
            <strong>加载失败</strong>
            <span>{error}</span>
            <button type="button" onClick={() => { void loadItems() }}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className="payments-state">
            <Wallet size={36} />
            <strong>暂无转账记录</strong>
            <span>当前账号下没有匹配的转账或红包数据</span>
          </div>
        ) : (
          <div className="payments-ledger">
            {items.map((item) => {
              const title = displayNameOrFallback(
                item.kind === 'transfer' ? '未知会话' : '未知红包会话',
                item.sessionContact?.displayName,
                item.sessionName,
                item.senderUserName
              )
              const canOpen = Boolean(item.sessionName || item.senderUserName)
              const parsedAmount = Boolean(amountText(item))
              return (
                <article
                  key={recordKey(item)}
                  className={`payments-row ${canOpen ? '' : 'is-disabled'}`}
                  onClick={() => openChat(item)}
                >
                  <Avatar
                    src={item.sessionContact?.avatarUrl}
                    name={title}
                    size={44}
                    shape="rounded"
                  />
                  <div className="payments-row-content">
                    <div className="payments-row-head">
                      <div className="payments-row-title">{title}</div>
                      {item.kind === 'transfer' ? (
                        <span className={`payments-status payments-status--${transferStatusTone(item)}`}>
                          {transferStatusText(item)}
                        </span>
                      ) : (
                        <span className="payments-status payments-status--redpacket">红包</span>
                      )}
                    </div>
                    {item.kind === 'transfer' ? (
                      <div className="payments-route">
                        <span>付款人 {item.payerContact?.displayName || item.payPayer || '未知付款方'}</span>
                        <ArrowRight size={12} />
                        <span>收款人 {item.receiverContact?.displayName || item.payReceiver || '未知收款方'}</span>
                      </div>
                    ) : (
                      <div className="payments-route">
                        <span>发送 {item.senderContact?.displayName || item.senderUserName || '未知发送人'}</span>
                      </div>
                    )}
                    <div className="payments-meta">
                      <span>{recordTimeText(item)}</span>
                      {transferMemoText(item) ? <span>{transferMemoText(item)}</span> : null}
                      {item.kind === 'redpacket' ? (
                        <>
                          <span>类型 {hbTypeText(item.hbType)}</span>
                          <span>领取 {receiveStatusText(item.receiveStatus)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className={`payments-amount ${item.kind === 'redpacket' && parsedAmount ? 'is-red' : ''} ${parsedAmount ? '' : 'is-muted'}`}>
                    {amountDisplay(item)}
                  </div>
                  {canOpen ? <ChevronDown className="payments-row-arrow" size={16} /> : null}
                </article>
              )
            })}
            {hasMore ? (
              <button
                type="button"
                className="payments-more"
                disabled={loading}
                onClick={() => { void loadItems({ append: true }) }}
              >
                {loading ? '正在载入' : `继续载入 ${items.length} / ${total}`}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

export default PaymentsPage
