import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as fzstd from 'fzstd'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

export type PaymentKind = 'all' | 'transfer' | 'redpacket'
export type TransferState = 'pending' | 'received' | 'returned' | 'expired' | 'unknown'
export type PaymentStatusFilter = 'all' | TransferState

export interface PaymentContact {
  username: string
  displayName: string
  avatarUrl?: string
  isGroup?: boolean
}

export interface PaymentRecord {
  kind: 'transfer' | 'redpacket'
  transferId?: string
  transactionId?: string
  sendId?: string
  messageServerId: number
  messageServerIdRaw?: string
  secondMessageServerId?: number
  secondMessageServerIdRaw?: string
  sessionName: string
  sessionContact?: PaymentContact
  paySubType?: number
  payPayer?: string
  payReceiver?: string
  payerContact?: PaymentContact
  receiverContact?: PaymentContact
  senderUserName?: string
  senderContact?: PaymentContact
  beginTransferTime?: number
  beginTransferTimeText?: string
  invalidTime?: number
  lastUpdateTime?: number
  lastUpdateTimeText?: string
  transferState?: TransferState
  transferStatus?: string
  transferMemo?: string
  amount?: string
  amountText?: string
  amountUnavailableReason?: string
  hbType?: number
  hbStatus?: number
  receiveStatus?: number
  sceneId?: number
  nativeUrl?: string
  sortTime: number
  messageCreateTime?: number
  messageCreateTimeText?: string
  messageSummary?: string
}

export interface PaymentListQuery {
  q?: string
  kind?: PaymentKind
  status?: PaymentStatusFilter
  limit?: number
  offset?: number
}

export interface PaymentListResult {
  success: boolean
  items?: PaymentRecord[]
  total?: number
  hasMore?: boolean
  stats?: {
    transferCount: number
    redPacketCount: number
    transferSessions: number
    redPacketSessions: number
  }
  error?: string
}

export interface PaymentExportQuery extends PaymentListQuery {
  filePath: string
  format: 'json' | 'csv'
}

const PAGE_SIZE = 80
const MAX_LIMIT = 500
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

function text(value: unknown, maxLen = 0): string {
  const next = String(value ?? '').trim()
  if (!next) return ''
  if (maxLen > 0 && next.length > maxLen) return next.slice(0, maxLen)
  return next
}

function safeInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function quoteIdent(name: string): string {
  const next = String(name || '').trim()
  if (!next) return ''
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(next)) return next
  return `"${next.replace(/"/g, '""')}"`
}

function looksLikeHex(value: string): boolean {
  const compact = String(value || '').replace(/\s+/g, '')
  return compact.length > 16 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)
}

function looksLikeRawId(value: string): boolean {
  const next = text(value)
  return !!(next.startsWith('wxid_') || next.endsWith('@chatroom') || /^\d{5,}@chatroom$/i.test(next))
}

function formatTimeText(ts: unknown): string {
  const seconds = safeInt(ts, 0)
  if (seconds <= 0) return ''
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAmountText(value: unknown): string {
  const next = text(value).replace(/￥/g, '¥')
  if (!next) return ''
  return next
}

function extractXmlTag(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(xml || '')
  if (!match) return ''
  return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
}

function rowText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      const next = text(row[key])
      if (next) return next
    }
    const lower = key.toLowerCase()
    for (const actual of Object.keys(row)) {
      if (actual.toLowerCase() === lower) {
        const next = text(row[actual])
        if (next) return next
      }
    }
  }
  return ''
}

function rowRaw(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidates = [row[key], ...Object.entries(row)
      .filter(([actual]) => actual.toLowerCase() === key.toLowerCase())
      .map(([, value]) => value)]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
    }
  }
  return ''
}

function collectSearchBlob(item: PaymentRecord): string {
  const parts = [
    item.transferId,
    item.transactionId,
    item.sessionName,
    item.payPayer,
    item.payReceiver,
    item.senderUserName,
    item.sendId,
    item.nativeUrl,
    item.transferMemo,
    item.amountText,
    item.sessionContact?.displayName,
    item.payerContact?.displayName,
    item.receiverContact?.displayName,
    item.senderContact?.displayName
  ]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

export function inferTransferTableState(item: {
  paySubType?: number
  invalidTime?: number
}, nowTs = Math.floor(Date.now() / 1000)): { state: TransferState; label: string } {
  const paySubType = safeInt(item.paySubType, 0)
  if (paySubType === 4) return { state: 'returned', label: '已退还' }
  if (paySubType === 3) return { state: 'received', label: '已收款' }
  if (paySubType === 2 || paySubType === 1 || paySubType === 8) {
    const invalidTime = safeInt(item.invalidTime, 0)
    if (invalidTime > 0 && invalidTime <= nowTs) return { state: 'expired', label: '已过期' }
    return { state: 'pending', label: '待收款' }
  }
  if (paySubType === 9) return { state: 'returned', label: '已被退还' }
  if (paySubType === 10) return { state: 'expired', label: '已过期' }
  return { state: 'unknown', label: '状态未记录' }
}

function hbTypeLabel(value?: number): string {
  const num = safeInt(value, -1)
  if (num < 0) return '未记录'
  return HB_TYPE_LABELS[num] || String(num)
}

export function receiveStatusLabel(value?: number): string {
  const num = safeInt(value, -1)
  if (num < 0) return '未记录'
  return RECEIVE_STATUS_LABELS[num] || String(num)
}

class PaymentService {
  private configService = ConfigService.getInstance()

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    return chatService.connect()
  }

  private resolveGeneralDbPath(): string {
    const wxid = String(this.configService.get('myWxid') || '').trim()
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const accountDir = this.configService.getAccountDir(dbPath, wxid)
    if (!accountDir) return ''
    const candidates = [
      join(accountDir, 'db_storage', 'general', 'general.db'),
      join(accountDir, 'db_storage', 'General', 'general.db'),
      join(accountDir, 'db_storage', 'general.db'),
      join(accountDir, 'general', 'general.db'),
      join(accountDir, 'general.db')
    ]
    return candidates.find((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    }) || ''
  }

  private async queryGeneral(sql: string): Promise<{ success: boolean; rows?: any[]; error?: string; dbPath?: string; kind?: string }> {
    const dbPath = this.resolveGeneralDbPath()
    if (!dbPath) {
      return { success: false, error: '未找到 general.db，当前账号可能没有转账/红包数据' }
    }
    // 原生层没有独立 general kind；WeChatDataAnalysis 用 kind=message + 绝对路径打开任意 db_storage 库。
    const kinds = ['message', 'general']
    let lastError = ''
    for (const kind of kinds) {
      const result = await wcdbService.execQuery(kind, dbPath, sql)
      if (result.success && Array.isArray(result.rows)) {
        return { success: true, rows: result.rows, dbPath, kind }
      }
      lastError = result.error || `查询失败 (${kind})`
    }
    return { success: false, error: lastError || '读取 general.db 失败', dbPath }
  }

  private async resolveTableMap(): Promise<{ transfer?: string; redpacket?: string; error?: string }> {
    const result = await this.queryGeneral("SELECT name FROM sqlite_master WHERE type='table'")
    if (!result.success || !Array.isArray(result.rows)) {
      return { error: result.error || '无法读取 general.db 表列表' }
    }
    const names = result.rows
      .map((row) => text(row?.name || row?.NAME || row?.Name))
      .filter(Boolean)
    const lower = new Map(names.map((name) => [name.toLowerCase(), name]))
    const transfer = lower.get('transfertable')
    const redpacket = lower.get('redenvelopetable')
    console.log('[PaymentService] general.db tables=', names.join(','), 'kind=', result.kind, 'path=', result.dbPath)
    if (!transfer && !redpacket) {
      return { error: `general.db 未打开到转账/红包表（实际表: ${names.slice(0, 12).join(',') || '空'}）` }
    }
    return { transfer, redpacket }
  }

  private decodeBinaryContent(raw: string): string {
    if (!raw) return ''
    if (raw.includes('<') || raw.includes('转账') || raw.includes('红包')) return raw
    if (!looksLikeHex(raw)) return raw
    try {
      const bytes = Buffer.from(raw.replace(/\s+/g, ''), 'hex')
      if (bytes.length >= 4) {
        const magic = bytes.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          return Buffer.from(fzstd.decompress(bytes)).toString('utf-8')
        }
      }
      const decoded = bytes.toString('utf-8')
      if (decoded.includes('<')) return decoded
    } catch {
      return raw
    }
    return raw
  }

  private decodeRowContent(row: Record<string, unknown>): string {
    const compress = rowText(row, ['compress_content', 'compressContent'])
    const message = rowText(row, ['message_content', 'messageContent', 'content'])
    return this.decodeBinaryContent(compress) || this.decodeBinaryContent(message)
  }

  private parsePaymentXml(xml: string): {
    amount: string
    memo: string
    paySubType: string
    receiveStatus: string
    senderTitle: string
    receiverTitle: string
    transferId: string
    invalidTime: string
    renderType: 'transfer' | 'redpacket' | ''
  } {
    const probe = xml || ''
    const appType = extractXmlTag(probe, 'type')
    const feedesc = formatAmountText(extractXmlTag(probe, 'feedesc'))
    const payMemo = extractXmlTag(probe, 'pay_memo')
    const lower = probe.toLowerCase()
    const isTransfer = appType === '2000' || lower.includes('paysubtype') || lower.includes('transferid')
    const isRedPacket = appType === '2001' || appType === '2003' || lower.includes('hongbao') || lower.includes('redenvelope')
    return {
      amount: feedesc,
      memo: payMemo,
      paySubType: extractXmlTag(probe, 'paysubtype'),
      receiveStatus: extractXmlTag(probe, 'receivestatus'),
      senderTitle: extractXmlTag(probe, 'sendertitle'),
      receiverTitle: extractXmlTag(probe, 'receivertitle'),
      transferId: extractXmlTag(probe, 'transferid'),
      invalidTime: extractXmlTag(probe, 'invalidtime'),
      renderType: isTransfer ? 'transfer' : (isRedPacket ? 'redpacket' : '')
    }
  }

  private inferStatusFromXml(parsed: ReturnType<PaymentService['parsePaymentXml']>, isSent = false): string {
    const rs = parsed.receiveStatus
    const t = parsed.paySubType
    if (rs === '1') return isSent ? '已被接收' : '已收款'
    if (rs === '2') return '已退还'
    if (rs === '3') return '已过期'
    if (t === '4') return '已退还'
    if (t === '9') return '已被退还'
    if (t === '10') return '已过期'
    if (t === '8') return '发起转账'
    if (t === '3') return isSent ? '已被接收' : '已收款'
    if (t === '1' || t === '2') return '转账'
    return parsed.senderTitle || parsed.receiverTitle || ''
  }

  private async hydrateMessages(items: PaymentRecord[]): Promise<void> {
    const nowTs = Math.floor(Date.now() / 1000)
    const tasks: Array<{ item: PaymentRecord; serverId: string; role: 'initial' | 'status' }> = []
    for (const item of items) {
      if (!item.sessionName) continue
      if (item.kind === 'transfer') {
        const firstId = item.messageServerIdRaw || (item.messageServerId > 0 ? String(item.messageServerId) : '')
        const secondId = item.secondMessageServerIdRaw || (safeInt(item.secondMessageServerId, 0) > 0 ? String(item.secondMessageServerId) : '')
        if (firstId) tasks.push({ item, serverId: firstId, role: 'initial' })
        if (secondId) tasks.push({ item, serverId: secondId, role: 'status' })
      } else {
        const firstId = item.messageServerIdRaw || (item.messageServerId > 0 ? String(item.messageServerId) : '')
        if (firstId) tasks.push({ item, serverId: firstId, role: 'initial' })
      }
    }

    const chunkSize = 8
    for (let i = 0; i < tasks.length; i += chunkSize) {
      const chunk = tasks.slice(i, i + chunkSize)
      const results = await Promise.allSettled(
        chunk.map((task) => wcdbService.getMessageByServerId(task.item.sessionName, task.serverId))
      )
      for (let index = 0; index < chunk.length; index += 1) {
        const task = chunk[index]
        const settled = results[index]
        const row = settled.status === 'fulfilled' && settled.value.success
          ? (settled.value.row as Record<string, unknown> | undefined)
          : undefined
        if (!row) {
          if (task.item.kind === 'redpacket' && task.role === 'initial' && !task.item.amount) {
            task.item.amountUnavailableReason = '红包金额未保存在 redEnvelopeTable 中，且未找到对应消息。'
          }
          continue
        }
        const xml = this.decodeRowContent(row)
        const parsed = this.parsePaymentXml(xml)
        const createTime = safeInt(row.create_time ?? row.createTime, 0)
        if (task.role === 'initial') {
          if (createTime > 0) {
            task.item.messageCreateTime = createTime
            task.item.messageCreateTimeText = formatTimeText(createTime)
            if (task.item.kind === 'redpacket') task.item.sortTime = createTime
          }
          if (parsed.amount && !task.item.amount) {
            task.item.amount = parsed.amount
            task.item.amountText = parsed.amount.startsWith('¥') ? parsed.amount : `¥${parsed.amount}`
          } else if (task.item.kind === 'redpacket' && !task.item.amount) {
            task.item.amountUnavailableReason = '红包金额未保存在 redEnvelopeTable/消息 XML 中。'
          }
          if (parsed.memo && parsed.memo !== '微信转账') task.item.transferMemo = parsed.memo
          const summary = parsed.memo || parsed.senderTitle || parsed.receiverTitle || parsed.amount
          if (summary) task.item.messageSummary = summary
        }
        const statusText = this.inferStatusFromXml(parsed)
        if (statusText) {
          if (task.role === 'status' || !task.item.transferStatus || task.item.transferStatus === '待收款' || task.item.transferStatus === '转账') {
            task.item.transferStatus = statusText
          }
        }
        if (task.item.kind === 'transfer') {
          const { state, label } = inferTransferTableState(task.item, nowTs)
          task.item.transferState = state
          if (!task.item.transferStatus || task.item.transferStatus === '状态未记录') {
            task.item.transferStatus = label
          }
          const combined = `${task.item.transferStatus || ''} ${statusText}`
          if (safeInt(task.item.paySubType, 0) === 4 || combined.includes('退')) {
            task.item.transferState = 'returned'
            task.item.transferStatus = statusText.includes('退') ? statusText : '已退还'
          } else if (safeInt(task.item.paySubType, 0) === 3 || combined.includes('收款') || combined.includes('接收')) {
            task.item.transferState = 'received'
            task.item.transferStatus = statusText.includes('收款') || statusText.includes('接收') ? statusText : '已收款'
          }
        }
      }
    }
  }

  private async attachContacts(items: PaymentRecord[]): Promise<void> {
    const usernames: string[] = []
    for (const item of items) {
      usernames.push(item.sessionName, item.payPayer || '', item.payReceiver || '', item.senderUserName || '')
    }
    const unique = Array.from(new Set(usernames.map((name) => text(name)).filter(Boolean)))
    if (unique.length === 0) return
    const enrichment = await chatService.enrichSessionsContactInfo(unique)
    const map = enrichment.success && enrichment.contacts ? enrichment.contacts : {}
    const myWxid = this.configService.getMyWxidCleaned() || ''

    const toContact = (username?: string): PaymentContact | undefined => {
      const id = text(username)
      if (!id) return undefined
      const info = map[id] || {}
      const isSelf = !!myWxid && (id === myWxid || id.toLowerCase() === myWxid.toLowerCase())
      const displayName = !looksLikeRawId(text(info.displayName)) && text(info.displayName)
        ? text(info.displayName)
        : (isSelf ? '我' : (id.endsWith('@chatroom') ? '未知群聊' : id))
      return {
        username: id,
        displayName,
        avatarUrl: text(info.avatarUrl) || undefined,
        isGroup: id.endsWith('@chatroom')
      }
    }

    for (const item of items) {
      item.sessionContact = toContact(item.sessionName)
      if (item.kind === 'transfer') {
        item.payerContact = toContact(item.payPayer)
        item.receiverContact = toContact(item.payReceiver)
      } else {
        item.senderContact = toContact(item.senderUserName)
      }
    }
  }

  private paymentRecordFromMessageRow(row: Record<string, unknown>, sessionName: string, nowTs: number): PaymentRecord | null {
    const localType = safeInt(rowText(row, ['local_type', 'localType', 'WCDB_CT_local_type']), 0)
    const xml = this.decodeRowContent(row)
    const parsed = this.parsePaymentXml(xml)
    const packedTransfer = localType === 8589934592049
    const packedRed = localType === 8594229559345
    const kind: PaymentRecord['kind'] | '' = packedTransfer || parsed.renderType === 'transfer'
      ? 'transfer'
      : (packedRed || parsed.renderType === 'redpacket' ? 'redpacket' : '')
    if (!kind) return null

    const createTime = safeInt(rowText(row, ['create_time', 'createTime']), 0)
    const serverIdRaw = rowRaw(row, ['server_id', 'serverId'])
    const amount = parsed.amount
    const amountTextValue = amount ? (/^[¥￥]/.test(amount) ? amount.replace(/^￥/, '¥') : `¥${amount}`) : ''
    const paySubType = safeInt(parsed.paySubType, 0)
    const inferred = inferTransferTableState({
      paySubType,
      invalidTime: safeInt(parsed.invalidTime, 0)
    }, nowTs)
    const sender = rowText(row, ['sender_username', 'senderUsername'])
    return {
      kind,
      transferId: parsed.transferId || undefined,
      sendId: parsed.transferId || undefined,
      messageServerId: safeInt(serverIdRaw, 0),
      messageServerIdRaw: serverIdRaw,
      sessionName,
      paySubType: kind === 'transfer' ? paySubType : undefined,
      payPayer: extractXmlTag(xml, 'payer_username') || undefined,
      payReceiver: extractXmlTag(xml, 'receiver_username') || undefined,
      senderUserName: sender || extractXmlTag(xml, 'fromusername') || undefined,
      beginTransferTime: createTime,
      beginTransferTimeText: formatTimeText(createTime),
      invalidTime: safeInt(parsed.invalidTime, 0) || undefined,
      transferState: kind === 'transfer' ? inferred.state : undefined,
      transferStatus: kind === 'transfer'
        ? (this.inferStatusFromXml(parsed) || inferred.label)
        : undefined,
      transferMemo: parsed.memo && parsed.memo !== '微信转账' ? parsed.memo : undefined,
      amount: amount || undefined,
      amountText: amountTextValue || undefined,
      receiveStatus: safeInt(parsed.receiveStatus, -1) >= 0 ? safeInt(parsed.receiveStatus, 0) : undefined,
      sortTime: createTime,
      messageCreateTime: createTime,
      messageCreateTimeText: formatTimeText(createTime),
      messageSummary: parsed.memo || parsed.senderTitle || parsed.receiverTitle || amountTextValue
    }
  }

  private sessionIdFromRow(session: Record<string, unknown>): string {
    return text(
      session.username
      || session.userName
      || session.user_name
      || session.sessionId
      || session.session_id
    )
  }

  private async collectSessionPaymentRows(
    sessionId: string,
    localTypes: number[],
    kind: PaymentKind,
    nowTs: number
  ): Promise<PaymentRecord[]> {
    const collected: PaymentRecord[] = []
    const results = await Promise.all(
      localTypes.map((localType) => wcdbService.getMessagesByType(sessionId, localType, false, 0, 0))
    )
    for (const result of results) {
      if (!result.success || !Array.isArray(result.rows)) continue
      for (const raw of result.rows) {
        const record = this.paymentRecordFromMessageRow(raw as Record<string, unknown>, sessionId, nowTs)
        if (!record) continue
        if (kind !== 'all' && record.kind !== kind) continue
        collected.push(record)
      }
    }
    return collected
  }

  private async loadFromMessages(kind: PaymentKind): Promise<{ items: PaymentRecord[]; stats: NonNullable<PaymentListResult['stats']>; error?: string }> {
    const stats = { transferCount: 0, redPacketCount: 0, transferSessions: 0, redPacketSessions: 0 }
    const items: PaymentRecord[] = []
    const nowTs = Math.floor(Date.now() / 1000)
    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
      return { items, stats, error: sessionsResult.error || '获取会话列表失败' }
    }
    const sessionIds = Array.from(new Set(
      sessionsResult.sessions
        .map((session: any) => this.sessionIdFromRow(session as Record<string, unknown>))
        .filter(Boolean)
    ))
    if (sessionIds.length === 0) return { items, stats }

    const statsBatch = await wcdbService.getSessionMessageTypeStatsBatch(sessionIds, { quickMode: true })
    const statsMap = statsBatch.success && statsBatch.data ? statsBatch.data : {}
    const wantTransfer = kind === 'all' || kind === 'transfer'
    const wantRed = kind === 'all' || kind === 'redpacket'
    const hinted = sessionIds.filter((sessionId) => {
      const row = statsMap[sessionId] || {}
      const transferCount = safeInt(row.transfer_messages ?? row.transferMessages, 0)
      const redCount = safeInt(row.red_packet_messages ?? row.redPacketMessages, 0)
      return (wantTransfer && transferCount > 0) || (wantRed && redCount > 0)
    })
    const targets = hinted.length > 0 ? hinted : sessionIds

    const packedTypes: number[] = []
    if (wantTransfer) packedTypes.push(8589934592049)
    if (wantRed) packedTypes.push(8594229559345)

    const hitSessions = new Set<string>()
    const chunkSize = 8
    for (let i = 0; i < targets.length; i += chunkSize) {
      const chunk = targets.slice(i, i + chunkSize)
      const chunkRows = await Promise.all(chunk.map(async (sessionId) => {
        const rows = await this.collectSessionPaymentRows(sessionId, packedTypes, kind, nowTs)
        if (rows.length > 0) hitSessions.add(sessionId)
        return rows
      }))
      for (const rows of chunkRows) items.push(...rows)
    }

    const type49Targets = hinted.length > 0
      ? targets.filter((sessionId) => !hitSessions.has(sessionId))
      : (items.length > 0 ? [] : targets.filter((sessionId) => !hitSessions.has(sessionId)))
    for (let i = 0; i < type49Targets.length; i += chunkSize) {
      const chunk = type49Targets.slice(i, i + chunkSize)
      const chunkRows = await Promise.all(chunk.map((sessionId) => (
        this.collectSessionPaymentRows(sessionId, [49], kind, nowTs)
      )))
      for (const rows of chunkRows) items.push(...rows)
    }

    const dedup = new Map<string, PaymentRecord>()
    for (const item of items) {
      const key = `${item.kind}:${item.sessionName}:${item.transferId || item.sendId || item.messageServerIdRaw || item.messageServerId}:${item.sortTime}`
      if (!dedup.has(key)) dedup.set(key, item)
    }
    const unique = Array.from(dedup.values())
    stats.transferCount = unique.filter((item) => item.kind === 'transfer').length
    stats.redPacketCount = unique.filter((item) => item.kind === 'redpacket').length
    stats.transferSessions = new Set(unique.filter((item) => item.kind === 'transfer').map((item) => item.sessionName)).size
    stats.redPacketSessions = new Set(unique.filter((item) => item.kind === 'redpacket').map((item) => item.sessionName)).size
    console.log('[PaymentService] message fallback sessions=', targets.length, 'packedHits=', hitSessions.size, 'items=', unique.length, 'transfers=', stats.transferCount, 'redpackets=', stats.redPacketCount)
    return { items: unique, stats }
  }

  private async queryFirstTable(sqlTemplate: string, tableNames: string[]): Promise<{ success: boolean; rows?: any[]; error?: string; table?: string }> {
    const names = Array.from(new Set(tableNames.map((name) => text(name)).filter(Boolean)))
    let lastError = ''
    for (const tableName of names) {
      const ident = quoteIdent(tableName)
      if (!ident) continue
      const result = await this.queryGeneral(sqlTemplate.replaceAll('__TABLE__', ident))
      if (result.success && Array.isArray(result.rows)) {
        return { success: true, rows: result.rows, table: tableName }
      }
      lastError = result.error || `查询 ${tableName} 失败`
    }
    return { success: false, error: lastError || '未找到可用表' }
  }

  private async loadRawItems(kind: PaymentKind): Promise<{ items: PaymentRecord[]; stats: NonNullable<PaymentListResult['stats']>; error?: string }> {
    const stats = { transferCount: 0, redPacketCount: 0, transferSessions: 0, redPacketSessions: 0 }
    const items: PaymentRecord[] = []
    const nowTs = Math.floor(Date.now() / 1000)

    const tableMap = await this.resolveTableMap()
    const transferTable = tableMap.transfer
    const redTable = tableMap.redpacket
    console.log('[PaymentService] general.db path=', this.resolveGeneralDbPath(), 'transferTable=', transferTable, 'redTable=', redTable, 'error=', tableMap.error)

    if (kind === 'all' || kind === 'transfer') {
      const result = await this.queryFirstTable(
        `SELECT transfer_id, transcation_id, message_server_id, second_message_server_id,
                session_name, pay_sub_type, pay_receiver, pay_payer, begin_transfer_time,
                last_modified_time, invalid_time, last_update_time
         FROM __TABLE__`,
        [transferTable || '', 'transferTable', 'transfertable']
      )
      if (result.success) {
        const sessions = new Set<string>()
        for (const row of result.rows || []) {
          const record = row as Record<string, unknown>
          const sessionName = rowText(record, ['session_name', 'sessionName'])
          const beginTransferTime = safeInt(rowText(record, ['begin_transfer_time', 'beginTransferTime']), 0)
          const paySubType = safeInt(rowText(record, ['pay_sub_type', 'paySubType']), 0)
          const invalidTime = safeInt(rowText(record, ['invalid_time', 'invalidTime']), 0)
          const inferred = inferTransferTableState({ paySubType, invalidTime }, nowTs)
          const messageServerIdRaw = rowRaw(record, ['message_server_id', 'messageServerId'])
          const secondMessageServerIdRaw = rowRaw(record, ['second_message_server_id', 'secondMessageServerId'])
          if (sessionName) sessions.add(sessionName)
          items.push({
            kind: 'transfer',
            transferId: rowText(record, ['transfer_id', 'transferId']),
            transactionId: rowText(record, ['transcation_id', 'transaction_id', 'transactionId']),
            messageServerId: safeInt(messageServerIdRaw, 0),
            messageServerIdRaw,
            secondMessageServerId: safeInt(secondMessageServerIdRaw, 0),
            secondMessageServerIdRaw,
            sessionName,
            paySubType,
            payReceiver: rowText(record, ['pay_receiver', 'payReceiver']),
            payPayer: rowText(record, ['pay_payer', 'payPayer']),
            beginTransferTime,
            beginTransferTimeText: formatTimeText(beginTransferTime),
            invalidTime,
            lastUpdateTime: safeInt(rowText(record, ['last_update_time', 'lastUpdateTime']), 0),
            lastUpdateTimeText: formatTimeText(rowText(record, ['last_update_time', 'lastUpdateTime'])),
            transferState: inferred.state,
            transferStatus: inferred.label,
            sortTime: beginTransferTime
          })
        }
        stats.transferCount = items.filter((item) => item.kind === 'transfer').length
        stats.transferSessions = sessions.size
      } else if (kind === 'transfer') {
        console.warn('[PaymentService] transferTable query failed:', result.error)
      }
    }

    if (kind === 'all' || kind === 'redpacket') {
      const result = await this.queryFirstTable(
        `SELECT message_server_id, session_name, sender_user_name, native_url, send_id,
                scene_id, hb_status, hb_type, receive_status
         FROM __TABLE__`,
        [redTable || '', 'redEnvelopeTable', 'redenvelopetable']
      )
      if (result.success) {
        const sessions = new Set<string>()
        for (const row of result.rows || []) {
          const record = row as Record<string, unknown>
          const sessionName = rowText(record, ['session_name', 'sessionName'])
          const messageServerIdRaw = rowRaw(record, ['message_server_id', 'messageServerId'])
          if (sessionName) sessions.add(sessionName)
          items.push({
            kind: 'redpacket',
            messageServerId: safeInt(messageServerIdRaw, 0),
            messageServerIdRaw,
            sessionName,
            senderUserName: rowText(record, ['sender_user_name', 'senderUserName']),
            nativeUrl: rowText(record, ['native_url', 'nativeUrl']).slice(0, 260),
            sendId: rowText(record, ['send_id', 'sendId']),
            sceneId: safeInt(rowText(record, ['scene_id', 'sceneId']), 0),
            hbStatus: safeInt(rowText(record, ['hb_status', 'hbStatus']), 0),
            hbType: safeInt(rowText(record, ['hb_type', 'hbType']), 0),
            receiveStatus: safeInt(rowText(record, ['receive_status', 'receiveStatus']), 0),
            sortTime: 0
          })
        }
        stats.redPacketCount = items.filter((item) => item.kind === 'redpacket').length
        stats.redPacketSessions = sessions.size
      } else if (kind === 'redpacket' && items.length === 0) {
        console.warn('[PaymentService] redEnvelopeTable query failed:', result.error)
      }
    }

    if (items.length > 0) {
      console.log('[PaymentService] general.db items=', items.length, 'transfers=', stats.transferCount, 'redpackets=', stats.redPacketCount)
      return { items, stats }
    }

    console.warn('[PaymentService] general.db empty, fallback to message scan. reason=', tableMap.error || 'no rows')
    const fallback = await this.loadFromMessages(kind)
    if (fallback.items.length > 0 || fallback.error) return fallback
    return { items, stats, error: tableMap.error }
  }

  async listRecords(query: PaymentListQuery = {}): Promise<PaymentListResult> {
    try {
      const connected = await this.ensureConnected()
      if (!connected.success) {
        return { success: false, error: connected.error || '数据库未连接' }
      }

      const kind: PaymentKind = query.kind === 'transfer' || query.kind === 'redpacket' ? query.kind : 'all'
      const status: PaymentStatusFilter = (
        query.status === 'pending' || query.status === 'received' || query.status === 'returned' || query.status === 'expired' || query.status === 'unknown'
      ) ? query.status : 'all'
      const keyword = text(query.q).toLowerCase()
      const limit = Math.min(MAX_LIMIT, Math.max(1, safeInt(query.limit, PAGE_SIZE)))
      const offset = Math.max(0, safeInt(query.offset, 0))

      const loaded = await this.loadRawItems(kind)
      if (loaded.error && loaded.items.length === 0) {
        return { success: false, error: loaded.error }
      }

      let items = loaded.items
      if (keyword) {
        items = items.filter((item) => collectSearchBlob(item).includes(keyword))
      }
      if (status !== 'all') {
        items = items.filter((item) => item.kind === 'transfer' && item.transferState === status)
      }

      const redPackets = items.filter((item) => item.kind === 'redpacket')
      if (redPackets.length > 0) {
        await this.hydrateMessages(redPackets)
      }

      items.sort((a, b) => {
        if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime
        return b.messageServerId - a.messageServerId
      })

      const total = items.length
      const sliced = items.slice(offset, offset + limit)
      const visibleTransfers = sliced.filter((item) => item.kind === 'transfer')
      if (visibleTransfers.length > 0) {
        await this.hydrateMessages(visibleTransfers)
      }
      if (keyword) {
        // 金额/备注在消息补全后才出现，可见页再筛一次以免漏掉金额搜索
        const extra = sliced.filter((item) => collectSearchBlob(item).includes(keyword))
        if (extra.length !== sliced.length && offset === 0) {
          items = items.filter((item) => collectSearchBlob(item).includes(keyword))
        }
      }
      await this.attachContacts(sliced)

      return {
        success: true,
        items: sliced,
        total,
        hasMore: offset + sliced.length < total,
        stats: loaded.stats
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async exportRecords(query: PaymentExportQuery): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const filePath = text(query.filePath)
    if (!filePath) return { success: false, error: '导出路径不能为空' }
    const result = await this.listRecords({
      q: query.q,
      kind: query.kind,
      status: query.status,
      limit: MAX_LIMIT,
      offset: 0
    })
    if (!result.success || !result.items) {
      return { success: false, error: result.error || '读取转账与红包数据失败' }
    }

    const all: PaymentRecord[] = [...result.items]
    let offset = result.items.length
    let hasMore = !!result.hasMore
    while (hasMore && offset < (result.total || 0)) {
      const next = await this.listRecords({
        q: query.q,
        kind: query.kind,
        status: query.status,
        limit: MAX_LIMIT,
        offset
      })
      if (!next.success || !next.items?.length) break
      all.push(...next.items)
      offset += next.items.length
      hasMore = !!next.hasMore
    }

    mkdirSync(dirname(filePath), { recursive: true })
    if (query.format === 'csv') {
      const header = ['类型', '会话', '付款方', '收款方/发送方', '金额', '状态', '备注', '时间', 'ID']
      const lines = all.map((item) => {
        const values = [
          item.kind === 'transfer' ? '转账' : '红包',
          item.sessionContact?.displayName || item.sessionName,
          item.payerContact?.displayName || item.payPayer || '',
          item.kind === 'transfer'
            ? (item.receiverContact?.displayName || item.payReceiver || '')
            : (item.senderContact?.displayName || item.senderUserName || ''),
          item.amountText || item.amount || '',
          item.kind === 'transfer' ? (item.transferStatus || '') : receiveStatusLabel(item.receiveStatus),
          item.transferMemo || '',
          item.beginTransferTimeText || item.messageCreateTimeText || '',
          item.transferId || item.sendId || String(item.messageServerId)
        ]
        return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')
      })
      writeFileSync(filePath, `\uFEFF${[header.join(','), ...lines].join('\n')}`, 'utf-8')
    } else {
      writeFileSync(filePath, JSON.stringify({ total: all.length, stats: result.stats, items: all }, null, 2), 'utf-8')
    }
    return { success: true, filePath }
  }
}

export const paymentService = new PaymentService()
