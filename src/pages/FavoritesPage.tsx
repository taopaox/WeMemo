import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Avatar } from '../components/Avatar'
import { useChatStore } from '../stores/chatStore'
import { displayNameOrFallback } from '../utils/displayName'
import { renderTextWithEmoji } from '../utils/renderTextWithEmoji'
import type { ChatRecordItem } from '../types/models'
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

function openExternal(url?: string) {
  const next = String(url || '').trim()
  if (!next) return
  if (window.electronAPI?.shell?.openExternal) {
    void window.electronAPI.shell.openExternal(next)
    return
  }
  window.open(next, '_blank')
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
          className="favorite-media favorite-media--video"
          onClick={() => {
            void window.electronAPI.window.openImageViewerWindow(src)
          }}
        >
          <img src={src} alt={alt} />
          <span className="favorite-media__play"><PlayCircle size={28} /></span>
        </button>
      )
    }
    return (
      <button
        type="button"
        className="favorite-media"
        onClick={() => {
          void window.electronAPI.window.openImageViewerWindow(src)
        }}
      >
        <img src={src} alt={alt} />
      </button>
    )
  }

  if (poster) {
    return (
      <button type="button" className="favorite-media" onClick={() => openExternal(poster)}>
        <img src={poster} alt={alt} />
      </button>
    )
  }

  return (
    <div className={`favorite-media-fallback ${failed ? 'is-failed' : ''}`}>
      {kind === 'video' ? <Video size={18} /> : <ImageIcon size={18} />}
      <span>{failed ? (kind === 'video' ? '视频未缓存' : '图片未缓存') : '正在加载'}</span>
    </div>
  )
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
      <div className="favorite-voice">
        <Mic size={16} />
        <span>语音{seconds ? ` ${seconds}″` : ''}</span>
      </div>
    )
  }
  if (attachment.renderType === 'location' && attachment.location) {
    const { latitude, longitude, poiname, label, address } = attachment.location
    const title = poiname || label || attachment.title || '位置'
    const desc = label || address || attachment.description
    return (
      <button
        type="button"
        className="favorite-location"
        onClick={() => {
          if (!latitude || !longitude) return
          openExternal(`https://uri.amap.com/marker?position=${longitude},${latitude}&name=${encodeURIComponent(title)}`)
        }}
      >
        <MapPin size={16} />
        <div>
          <strong>{title}</strong>
          {desc ? <span>{desc}</span> : null}
        </div>
      </button>
    )
  }
  if (attachment.renderType === 'file') {
    return (
      <div className="favorite-file">
        <FileText size={22} />
        <div>
          <strong>{attachment.title || '文件'}</strong>
          <span>{[attachment.dataFormat, formatFileSize(attachment.fullSize)].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
    )
  }
  if (attachment.renderType === 'chatHistory') {
    return (
      <button type="button" className="favorite-history" onClick={() => onOpenHistory(item)}>
        <MessageSquare size={16} />
        <div>
          <strong>{attachment.title || item.title || '聊天记录'}</strong>
          <span>{attachment.description || `共 ${item.itemCount || item.chatRecordList?.length || 0} 条`}</span>
        </div>
      </button>
    )
  }
  if (attachment.renderType === 'link' || attachment.url || attachment.preview) {
    const url = attachment.url || attachment.mediaUrl
    return (
      <button type="button" className="favorite-link" onClick={() => openExternal(url)}>
        {attachment.preview ? <img src={attachment.preview} alt="" /> : <Link2 size={18} />}
        <div>
          <strong>{attachment.title || item.title || attachment.typeLabel}</strong>
          {attachment.description ? <span>{attachment.description}</span> : null}
          {attachment.sourceName ? <em>{attachment.sourceName}</em> : null}
        </div>
      </button>
    )
  }
  const fallback = attachment.description || attachment.title || attachment.typeLabel
  if (!fallback) return null
  return <div className="favorite-text">{renderTextWithEmoji(fallback)}</div>
}

function FavoriteContent({
  item,
  onOpenHistory
}: {
  item: FavoriteItem
  onOpenHistory: (item: FavoriteItem) => void
}) {
  if (item.type === 14) {
    const preview = (item.chatRecordList || []).slice(0, 3)
    return (
      <button type="button" className="favorite-history favorite-history--stack" onClick={() => onOpenHistory(item)}>
        <strong>{item.title || '聊天记录'}</strong>
        {preview.length > 0 ? (
          <div className="favorite-history__list">
            {preview.map((record, index) => (
              <span key={`${record.sourcename}-${record.sourcetime}-${index}`}>
                {record.sourcename ? `${record.sourcename}: ` : ''}
                {record.datadesc || record.datatitle || record.chatRecordTitle || '[媒体消息]'}
              </span>
            ))}
          </div>
        ) : (
          <span>{item.summary || `共 ${item.itemCount} 条`}</span>
        )}
        <em>聊天记录</em>
      </button>
    )
  }

  return (
    <div className="favorite-content-stack">
      {item.textBlocks.map((block, index) => (
        <div key={`${favoriteKey(item)}-text-${index}`} className="favorite-text">
          {renderTextWithEmoji(block)}
        </div>
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
        <div className="favorite-text">{item.summary || item.title || item.typeLabel}</div>
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
    <div className="favorites-page">
      <header className="favorites-header">
        <div className="favorites-title-block">
          <div className="favorites-title-line">
            <Bookmark size={22} />
            <h2>收藏</h2>
          </div>
          <div className="favorites-stats-line">
            <span>共 {databaseTotal.toLocaleString()} 条收藏</span>
            {total !== databaseTotal ? <span>当前筛选 {total.toLocaleString()} 条</span> : null}
          </div>
        </div>
        <div className="favorites-header-actions">
          <label className="favorites-search">
            <Search size={15} />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索正文、标题或来源"
            />
            {keyword ? (
              <button type="button" onClick={() => setKeyword('')} aria-label="清空搜索">
                <X size={14} />
              </button>
            ) : null}
          </label>
          <button className="favorites-icon-btn" title="导出 CSV" disabled={exporting} onClick={() => { void handleExport('csv') }}>
            <Download size={16} />
          </button>
          <button className="favorites-icon-btn" title="刷新" disabled={loading} onClick={() => { void loadItems() }}>
            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </header>

      <div className="favorites-toolbar">
        <div className="favorites-kind-tabs" role="group" aria-label="收藏类型">
          {typeOptions.map((option) => {
            const Icon = option.icon
            return (
              <button
                key={option.value}
                type="button"
                className={kindFilter === option.value ? 'active' : ''}
                onClick={() => setKindFilter(option.value)}
              >
                <Icon size={14} />
                <span>{option.label}</span>
                <em>{option.count.toLocaleString()}</em>
              </button>
            )
          })}
        </div>
        <label className={`favorites-tag-filter ${tags.length ? '' : 'is-disabled'}`}>
          <Tag size={13} />
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
        </label>
      </div>

      {message ? <div className="favorites-toast">{message}</div> : null}

      <section className="favorites-body">
        {loading && items.length === 0 ? (
          <div className="favorites-state">
            <Loader2 size={22} className="spinning" />
            <strong>正在加载收藏</strong>
            <span>正在读取收藏库</span>
          </div>
        ) : error ? (
          <div className="favorites-state">
            <strong>加载失败</strong>
            <span>{error}</span>
            <button type="button" onClick={() => { void loadItems() }}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className="favorites-state">
            <Bookmark size={36} />
            <strong>暂无收藏</strong>
            <span>当前筛选条件下没有收藏内容</span>
          </div>
        ) : (
          <div className="favorites-list">
            {items.map((item) => {
              const key = favoriteKey(item)
              const name = sourceDisplayName(item)
              const canOpen = Boolean(sourceChatUsername(item))
              return (
                <article key={key} className="favorite-row">
                  <button
                    type="button"
                    className="favorite-avatar"
                    title={canOpen ? `打开${name}的会话` : name}
                    disabled={!canOpen}
                    onClick={() => openSourceChat(item)}
                  >
                    <Avatar src={sourceAvatar(item)} name={name} size={40} shape="rounded" />
                  </button>
                  <div className="favorite-row-body">
                    <div className="favorite-row-head">
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
                className="favorites-more"
                disabled={loading}
                onClick={() => { void loadItems({ append: true }) }}
              >
                {loading ? '正在载入' : `继续载入 ${items.length} / ${total}`}
                {!loading ? <ChevronDown size={14} /> : null}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

export default FavoritesPage
