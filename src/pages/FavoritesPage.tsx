import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlignLeft,
  Bookmark,
  ChevronDown,
  Download,
  FileText,
  Image as ImageIcon,
  Layers,
  Link2,
  Loader2,
  MapPin,
  MessageSquare,
  Mic,
  Music,
  PlayCircle,
  RefreshCw,
  Search,
  ShoppingBag,
  StickyNote,
  Tag,
  Video,
  X
} from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { displayNameOrFallback } from '../utils/displayName'
import { renderTextWithEmoji } from '../utils/renderTextWithEmoji'
import type { ChatRecordItem } from '../types/models'
import wechatLogoUrl from '../assets/wechat/wechat-logo.svg'
import channelsLogoUrl from '../assets/wechat/channels-logo.svg'
import miniProgramIconUrl from '../assets/wechat/mini-program.svg'
import pdfIconUrl from '../assets/wechat/pdf.png'
import wordIconUrl from '../assets/wechat/word.png'
import excelIconUrl from '../assets/wechat/excel.png'
import zipIconUrl from '../assets/wechat/zip.png'
import './FavoritesPage.scss'

type FavoriteItem = NonNullable<Awaited<ReturnType<typeof window.electronAPI.favorites.list>>['items']>[number]
type FavoriteAttachment = FavoriteItem['attachments'][number]

const PAGE_SIZE = 60
const TYPE_META: Record<number, { label: string; icon: typeof AlignLeft }> = {
  1: { label: '文本', icon: AlignLeft },
  2: { label: '图片', icon: ImageIcon },
  3: { label: '语音', icon: Mic },
  4: { label: '视频', icon: Video },
  5: { label: '链接', icon: Link2 },
  6: { label: '位置', icon: MapPin },
  7: { label: '音乐', icon: Music },
  8: { label: '文件', icon: FileText },
  14: { label: '聊天记录', icon: MessageSquare },
  16: { label: '商品', icon: ShoppingBag },
  18: { label: '笔记', icon: StickyNote },
  20: { label: '视频号', icon: PlayCircle }
}

function favoriteKey(item: FavoriteItem): string {
  return `${item.localId || 0}-${item.serverId || 0}`
}

function looksLikeRawId(value?: string): boolean {
  const next = String(value || '').trim()
  return next.startsWith('wxid_') || next.endsWith('@chatroom') || next.startsWith('gh_')
}

function contactName(contact?: { username?: string; displayName?: string }): string {
  const raw = String(contact?.username || '').trim()
  const name = String(contact?.displayName || '').trim()
  if (name && name !== raw && !looksLikeRawId(name)) return name
  return ''
}

function sourceDisplayName(item: FavoriteItem): string {
  return displayNameOrFallback(
    '未知来源',
    contactName(item.senderContact),
    contactName(item.sourceContact),
    item.sourceName,
    item.senderUsername
  )
}

function sourceAvatar(item: FavoriteItem): string | undefined {
  return item.senderContact?.avatarUrl || item.sourceContact?.avatarUrl
}

function sourceInitial(item: FavoriteItem): string {
  return [...sourceDisplayName(item)][0] || '?'
}

function FavoriteAvatar({ item, canOpen, onOpen }: { item: FavoriteItem; canOpen: boolean; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const src = sourceAvatar(item)
  const name = sourceDisplayName(item)
  return (
    <button
      type="button"
      className="favorite-avatar"
      title={canOpen ? `打开${name}的会话` : name}
      disabled={!canOpen}
      onClick={onOpen}
    >
      {src && !broken ? (
        <img src={src} alt={name} onError={() => setBroken(true)} />
      ) : (
        <span>{sourceInitial(item)}</span>
      )}
    </button>
  )
}

function sourceChatUsername(item: FavoriteItem): string {
  return String(item.conversationUsername || item.sourceUsername || item.sourceChatUsername || '').trim()
}

function sourceContextName(item: FavoriteItem): string {
  const context = item.conversationContact || item.sourceChatContact
  if (!context?.isGroup) return ''
  const name = contactName(context)
  const sender = sourceDisplayName(item)
  return name && name !== sender ? name : ''
}

function toRenderableImageSrc(path?: string): string | undefined {
  const raw = String(path || '').trim()
  if (!raw) return undefined
  if (/^(data:|blob:|https?:|file:)/i.test(raw)) return raw
  const normalized = raw.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) return encodeURI(`file:///${normalized}`)
  if (normalized.startsWith('/')) return encodeURI(`file://${normalized}`)
  return raw
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function voiceDurationSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(1, Math.round(duration > 1000 ? duration / 1000 : duration))
}

function voiceWidth(duration: number): string {
  return `${Math.min(200, 80 + voiceDurationSeconds(duration) * 3)}px`
}

function openExternal(url?: string) {
  const next = String(url || '').trim()
  if (!next) return
  if (window.electronAPI?.shell?.openExternal) {
    void window.electronAPI.shell.openExternal(next)
    return
  }
  window.open(next, '_blank')
}

function FileTypeIcon({ fileName }: { fileName?: string }) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase() || ''
  const kind = ['pdf'].includes(ext)
    ? 'pdf'
    : ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)
      ? 'zip'
      : ['doc', 'docx'].includes(ext)
        ? 'doc'
        : ['xls', 'xlsx', 'csv'].includes(ext)
          ? 'xls'
          : ['ppt', 'pptx'].includes(ext)
            ? 'ppt'
            : ['txt', 'md', 'log'].includes(ext)
              ? 'txt'
              : 'default'
  const iconUrl = kind === 'pdf'
    ? pdfIconUrl
    : kind === 'doc'
      ? wordIconUrl
      : kind === 'xls'
        ? excelIconUrl
        : kind === 'zip'
          ? zipIconUrl
          : ''
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="wechat-file-icon" />
  }
  const label = kind === 'default' ? '' : kind.toUpperCase()
  return (
    <svg viewBox="0 0 24 24" className={`wechat-file-icon wechat-file-icon--${kind}`} aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {label ? <text x="6" y="17" fontSize="5" fill="currentColor" fontWeight="bold">{label}</text> : null}
    </svg>
  )
}

function TextBubble({ children }: { children: ReactNode }) {
  return <div className="msg-bubble bubble-tail-l">{children}</div>
}

function FavoriteMedia({
  md5,
  sessionId,
  kind,
  alt,
  poster
}: {
  md5?: string
  sessionId?: string
  kind: 'image' | 'video'
  alt: string
  poster?: string
}) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const hash = String(md5 || '').trim().toLowerCase()
    if (!hash) {
      setFailed(true)
      return
    }
    let cancelled = false
    setFailed(false)
    setSrc('')
    void (async () => {
      const cached = await window.electronAPI.image.resolveCache({
        sessionId,
        imageMd5: hash,
        preferFilePath: true,
        allowCacheIndex: true,
        allowFilesystemScan: true,
        suppressEvents: true
      })
      if (cancelled) return
      if (cached.success && cached.localPath) {
        setSrc(toRenderableImageSrc(cached.localPath) || '')
        return
      }
      const decrypted = await window.electronAPI.image.decrypt({
        sessionId,
        imageMd5: hash,
        preferFilePath: true,
        allowCacheIndex: true,
        allowFilesystemScan: true,
        suppressEvents: true
      })
      if (cancelled) return
      if (decrypted.success && decrypted.localPath) {
        setSrc(toRenderableImageSrc(decrypted.localPath) || '')
        return
      }
      setFailed(true)
    })()
    return () => {
      cancelled = true
    }
  }, [md5, sessionId])

  if (src) {
    if (kind === 'video') {
      return (
        <button
          type="button"
          className="wechat-media wechat-media--video msg-radius"
          onClick={() => { void window.electronAPI.window.openImageViewerWindow(src) }}
        >
          <img src={src} alt={alt} />
          <span className="wechat-media__play" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </button>
      )
    }
    return (
      <button
        type="button"
        className="wechat-media msg-radius"
        onClick={() => { void window.electronAPI.window.openImageViewerWindow(src) }}
      >
        <img src={src} alt={alt} />
      </button>
    )
  }

  if (poster) {
    return (
      <button type="button" className="wechat-media msg-radius" onClick={() => openExternal(poster)}>
        <img src={poster} alt={alt} />
      </button>
    )
  }

  return (
    <div className={`wechat-media-placeholder wechat-media-placeholder--${kind}`}>
      {kind === 'video' ? <Video size={18} /> : <ImageIcon size={18} />}
      <span>{failed ? (kind === 'video' ? '视频未缓存' : '图片未缓存') : '正在加载'}</span>
    </div>
  )
}

function LinkCard({
  href,
  heading,
  abstract,
  preview,
  from,
  fromAvatar,
  linkType
}: {
  href?: string
  heading?: string
  abstract?: string
  preview?: string
  from?: string
  fromAvatar?: string
  linkType?: string
}) {
  const [previewError, setPreviewError] = useState(false)
  const url = String(href || '').trim()
  const title = String(heading || url || '').trim()
  let desc = String(abstract || '').trim()
  if (desc && title && desc === title) desc = ''
  const fromText = String(from || '').trim() || (() => {
    try {
      return url && /^https?:\/\//i.test(url) ? new URL(url).hostname : ''
    } catch {
      return ''
    }
  })()
  const showPreview = Boolean(preview) && !previewError
  const isFinder = linkType === 'finder'
  const isMini = linkType === 'mini_program'
  const open = () => openExternal(url)

  if (isFinder) {
    return (
      <button type="button" className="wechat-link-card-finder msg-radius" onClick={open} disabled={!url}>
        <div className={`wechat-link-finder-cover ${showPreview ? '' : 'wechat-link-finder-cover--empty'}`}>
          {showPreview ? <img src={preview} alt="" onError={() => setPreviewError(true)} /> : null}
          <img src={channelsLogoUrl} alt="" className="wechat-link-finder-logo" />
        </div>
        <div className="wechat-link-finder-title">{title || '视频号'}</div>
      </button>
    )
  }

  if (isMini) {
    return (
      <button type="button" className="wechat-link-card wechat-link-card--mini-program msg-radius" onClick={open} disabled={!url}>
        <div className="wechat-link-mini-body">
          <div className="wechat-link-mini-header">
            <span className="wechat-link-mini-header-avatar">{fromText ? [...fromText][0] : ''}</span>
            <span className="wechat-link-mini-header-name">{fromText || '小程序'}</span>
          </div>
          <div className="wechat-link-mini-title">{title}</div>
          {showPreview ? (
            <div className="wechat-link-mini-preview">
              <img src={preview} alt="" onError={() => setPreviewError(true)} />
            </div>
          ) : null}
        </div>
        <div className="wechat-link-mini-footer">
          <img src={miniProgramIconUrl} alt="" />
          <span>小程序</span>
        </div>
      </button>
    )
  }

  return (
    <button type="button" className="wechat-link-card msg-radius" onClick={open} disabled={!url}>
      <div className="wechat-link-content">
        <div className="wechat-link-title">{title}</div>
        {(desc || showPreview) ? (
          <div className="wechat-link-summary">
            {desc ? <div className="wechat-link-desc">{desc}</div> : null}
            {showPreview ? (
              <div className="wechat-link-thumb">
                <img src={preview} alt="" onError={() => setPreviewError(true)} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="wechat-link-from">
        {fromAvatar ? <img src={fromAvatar} alt="" className="wechat-link-from-avatar" /> : <span className="wechat-link-from-avatar">{fromText ? [...fromText][0] : ''}</span>}
        <span className="wechat-link-from-name">{fromText || '\u200B'}</span>
      </div>
    </button>
  )
}

function LocationCard({
  latitude,
  longitude,
  poiname,
  label,
  address
}: {
  latitude?: string
  longitude?: string
  poiname?: string
  label?: string
  address?: string
}) {
  const title = poiname || label || '位置'
  const desc = (label || address || '') !== title ? (label || address || '') : ''
  const lat = Number.parseFloat(String(latitude || ''))
  const lng = Number.parseFloat(String(longitude || ''))
  const hasCoord = Number.isFinite(lat) && Number.isFinite(lng)
  let mapTileUrl = ''
  if (hasCoord) {
    const zoom = 15
    const tileX = Math.floor((lng + 180) / 360 * (2 ** zoom))
    const latRad = lat * Math.PI / 180
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * (2 ** zoom))
    mapTileUrl = `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
  }
  return (
    <button
      type="button"
      className="wechat-location-card-wrap wechat-location-card-wrap--received"
      onClick={() => {
        if (hasCoord) {
          openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(title)}`)
          return
        }
        openExternal(`https://uri.amap.com/search?keyword=${encodeURIComponent(title)}`)
      }}
    >
      <div className="wechat-location-card">
        <div className="wechat-location-card__text">
          <div className="wechat-location-card__title">{title}</div>
          {desc ? <div className="wechat-location-card__subtitle">{desc}</div> : null}
        </div>
        <div className={`wechat-location-card__map ${mapTileUrl ? '' : 'wechat-location-card__map--placeholder'}`}>
          {mapTileUrl ? <img src={mapTileUrl} alt="" className="wechat-location-card__map-image" /> : null}
          <div className="wechat-location-card__pin" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 22s7-5.82 7-12a7 7 0 1 0-14 0c0 6.18 7 12 7 12Z" fill="#22c55e" />
              <circle cx="12" cy="10" r="3.2" fill="#ffffff" />
            </svg>
          </div>
        </div>
      </div>
    </button>
  )
}

function historyPreviewLines(item: FavoriteItem): string[] {
  const records = item.chatRecordList || []
  if (records.length) {
    return records.slice(0, 4).map((record) => {
      const name = String(record.sourcename || '').trim()
      const text = String(record.datadesc || record.datatitle || record.chatRecordTitle || '[媒体消息]').trim()
      return name ? `${name}: ${text}` : text
    }).filter(Boolean)
  }
  return String(item.summary || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4)
}

function AttachmentCard({
  item,
  attachment,
  onOpenHistory
}: {
  item: FavoriteItem
  attachment: FavoriteAttachment
  onOpenHistory: (item: FavoriteItem) => void
}) {
  const sessionId = sourceChatUsername(item)
  if (attachment.renderType === 'image') {
    return (
      <FavoriteMedia
        md5={attachment.fullMd5 || attachment.thumbMd5}
        sessionId={sessionId}
        kind="image"
        alt={attachment.title || '收藏图片'}
        poster={attachment.preview}
      />
    )
  }
  if (attachment.renderType === 'video') {
    return (
      <FavoriteMedia
        md5={attachment.thumbMd5 || attachment.fullMd5}
        sessionId={sessionId}
        kind="video"
        alt={attachment.title || '收藏视频'}
        poster={attachment.preview}
      />
    )
  }
  if (attachment.renderType === 'voice') {
    const seconds = voiceDurationSeconds(attachment.duration)
    return (
      <div className="wechat-voice-wrapper wechat-voice-wrapper--received">
        <div className="wechat-voice-bubble wechat-voice-received msg-radius" style={{ width: voiceWidth(attachment.duration) }}>
          <div className="wechat-voice-content">
            <svg className="wechat-voice-icon voice-icon-received" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
              <path d="M10.24 11.616l-4.224 4.192 4.224 4.192c1.088-1.056 1.76-2.56 1.76-4.192s-0.672-3.136-1.76-4.192z" />
              <path className="voice-wave-2" d="M15.199 6.721l-1.791 1.76c1.856 1.888 3.008 4.48 3.008 7.328s-1.152 5.44-3.008 7.328l1.791 1.76c2.336-2.304 3.809-5.536 3.809-9.088s-1.473-6.784-3.809-9.088z" />
              <path className="voice-wave-3" d="M20.129 1.793l-1.762 1.76c3.104 3.168 5.025 7.488 5.025 12.256s-1.921 9.088-5.025 12.256l1.762 1.76c3.648-3.616 5.887-8.544 5.887-14.016s-2.239-10.432-5.887-14.016z" />
            </svg>
            <span className="wechat-voice-duration">{seconds}"</span>
          </div>
        </div>
      </div>
    )
  }
  if (attachment.renderType === 'location' && attachment.location) {
    return <LocationCard {...attachment.location} />
  }
  if (attachment.renderType === 'file') {
    return (
      <div className="wechat-file-card wechat-special-card msg-radius">
        <div className="wechat-redpacket-content">
          <div className="wechat-file-info">
            <span className="wechat-file-name">{attachment.title || '文件'}</span>
            {attachment.fullSize ? <span className="wechat-file-size">{formatFileSize(attachment.fullSize)}</span> : null}
          </div>
          <FileTypeIcon fileName={attachment.title || attachment.dataFormat} />
        </div>
        <div className="wechat-redpacket-bottom wechat-file-bottom">
          <img src={wechatLogoUrl} alt="" className="wechat-file-logo" />
          <span>微信电脑版</span>
        </div>
      </div>
    )
  }
  if (attachment.renderType === 'chatHistory') {
    return (
      <button type="button" className="wechat-chat-history-card wechat-special-card msg-radius" onClick={() => onOpenHistory(item)}>
        <div className="wechat-chat-history-body">
          <div className="wechat-chat-history-title">{attachment.title || item.title || '聊天记录'}</div>
        </div>
        <div className="wechat-chat-history-bottom"><span>聊天记录</span></div>
      </button>
    )
  }
  if (attachment.renderType === 'link' || attachment.url || attachment.preview) {
    return (
      <LinkCard
        href={attachment.url || attachment.mediaUrl}
        heading={attachment.title || item.title}
        abstract={attachment.description}
        preview={attachment.preview}
        from={attachment.sourceName}
        fromAvatar={attachment.sourceAvatar}
        linkType={attachment.linkType}
      />
    )
  }
  const fallback = attachment.description || attachment.title || attachment.typeLabel
  if (!fallback) return null
  return <TextBubble>{renderTextWithEmoji(fallback)}</TextBubble>
}

function FavoriteContent({
  item,
  onOpenHistory
}: {
  item: FavoriteItem
  onOpenHistory: (item: FavoriteItem) => void
}) {
  if (item.type === 14) {
    const lines = historyPreviewLines(item)
    return (
      <button type="button" className="wechat-chat-history-card wechat-special-card msg-radius" onClick={() => onOpenHistory(item)}>
        <div className="wechat-chat-history-body">
          <div className="wechat-chat-history-title">{item.title || '聊天记录'}</div>
          {lines.length ? (
            <div className="wechat-chat-history-preview">
              {lines.map((line, index) => (
                <div key={`${favoriteKey(item)}-line-${index}`} className="wechat-chat-history-line">{line}</div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="wechat-chat-history-bottom"><span>聊天记录</span></div>
      </button>
    )
  }

  return (
    <div className="favorite-content-stack">
      {item.textBlocks.map((block, index) => (
        <TextBubble key={`${favoriteKey(item)}-text-${index}`}>{renderTextWithEmoji(block)}</TextBubble>
      ))}
      {item.attachments.map((attachment, index) => (
        <AttachmentCard
          key={`${favoriteKey(item)}-att-${attachment.dataId || index}`}
          item={item}
          attachment={attachment}
          onOpenHistory={onOpenHistory}
        />
      ))}
      {!item.textBlocks.length && !item.attachments.length ? (
        <TextBubble>{item.summary || item.title || item.typeLabel}</TextBubble>
      ) : null}
    </div>
  )
}

function FavoritesPage() {
  const navigate = useNavigate()
  const setCurrentSession = useChatStore((state) => state.setCurrentSession)
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('0')
  const [items, setItems] = useState<FavoriteItem[]>([])
  const [total, setTotal] = useState(0)
  const [databaseTotal, setDatabaseTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [tags, setTags] = useState<Array<{ localId: number; name: string }>>([])
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({})
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
      const result = await window.electronAPI.favorites.list({
        q: debouncedKeyword,
        kind: kindFilter,
        tagId: Number(tagFilter || 0),
        limit: PAGE_SIZE,
        offset: append ? itemsLengthRef.current : 0
      })
      if (requestId !== requestIdRef.current) return
      if (!result.success) {
        if (!append) {
          setItems([])
          setTotal(0)
          setHasMore(false)
          setDatabaseTotal(0)
        }
        setError(result.error || '加载收藏失败')
        return
      }
      const next = Array.isArray(result.items) ? result.items : []
      setItems(append ? (prev) => [...prev, ...next] : next)
      setTotal(Number(result.total || 0))
      setDatabaseTotal(Number(result.databaseTotal || 0))
      setHasMore(!!result.hasMore)
      setTags(Array.isArray(result.tags) ? result.tags : [])
      setTypeCounts(result.typeCounts && typeof result.typeCounts === 'object' ? result.typeCounts : {})
    } catch (loadError) {
      if (requestId === requestIdRef.current && !append) {
        setItems([])
        setError(String(loadError))
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [debouncedKeyword, kindFilter, tagFilter])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const typeOptions = useMemo(() => {
    const rows = Object.entries(typeCounts)
      .map(([value, count]) => ({
        value,
        count: Number(count || 0),
        ...(TYPE_META[Number(value)] || { label: `类型 ${value}`, icon: Bookmark })
      }))
      .filter((item) => item.count > 0)
      .sort((a, b) => Number(a.value) - Number(b.value))
    return [{ label: '全部', value: 'all', icon: Layers, count: databaseTotal }, ...rows]
  }, [typeCounts, databaseTotal])

  const openSourceChat = (item: FavoriteItem) => {
    const username = sourceChatUsername(item)
    if (!username) return
    setCurrentSession(username)
    navigate('/chat')
  }

  const openHistory = (item: FavoriteItem) => {
    const username = sourceChatUsername(item) || '__favorites__'
    const recordList = (item.chatRecordList || []) as ChatRecordItem[]
    if (!recordList.length) return
    void window.electronAPI.window.openChatHistoryPayloadWindow({
      sessionId: username,
      title: item.title || '聊天记录',
      recordList
    })
  }

  const handleExport = async (format: 'json' | 'csv') => {
    try {
      setExporting(true)
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const separator = downloadsPath && downloadsPath.includes('\\') ? '\\' : '/'
      const suggestedName = `wechat_favorites_${Date.now()}.${format}`
      const defaultPath = downloadsPath ? `${downloadsPath}${separator}${suggestedName}` : suggestedName
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: format === 'csv' ? '导出收藏 CSV' : '导出收藏 JSON',
        defaultPath,
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
      })
      if (saveResult.canceled || !saveResult.filePath) return
      const result = await window.electronAPI.favorites.export({
        filePath: saveResult.filePath,
        format,
        q: debouncedKeyword,
        kind: kindFilter,
        tagId: Number(tagFilter || 0)
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

  return (
    <div className="records-page records-page--favorites">
      <div className="records-page__scroll">
        <main className="records-page__frame">
          <header className="records-masthead">
            <div className="records-masthead__identity">
              <div className="records-masthead__title-group">
                <h1>收藏</h1>
                <span className="records-masthead__count">共<strong>{databaseTotal.toLocaleString()}</strong>条收藏</span>
              </div>
            </div>
            <div className="records-masthead__actions">
              <label className="records-search">
                <Search size={14} />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索正文、标题或来源"
                  type="search"
                  autoComplete="off"
                />
                {keyword ? (
                  <button type="button" className="records-search__clear" onClick={() => setKeyword('')} aria-label="清空搜索">
                    <X size={12} />
                  </button>
                ) : null}
              </label>
              <button type="button" className="records-icon-button" title="导出收藏" disabled={exporting} onClick={() => { void handleExport('csv') }}>
                <Download size={15} />
              </button>
              <button type="button" className="records-icon-button" title={loading ? '正在刷新' : '刷新收藏'} disabled={loading} onClick={() => { void loadItems() }}>
                <RefreshCw size={15} className={loading ? 'spinning' : ''} />
              </button>
            </div>
          </header>

          <section className="records-body favorites-chat" aria-label="收藏消息列表">
            <div className="favorites-toolbar">
              <div className="favorites-types" role="group" aria-label="收藏类型">
                {typeOptions.map((option) => {
                  const Icon = option.icon
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={kindFilter === option.value ? 'is-active' : ''}
                      aria-pressed={kindFilter === option.value}
                      onClick={() => setKindFilter(option.value)}
                    >
                      <Icon size={13} />
                      <span>{option.label}</span>
                      <span className="favorites-types__count">{option.count.toLocaleString()}</span>
                    </button>
                  )
                })}
              </div>
              <label className={`favorites-tag-filter ${tags.length ? '' : 'is-disabled'}`}>
                <Tag size={12} />
                <select
                  value={tagFilter}
                  disabled={!tags.length}
                  onChange={(event) => setTagFilter(event.target.value)}
                  aria-label="按收藏标签筛选"
                >
                  <option value="0">全部标签</option>
                  {tags.map((tag) => (
                    <option key={tag.localId} value={String(tag.localId)}>
                      {tag.name || `标签 ${tag.localId}`}
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} />
              </label>
            </div>

            {message ? <div className="favorites-toast">{message}</div> : null}

            {loading && items.length === 0 ? (
              <div className="records-state records-state--loading" role="status">
                <div className="records-state__inner">
                  <span className="records-state__icon"><Loader2 size={18} className="spinning" /></span>
                  <div className="records-state__title">正在加载收藏</div>
                  <div className="records-state__text">正在读取实时收藏库</div>
                </div>
              </div>
            ) : error ? (
              <div className="records-state records-state--error">
                <div className="records-state__inner">
                  <span className="records-state__icon"><Bookmark size={16} /></span>
                  <div className="records-state__title">加载失败</div>
                  <div className="records-state__text">{error}</div>
                  <button type="button" className="records-more" onClick={() => { void loadItems() }}>重试</button>
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="records-state">
                <div className="records-state__inner">
                  <span className="records-state__icon"><Bookmark size={16} /></span>
                  <div className="records-state__title">暂无收藏</div>
                  <div className="records-state__text">当前筛选条件下没有收藏内容</div>
                </div>
              </div>
            ) : (
              <div className="favorites-message-list">
                {items.map((item) => {
                  const key = favoriteKey(item)
                  const name = sourceDisplayName(item)
                  const canOpen = Boolean(sourceChatUsername(item))
                  return (
                    <article key={key} className="favorite-message-row">
                      <FavoriteAvatar item={item} canOpen={canOpen} onOpen={() => openSourceChat(item)} />
                      <div className="favorite-message-body">
                        <div className="favorite-message-head">
                          <div className="favorite-sender-line">
                            <strong>{name}</strong>
                            {sourceContextName(item) ? <span>来自 {sourceContextName(item)}</span> : null}
                          </div>
                          <time>{item.updateTimeText || '时间未记录'}</time>
                        </div>
                        <FavoriteContent item={item} onOpenHistory={openHistory} />
                      </div>
                    </article>
                  )
                })}
                {hasMore ? (
                  <button
                    type="button"
                    className="records-more"
                    disabled={loading}
                    onClick={() => { void loadItems({ append: true }) }}
                  >
                    {loading ? '正在载入' : `继续载入 ${items.length} / ${total}`}
                  </button>
                ) : null}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

export default FavoritesPage
