import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as fzstd from 'fzstd'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

export interface FavoriteContact {
  username: string
  displayName: string
  avatarUrl?: string
  isGroup?: boolean
}

export interface FavoriteLocation {
  latitude: string
  longitude: string
  poiname: string
  label: string
  address: string
}

export interface FavoriteAttachment {
  dataId: string
  htmlId: string
  dataType: number
  typeLabel: string
  renderType: string
  title: string
  description: string
  dataFormat: string
  fullSize: number
  fullMd5: string
  thumbMd5: string
  url: string
  preview?: string
  duration: number
  sourceName: string
  sourceUsername: string
  sourceAvatar: string
  sourceTime: string
  location?: FavoriteLocation | null
  linkType?: string
  finderUsername?: string
  objectId?: string
  mediaUrl?: string
  hasRemoteResource: boolean
  isInternal: boolean
}

export interface FavoriteChatRecordItem {
  datatype: number
  sourcename: string
  sourcetime: string
  sourceheadurl?: string
  datadesc?: string
  datatitle?: string
  fileext?: string
  datasize?: number
  md5?: string
  fullmd5?: string
  thumbfullmd5?: string
  duration?: number
  dataurl?: string
  chatRecordTitle?: string
  chatRecordDesc?: string
}

export interface FavoriteItem {
  localId: number
  serverId: number
  type: number
  typeLabel: string
  title: string
  summary: string
  textBlocks: string[]
  attachments: FavoriteAttachment[]
  displayItems: FavoriteAttachment[]
  itemCount: number
  updateTime: number
  updateTimeText: string
  sourceUsername: string
  sourceChatUsername: string
  sourceToUsername: string
  senderUsername: string
  conversationUsername: string
  sourceName: string
  sourceId: string
  tags: FavoriteTag[]
  tagIds: number[]
  syncStatus: number
  uploadStatus: number
  parsed: boolean
  sourceContact?: FavoriteContact
  sourceChatContact?: FavoriteContact
  senderContact?: FavoriteContact
  conversationContact?: FavoriteContact
  chatRecordList?: FavoriteChatRecordItem[]
}

export interface FavoriteTag {
  localId: number
  serverId: number
  name: string
  seq: number
}

export interface FavoriteListQuery {
  q?: string
  kind?: string
  tagId?: number
  limit?: number
  offset?: number
}

export interface FavoriteListResult {
  success: boolean
  items?: FavoriteItem[]
  total?: number
  databaseTotal?: number
  hasMore?: boolean
  tags?: FavoriteTag[]
  typeCounts?: Record<string, number>
  error?: string
}

export interface FavoriteExportQuery extends FavoriteListQuery {
  filePath: string
  format: 'json' | 'csv'
}

const PAGE_SIZE = 60
const MAX_LIMIT = 200
const MAX_CONTENT_CHARS = 4 * 1024 * 1024
const MD5_RE = /^[0-9a-f]{32}$/i
const INTERNAL_NOTE_FILE_RE = /^[0-9a-f]{32}\.html?$/i

const FAVORITE_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  2: '图片',
  3: '语音',
  4: '视频',
  5: '链接',
  6: '位置',
  7: '音乐',
  8: '文件',
  14: '聊天记录',
  16: '商品',
  18: '笔记',
  20: '视频号'
}

const RECORD_DATA_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  2: '图片',
  3: '名片',
  4: '语音',
  5: '视频',
  6: '链接',
  7: '位置',
  8: '文件',
  17: '聊天记录',
  19: '小程序',
  22: '视频号',
  23: '视频号直播',
  29: '音乐',
  36: '小程序/H5',
  37: '表情包'
}

const RECORD_DATA_RENDER_TYPES: Record<number, string> = {
  1: 'text',
  2: 'image',
  3: 'contact',
  4: 'voice',
  5: 'video',
  6: 'link',
  7: 'location',
  8: 'file',
  17: 'chatHistory',
  19: 'link',
  22: 'link',
  23: 'link',
  29: 'link',
  36: 'link',
  37: 'emoji'
}

const DIRECT_DATA_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  2: '图片',
  3: '语音',
  4: '视频',
  5: '链接',
  6: '位置',
  7: '音乐',
  8: '文件',
  14: '聊天记录',
  16: '商品',
  18: '笔记',
  20: '视频号',
  37: '表情包'
}

const DIRECT_DATA_RENDER_TYPES: Record<number, string> = {
  1: 'text',
  2: 'image',
  3: 'voice',
  4: 'video',
  5: 'link',
  6: 'location',
  7: 'link',
  8: 'file',
  14: 'chatHistory',
  16: 'link',
  18: 'text',
  20: 'link',
  37: 'emoji'
}

function text(value: unknown, maxLen = 0, preserveLines = false): string {
  if (value === undefined || value === null) return ''
  let next = String(value).replace(/\x00/g, '')
  if (preserveLines) {
    next = next.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    next = next.split('\n').map((line) => line.trim()).join('\n')
    next = next.replace(/\n{3,}/g, '\n\n').trim()
  } else {
    next = next.replace(/\s+/g, ' ').trim()
  }
  if (maxLen > 0 && next.length > maxLen) return next.slice(0, maxLen)
  return next
}

function safeInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function looksLikeHex(value: string): boolean {
  const compact = String(value || '').replace(/\s+/g, '')
  return compact.length > 16 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)
}

function looksLikeRawId(value: string): boolean {
  const next = text(value)
  return !!(next.startsWith('wxid_') || next.endsWith('@chatroom') || next.startsWith('gh_') || /^\d{5,}@chatroom$/i.test(next))
}

function formatTimeText(ts: unknown): string {
  let seconds = safeInt(ts, 0)
  if (seconds <= 0) return ''
  if (seconds > 10_000_000_000) seconds = Math.floor(seconds / 1000)
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function decodeHtmlEntities(value: string): string {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number.parseInt(code, 10)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ''
    })
    .replace(/&amp;/g, '&')
}

function rowText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      const next = text(row[key], 0, true)
      if (next) return next
    }
    const lower = key.toLowerCase()
    for (const actual of Object.keys(row)) {
      if (actual.toLowerCase() === lower) {
        const next = text(row[actual], 0, true)
        if (next) return next
      }
    }
  }
  return ''
}

function extractXmlValue(xml: string, tagName: string, preserveLines = false): string {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(xml || '')
  if (!match) return ''
  return text(decodeHtmlEntities(match[1]), 0, preserveLines)
}

function extractXmlAttr(attrs: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs || '')
  return match ? decodeHtmlEntities(match[1]).trim() : ''
}

function extractTopLevelXmlElements(source: string, tagName: string): Array<{ attrs: string; inner: string }> {
  const xml = source || ''
  if (!xml) return []
  const pattern = new RegExp(`<(/?)${tagName}\\b([^>]*)>`, 'gi')
  const result: Array<{ attrs: string; inner: string }> = []
  let match: RegExpExecArray | null
  let depth = 0
  let openEnd = -1
  let openStart = -1
  let openAttrs = ''

  while ((match = pattern.exec(xml)) !== null) {
    const isClosing = match[1] === '/'
    const attrs = match[2] || ''
    const rawTag = match[0] || ''
    const selfClosing = !isClosing && /\/\s*>$/.test(rawTag)

    if (!isClosing) {
      if (depth === 0) {
        openStart = match.index
        openEnd = pattern.lastIndex
        openAttrs = attrs
      }
      if (!selfClosing) {
        depth += 1
      } else if (depth === 0 && openEnd >= 0) {
        result.push({ attrs: openAttrs, inner: '' })
        openStart = -1
        openEnd = -1
        openAttrs = ''
      }
      continue
    }

    if (depth <= 0) continue
    depth -= 1
    if (depth === 0 && openEnd >= 0 && openStart >= 0) {
      result.push({
        attrs: openAttrs,
        inner: xml.slice(openEnd, match.index)
      })
      openStart = -1
      openEnd = -1
      openAttrs = ''
    }
  }

  return result
}

function safeHttpUrl(value: unknown): string {
  const next = text(value, 2000)
  return next.toLowerCase().startsWith('http://') || next.toLowerCase().startsWith('https://') ? next : ''
}

function validMd5(value: unknown): string {
  const next = text(value).toLowerCase()
  return MD5_RE.test(next) ? next : ''
}

function coerceContent(row: Record<string, unknown>): string {
  const keys = ['content', 'WCDB_CT_content']
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null) {
      const lower = key.toLowerCase()
      const found = Object.keys(row).find((actual) => actual.toLowerCase() === lower)
      if (!found) continue
      return coerceContentValue(row[found])
    }
    return coerceContentValue(value)
  }
  return ''
}

function coerceContentValue(value: unknown): string {
  if (typeof value === 'string') return decodeBinaryContent(value)
  if (Array.isArray(value)) {
    try {
      const bytes = Uint8Array.from(value.map((item) => Number(item) & 0xff))
      return decodeBinaryContent(Buffer.from(bytes).toString('utf-8'))
    } catch {
      return ''
    }
  }
  return decodeBinaryContent(text(value, 0, true))
}

function decodeBinaryContent(raw: string): string {
  if (!raw) return ''
  if (raw.includes('<') || raw.includes('favitem') || raw.includes('dataitem')) return raw
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

function parseLocation(xml: string): FavoriteLocation | null {
  const locXml = extractTopLevelXmlElements(xml, 'locitem')[0]?.inner || xml
  const latitude = extractXmlValue(locXml, 'lat') || extractXmlValue(locXml, 'latitude')
  const longitude = extractXmlValue(locXml, 'lng') || extractXmlValue(locXml, 'longitude')
  const poiname = extractXmlValue(locXml, 'poiname')
  const label = extractXmlValue(locXml, 'label') || poiname
  const address = extractXmlValue(locXml, 'address')
  if (!latitude && !longitude && !poiname && !label && !address) return null
  return { latitude, longitude, poiname, label, address }
}

function emptyAttachment(partial: Partial<FavoriteAttachment> & { dataType: number; typeLabel: string; renderType: string }): FavoriteAttachment {
  return {
    dataId: '',
    htmlId: '',
    title: '',
    description: '',
    dataFormat: '',
    fullSize: 0,
    fullMd5: '',
    thumbMd5: '',
    url: '',
    duration: 0,
    sourceName: '',
    sourceUsername: '',
    sourceAvatar: '',
    sourceTime: '',
    location: null,
    hasRemoteResource: false,
    isInternal: false,
    ...partial
  }
}

function mergeNonEmpty(target: FavoriteAttachment, values: Partial<FavoriteAttachment>): FavoriteAttachment {
  for (const [key, value] of Object.entries(values) as Array<[keyof FavoriteAttachment, FavoriteAttachment[keyof FavoriteAttachment]]>) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue
    ;(target as Record<string, unknown>)[key] = value
  }
  return target
}

function parseDataItem(attrs: string, inner: string, favoriteType: number): FavoriteAttachment {
  const dataType = safeInt(extractXmlAttr(attrs, 'datatype') || extractXmlValue(inner, 'datatype'), 0)
  const isRecordItem = favoriteType === 14 || favoriteType === 18
  const typeLabels = isRecordItem ? RECORD_DATA_TYPE_LABELS : DIRECT_DATA_TYPE_LABELS
  const renderTypes = isRecordItem ? RECORD_DATA_RENDER_TYPES : DIRECT_DATA_RENDER_TYPES
  const title = extractXmlValue(inner, 'datatitle') || extractXmlValue(inner, 'title')
  const description = extractXmlValue(inner, 'datadesc', dataType === 1) || extractXmlValue(inner, 'description', dataType === 1)
  const dataFormat = extractXmlValue(inner, 'datafmt') || extractXmlValue(inner, 'fileext')
  const mediaExtension = dataFormat.toLowerCase().replace(/^\./, '')
  let typeLabel = typeLabels[dataType] || (dataType ? `类型 ${dataType}` : '附件')
  let renderType = renderTypes[dataType] || 'text'
  if (['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'].includes(mediaExtension)) {
    typeLabel = '视频'
    renderType = 'video'
  } else if (['silk', 'slk', 'amr', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus'].includes(mediaExtension)) {
    typeLabel = '语音'
    renderType = 'voice'
  }

  const fullMd5 = validMd5(extractXmlValue(inner, 'fullmd5') || extractXmlValue(inner, 'md5'))
  const thumbMd5 = validMd5(
    extractXmlValue(inner, 'thumbfullmd5') || extractXmlValue(inner, 'cdnthumbmd5') || extractXmlValue(inner, 'thumbmd5')
  )
  const url = safeHttpUrl(
    extractXmlValue(inner, 'link') || extractXmlValue(inner, 'url') || extractXmlValue(inner, 'stream_weburl')
  )
  const weburlInner = extractTopLevelXmlElements(inner, 'weburlitem')[0]?.inner || ''
  const webUrl = safeHttpUrl(extractXmlValue(weburlInner, 'link') || extractXmlValue(weburlInner, 'url')) || url

  return {
    dataId: text(extractXmlAttr(attrs, 'dataid'), 180),
    htmlId: text(extractXmlAttr(attrs, 'htmlid'), 180),
    dataType,
    typeLabel,
    renderType,
    title,
    description,
    dataFormat,
    fullSize: safeInt(extractXmlValue(inner, 'fullsize') || extractXmlValue(inner, 'filesize'), 0),
    fullMd5,
    thumbMd5,
    url: webUrl,
    duration: safeInt(
      extractXmlValue(inner, 'duration')
      || extractXmlValue(inner, 'voicelength')
      || extractXmlValue(inner, 'videoduration'),
      0
    ),
    sourceName: extractXmlValue(inner, 'sourcename') || extractXmlValue(inner, 'sourcedisplayname'),
    sourceUsername: extractXmlValue(inner, 'sourceusername') || extractXmlValue(inner, 'sourceusrname') || extractXmlValue(inner, 'fromusr'),
    sourceAvatar: safeHttpUrl(
      extractXmlValue(inner, 'sourceavatar')
      || extractXmlValue(inner, 'sourceheadurl')
      || extractXmlValue(inner, 'sourceheadimgurl')
      || extractXmlValue(inner, 'avatar')
    ),
    sourceTime: extractXmlValue(inner, 'sourcetime'),
    location: parseLocation(inner),
    hasRemoteResource: Boolean(extractXmlValue(inner, 'cdn_dataurl') || extractXmlValue(inner, 'cdn_thumburl')),
    isInternal: Boolean(favoriteType === 18 && dataType === 8 && INTERNAL_NOTE_FILE_RE.test(title))
  }
}

function applyTopLevelDisplayItems(xml: string, favoriteType: number, dataItems: FavoriteAttachment[]): FavoriteAttachment[] {
  if (favoriteType === 5) {
    let item = dataItems.find((row) => row.dataType === 5)
    if (!item) {
      item = emptyAttachment({ dataType: 5, typeLabel: '链接', renderType: 'link' })
      dataItems.push(item)
    }
    const weburlInner = extractTopLevelXmlElements(xml, 'weburlitem')[0]?.inner || ''
    mergeNonEmpty(item, {
      title: extractXmlValue(weburlInner, 'pagetitle') || extractXmlValue(xml, 'title'),
      description: extractXmlValue(weburlInner, 'pagedesc', true) || extractXmlValue(xml, 'desc', true),
      url: safeHttpUrl(
        extractXmlValue(weburlInner, 'clean_url')
        || extractXmlValue(weburlInner, 'link')
        || extractXmlValue(xml, 'link')
      ),
      preview: safeHttpUrl(extractXmlValue(weburlInner, 'thumburl') || extractXmlValue(weburlInner, 'coverurl')),
      linkType: 'link'
    })
  }

  if (favoriteType === 6) {
    const location = parseLocation(xml)
    if (location) {
      dataItems.push(emptyAttachment({
        dataType: 6,
        typeLabel: '位置',
        renderType: 'location',
        title: location.poiname || location.label || '位置',
        description: location.label || location.address || '',
        location
      }))
    }
  }

  if (favoriteType === 7) {
    const musicInner = extractTopLevelXmlElements(xml, 'musicitem')[0]?.inner || ''
    dataItems.push(emptyAttachment({
      dataType: 7,
      typeLabel: '音乐',
      renderType: 'link',
      title: extractXmlValue(musicInner, 'title') || extractXmlValue(xml, 'title') || '音乐',
      description: extractXmlValue(musicInner, 'desc') || extractXmlValue(musicInner, 'singer') || extractXmlValue(xml, 'desc'),
      url: safeHttpUrl(extractXmlValue(musicInner, 'link') || extractXmlValue(musicInner, 'url') || extractXmlValue(xml, 'link')),
      preview: safeHttpUrl(extractXmlValue(musicInner, 'thumburl') || extractXmlValue(musicInner, 'coverurl')),
      sourceName: extractXmlValue(musicInner, 'singer'),
      linkType: 'music'
    }))
  }

  if (favoriteType === 20) {
    const finderInner = extractTopLevelXmlElements(xml, 'finderFeed')[0]?.inner || ''
    if (finderInner) {
      const mediaInner = extractTopLevelXmlElements(finderInner, 'media')[0]?.inner || ''
      const mediaUrl = safeHttpUrl(extractXmlValue(mediaInner, 'url'))
      const preview = safeHttpUrl(extractXmlValue(mediaInner, 'coverUrl') || extractXmlValue(mediaInner, 'thumbUrl'))
      const finderUsername = extractXmlValue(finderInner, 'username')
      const objectId = extractXmlValue(finderInner, 'objectId')
      const profileUrl = finderUsername
        ? `https://channels.weixin.qq.com/web/pages/profile?username=${finderUsername}`
        : ''
      dataItems.push(emptyAttachment({
        dataId: objectId,
        dataType: 20,
        typeLabel: '视频号',
        renderType: 'link',
        title: extractXmlValue(finderInner, 'desc') || extractXmlValue(xml, 'title') || '视频号',
        description: extractXmlValue(finderInner, 'desc', true),
        url: mediaUrl || profileUrl,
        preview,
        duration: safeInt(extractXmlValue(mediaInner, 'videoPlayDuration'), 0),
        sourceName: extractXmlValue(finderInner, 'nickname') || '视频号',
        sourceAvatar: safeHttpUrl(extractXmlValue(finderInner, 'avatar')),
        linkType: 'finder',
        finderUsername,
        objectId,
        mediaUrl,
        hasRemoteResource: Boolean(mediaUrl || preview)
      }))
    }
  }

  return dataItems
}

function favoriteTextParts(xml: string, dataItems: FavoriteAttachment[]): string[] {
  const parts: string[] = []
  for (const item of dataItems) {
    if (item.dataType !== 1) continue
    const value = text(item.description, 0, true)
    if (value && !parts.includes(value)) parts.push(value)
  }
  for (const value of [
    extractXmlValue(xml, 'desc', true) || extractXmlValue(xml, 'description', true) || extractXmlValue(xml, 'content', true),
    extractXmlValue(extractTopLevelXmlElements(xml, 'weburlitem')[0]?.inner || '', 'desc', true)
  ]) {
    if (value && !parts.includes(value)) parts.push(value)
  }
  return parts
}

function favoriteTitle(xml: string, favoriteType: number, dataItems: FavoriteAttachment[]): string {
  const title = extractXmlValue(xml, 'title')
    || extractXmlValue(xml, 'favtitle')
    || extractXmlValue(extractTopLevelXmlElements(xml, 'weburlitem')[0]?.inner || '', 'title')
    || extractXmlValue(extractTopLevelXmlElements(xml, 'musicitem')[0]?.inner || '', 'title')
  if (title) return title
  if (favoriteType !== 18) {
    for (const item of dataItems) {
      if (item.title && !item.isInternal) return text(item.title, 300)
    }
  }
  return FAVORITE_TYPE_LABELS[favoriteType] || '收藏内容'
}

function toChatRecordItem(item: FavoriteAttachment): FavoriteChatRecordItem {
  return {
    datatype: item.dataType,
    sourcename: item.sourceName || '',
    sourcetime: item.sourceTime || '',
    sourceheadurl: item.sourceAvatar || undefined,
    datadesc: item.description || undefined,
    datatitle: item.title || undefined,
    fileext: item.dataFormat || undefined,
    datasize: item.fullSize || undefined,
    md5: item.fullMd5 || undefined,
    fullmd5: item.fullMd5 || undefined,
    thumbfullmd5: item.thumbMd5 || undefined,
    duration: item.duration || undefined,
    dataurl: item.url || undefined,
    chatRecordTitle: item.renderType === 'chatHistory' ? (item.title || '聊天记录') : undefined,
    chatRecordDesc: item.renderType === 'chatHistory' ? item.description : undefined
  }
}

function parseFavoriteRow(row: Record<string, unknown>, tags: FavoriteTag[], accountName: string): FavoriteItem {
  const xml = coerceContent(row).slice(0, MAX_CONTENT_CHARS)
  const favoriteType = safeInt(rowText(row, ['type', 'WCDB_CT_type']), 0)
  let dataItems = extractTopLevelXmlElements(xml, 'dataitem').map((block) => parseDataItem(block.attrs, block.inner, favoriteType))
  dataItems = applyTopLevelDisplayItems(xml, favoriteType, dataItems)
  const textParts = favoriteTextParts(xml, dataItems)
  const attachments = dataItems.filter((item) => item.dataType !== 1 && !item.isInternal)
  let summary = text(textParts.join('\n'), 600, true)
  if (!summary) {
    summary = attachments
      .map((item) => text(item.description || item.title, 600, true))
      .find(Boolean) || ''
  }

  const sourceInner = extractTopLevelXmlElements(xml, 'source')[0]?.inner || xml
  const fromUser = text(
    rowText(row, ['fromusr', 'fromUsr', 'from_usr']) || extractXmlValue(sourceInner, 'fromusr'),
    260
  )
  const sourceChat = text(
    rowText(row, ['realchatname', 'realChatName']) || extractXmlValue(sourceInner, 'realchatname'),
    260
  )
  const toUser = text(extractXmlValue(sourceInner, 'tousr'), 260)

  let conversationUsername = ''
  let senderUsername = ''
  if (fromUser.endsWith('@chatroom')) {
    conversationUsername = fromUser
    senderUsername = sourceChat || fromUser
  } else if (toUser.endsWith('@chatroom')) {
    conversationUsername = toUser
    senderUsername = sourceChat || fromUser
  } else if (accountName && fromUser === accountName) {
    conversationUsername = toUser || sourceChat || fromUser
    senderUsername = fromUser
  } else {
    conversationUsername = fromUser || toUser || sourceChat
    senderUsername = sourceChat || fromUser || toUser
  }

  const displayItems = dataItems.filter((item) => !item.isInternal)
  const updateTime = safeInt(rowText(row, ['update_time', 'updateTime']), 0)
  return {
    localId: safeInt(rowText(row, ['local_id', 'localId']), 0),
    serverId: safeInt(rowText(row, ['server_id', 'serverId']), 0),
    type: favoriteType,
    typeLabel: FAVORITE_TYPE_LABELS[favoriteType] || (favoriteType ? `其他类型 ${favoriteType}` : '其他收藏'),
    title: favoriteTitle(xml, favoriteType, dataItems),
    summary,
    textBlocks: textParts,
    attachments,
    displayItems,
    itemCount: dataItems.length,
    updateTime,
    updateTimeText: formatTimeText(updateTime),
    sourceUsername: fromUser,
    sourceChatUsername: sourceChat,
    sourceToUsername: toUser,
    senderUsername,
    conversationUsername,
    sourceName: extractXmlValue(sourceInner, 'sourcename'),
    sourceId: text(rowText(row, ['source_id', 'sourceId']), 260),
    tags,
    tagIds: tags.map((tag) => tag.localId),
    syncStatus: safeInt(rowText(row, ['sync_status', 'syncStatus']), 0),
    uploadStatus: safeInt(rowText(row, ['upload_status', 'uploadStatus']), 0),
    parsed: xml.includes('<'),
    chatRecordList: favoriteType === 14
      ? displayItems.map(toChatRecordItem)
      : undefined
  }
}

function matchesQuery(item: FavoriteItem, query: string): boolean {
  const needle = text(query, 300).toLowerCase()
  if (!needle) return true
  const haystack = [
    item.typeLabel,
    item.title,
    item.summary,
    item.sourceName,
    item.sourceUsername,
    item.senderUsername,
    item.conversationUsername,
    item.sourceContact?.displayName,
    item.senderContact?.displayName,
    item.conversationContact?.displayName,
    ...item.textBlocks,
    ...item.tags.map((tag) => tag.name),
    ...item.attachments.flatMap((attachment) => [attachment.title, attachment.description, attachment.url, attachment.sourceName])
  ].join(' ').toLowerCase()
  return haystack.includes(needle)
}

class FavoritesService {
  private configService = ConfigService.getInstance()

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    return chatService.connect()
  }

  private resolveFavoriteDbPath(): string {
    const wxid = String(this.configService.get('myWxid') || '').trim()
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const accountDir = this.configService.getAccountDir(dbPath, wxid)
    if (!accountDir) return ''
    const candidates = [
      join(accountDir, 'db_storage', 'favorite', 'favorite.db'),
      join(accountDir, 'db_storage', 'Favorite', 'favorite.db'),
      join(accountDir, 'db_storage', 'favorite.db'),
      join(accountDir, 'favorite', 'favorite.db'),
      join(accountDir, 'favorite.db')
    ]
    return candidates.find((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    }) || ''
  }

  private async queryFavorite(sql: string): Promise<{ success: boolean; rows?: any[]; error?: string; dbPath?: string }> {
    const dbPath = this.resolveFavoriteDbPath()
    if (!dbPath) {
      return { success: false, error: '未找到 favorite.db，当前账号可能没有收藏数据' }
    }
    const kinds = ['message', 'favorite']
    let lastError = ''
    for (const kind of kinds) {
      const result = await wcdbService.execQuery(kind, dbPath, sql)
      if (result.success && Array.isArray(result.rows)) {
        return { success: true, rows: result.rows, dbPath }
      }
      lastError = result.error || `查询失败 (${kind})`
    }
    return { success: false, error: lastError || '读取 favorite.db 失败', dbPath }
  }

  private async loadTags(): Promise<{ tags: FavoriteTag[]; byFavorite: Map<number, FavoriteTag[]> }> {
    const tagResult = await this.queryFavorite(
      'SELECT local_id, server_id, name, seq FROM fav_tag_db_item ORDER BY seq ASC, local_id ASC'
    )
    const tags: FavoriteTag[] = []
    const tagsByLocalId = new Map<number, FavoriteTag>()
    for (const row of tagResult.rows || []) {
      const record = row as Record<string, unknown>
      const tag: FavoriteTag = {
        localId: safeInt(rowText(record, ['local_id', 'localId']), 0),
        serverId: safeInt(rowText(record, ['server_id', 'serverId']), 0),
        name: text(rowText(record, ['name']), 160),
        seq: safeInt(rowText(record, ['seq']), 0)
      }
      tags.push(tag)
      if (tag.localId) tagsByLocalId.set(tag.localId, tag)
    }

    const bindResult = await this.queryFavorite(
      'SELECT tag_local_id, tag_server_id, fav_local_id, fav_server_id, op_code FROM fav_bind_tag_db_item'
    )
    const byFavorite = new Map<number, FavoriteTag[]>()
    for (const row of bindResult.rows || []) {
      const record = row as Record<string, unknown>
      const favoriteId = safeInt(rowText(record, ['fav_local_id', 'favLocalId']), 0)
      const tagId = safeInt(rowText(record, ['tag_local_id', 'tagLocalId']), 0)
      const tag = tagsByLocalId.get(tagId)
      if (!favoriteId || !tag) continue
      const list = byFavorite.get(favoriteId) || []
      if (!list.some((item) => item.localId === tag.localId)) {
        list.push(tag)
        byFavorite.set(favoriteId, list)
      }
    }
    return { tags, byFavorite }
  }

  private async attachContacts(items: FavoriteItem[]): Promise<void> {
    const usernames: string[] = []
    for (const item of items) {
      usernames.push(
        item.sourceUsername,
        item.sourceChatUsername,
        item.sourceToUsername,
        item.senderUsername,
        item.conversationUsername
      )
    }
    const unique = Array.from(new Set(usernames.map((name) => text(name)).filter(Boolean)))
    if (unique.length === 0) return
    const enrichment = await chatService.enrichSessionsContactInfo(unique)
    const map = enrichment.success && enrichment.contacts ? enrichment.contacts : {}
    const myWxid = this.configService.getMyWxidCleaned() || ''

    const toContact = (username?: string): FavoriteContact | undefined => {
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
      item.sourceContact = toContact(item.sourceUsername)
      item.sourceChatContact = toContact(item.sourceChatUsername)
      item.senderContact = toContact(item.senderUsername)
      item.conversationContact = toContact(item.conversationUsername)
    }
  }

  async listRecords(query: FavoriteListQuery = {}): Promise<FavoriteListResult> {
    try {
      const connected = await this.ensureConnected()
      if (!connected.success) {
        return { success: false, error: connected.error || '数据库未连接' }
      }

      const result = await this.queryFavorite(
        'SELECT local_id, server_id, type, update_time, content, source_id, sync_status, upload_status, fromusr, realchatname FROM fav_db_item ORDER BY update_time DESC, local_id DESC'
      )
      if (!result.success) {
        return { success: false, error: result.error || '读取收藏失败' }
      }

      const { tags, byFavorite } = await this.loadTags()
      const accountName = this.configService.getMyWxidCleaned() || String(this.configService.get('myWxid') || '').trim()
      let items = (result.rows || []).map((row) => {
        const record = row as Record<string, unknown>
        const localId = safeInt(rowText(record, ['local_id', 'localId']), 0)
        return parseFavoriteRow(record, byFavorite.get(localId) || [], accountName)
      })

      const typeCounts: Record<string, number> = {}
      for (const item of items) {
        const key = String(item.type || 0)
        typeCounts[key] = (typeCounts[key] || 0) + 1
      }
      const databaseTotal = items.length

      const kind = text(query.kind, 40).toLowerCase() || 'all'
      if (kind !== 'all') {
        const wantedType = safeInt(kind, -1)
        items = items.filter((item) => item.type === wantedType)
      }
      const tagId = safeInt(query.tagId, 0)
      if (tagId > 0) {
        items = items.filter((item) => item.tagIds.includes(tagId))
      }
      const keyword = text(query.q)
      if (keyword) {
        items = items.filter((item) => matchesQuery(item, keyword))
      }

      const limit = Math.min(MAX_LIMIT, Math.max(1, safeInt(query.limit, PAGE_SIZE)))
      const offset = Math.max(0, safeInt(query.offset, 0))
      const total = items.length
      const sliced = items.slice(offset, offset + limit)
      await this.attachContacts(sliced)

      return {
        success: true,
        items: sliced,
        total,
        databaseTotal,
        hasMore: offset + sliced.length < total,
        tags,
        typeCounts
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async exportRecords(query: FavoriteExportQuery): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const filePath = text(query.filePath)
    if (!filePath) return { success: false, error: '导出路径不能为空' }
    const result = await this.listRecords({
      q: query.q,
      kind: query.kind,
      tagId: query.tagId,
      limit: MAX_LIMIT,
      offset: 0
    })
    if (!result.success || !result.items) {
      return { success: false, error: result.error || '读取收藏失败' }
    }

    const all: FavoriteItem[] = [...result.items]
    let offset = result.items.length
    let hasMore = !!result.hasMore
    while (hasMore && offset < (result.total || 0)) {
      const next = await this.listRecords({
        q: query.q,
        kind: query.kind,
        tagId: query.tagId,
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
      const header = ['类型', '标题', '摘要', '来源', '会话', '标签', '时间']
      const lines = all.map((item) => {
        const values = [
          item.typeLabel,
          item.title,
          item.summary.replace(/\n/g, ' '),
          item.senderContact?.displayName || item.sourceName || item.senderUsername,
          item.conversationContact?.displayName || item.conversationUsername,
          item.tags.map((tag) => tag.name).filter(Boolean).join(' / '),
          item.updateTimeText
        ]
        return values.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(',')
      })
      writeFileSync(filePath, `\uFEFF${[header.join(','), ...lines].join('\n')}`, 'utf-8')
    } else {
      writeFileSync(filePath, JSON.stringify({
        total: all.length,
        databaseTotal: result.databaseTotal,
        typeCounts: result.typeCounts,
        items: all
      }, null, 2), 'utf-8')
    }
    return { success: true, filePath }
  }
}

export const favoritesService = new FavoritesService()
