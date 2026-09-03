import { BrowserWindow } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

type DatabaseBrowserProgress = {
  phase: 'connecting' | 'databases' | 'tables' | 'resources' | 'done' | 'failed'
  message: string
  current?: number
  total?: number
  detail?: string
}

type DatabaseTableOverview = {
  name: string
  rows: number | null
}

type DatabaseOverview = {
  name: string
  relativePath: string
  kind: string
  size: number
  tables: DatabaseTableOverview[]
}

export type DatabaseBrowserOverview = {
  generatedAt: string
  source: {
    account: string
    dbRoot: string
  }
  summary: {
    databaseCount: number
    tableCount: number
    rowCount: number
    resourceCount: number
  }
  resources: {
    images: number
    videos: number
    files: number
  }
  databases: DatabaseOverview[]
  unreadableTableCount: number
}

type InspectResult = {
  success: boolean
  data?: DatabaseBrowserOverview
  error?: string
}

const CACHE_TTL_MS = 60_000

function emitProgress(progress: DatabaseBrowserProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('database-browser:progress', progress)
  }
}

function toRelativePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/')
}

function quoteIdentifier(value: string): string {
  return `"${String(value || '').replace(/"/g, '""')}"`
}

function firstNumericValue(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null
  for (const value of Object.values(row)) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric))
  }
  return null
}

export class DatabaseBrowserService {
  private configService = new ConfigService()
  private cached: { at: number; data: DatabaseBrowserOverview } | null = null
  private activeInspection: Promise<InspectResult> | null = null

  private async walkFiles(
    root: string,
    matcher: (filePath: string, fileName: string) => boolean,
    state = { visited: 0 }
  ): Promise<string[]> {
    if (!root || !existsSync(root)) return []
    const files: string[] = []
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return files
    }

    for (const entry of entries) {
      const fullPath = join(root, entry.name)
      if (entry.isDirectory()) {
        files.push(...await this.walkFiles(fullPath, matcher, state))
      } else if (entry.isFile() && matcher(fullPath, entry.name)) {
        files.push(fullPath)
      }
      state.visited += 1
      if (state.visited % 400 === 0) {
        await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 0))
      }
    }
    return files
  }

  private classifyDatabase(relativePath: string): { label: string; queryKind: string } {
    const normalized = `/${relativePath.toLowerCase().replace(/\\/g, '/')}/`
    if (normalized.includes('/session/')) return { label: 'session', queryKind: 'session' }
    if (normalized.includes('/contact/')) return { label: 'contact', queryKind: 'contact' }
    if (normalized.includes('/emoticon/') || normalized.includes('/emotion/')) return { label: 'emoticon', queryKind: 'emoticon' }
    if (normalized.includes('/sns/')) return { label: 'sns', queryKind: 'sns' }
    if (normalized.includes('/hardlink/')) return { label: 'hardlink', queryKind: 'hardlink' }
    if (normalized.includes('/media/')) return { label: 'media', queryKind: 'media' }
    if (normalized.includes('/message/')) return { label: 'message', queryKind: 'message' }
    const folder = relativePath.split('/').filter(Boolean)[0]
    return { label: folder || 'database', queryKind: 'message' }
  }

  private async listTables(queryKind: string, dbPath: string): Promise<string[]> {
    const listed = await wcdbService.listTables(queryKind, dbPath).catch(() => null)
    if (listed?.success && Array.isArray(listed.tables)) {
      return Array.from(new Set(listed.tables.map(item => String(item || '').trim()).filter(Boolean))).sort()
    }

    const fallback = await wcdbService.execQuery(
      'message',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).catch(() => null)
    if (!fallback?.success || !Array.isArray(fallback.rows)) return []
    return Array.from(new Set(fallback.rows
      .map(row => String(row?.name || row?.NAME || '').trim())
      .filter(Boolean))).sort()
  }

  private async countTableRows(queryKind: string, dbPath: string, tableName: string): Promise<number | null> {
    const sql = `SELECT COUNT(1) AS row_count FROM ${quoteIdentifier(tableName)}`
    const primary = await wcdbService.execQuery(queryKind, dbPath, sql).catch(() => null)
    if (primary?.success && Array.isArray(primary.rows)) return firstNumericValue(primary.rows[0])
    if (queryKind === 'message') return null
    const fallback = await wcdbService.execQuery('message', dbPath, sql).catch(() => null)
    return fallback?.success && Array.isArray(fallback.rows) ? firstNumericValue(fallback.rows[0]) : null
  }

  private async countResources(accountDir: string): Promise<{ images: number; videos: number; files: number }> {
    const imageRoot = join(accountDir, 'msg', 'attach')
    const videoRoots = [join(accountDir, 'msg', 'video'), join(accountDir, 'FileStorage', 'Video')]
    const fileRoots = [join(accountDir, 'FileStorage', 'File'), join(accountDir, 'msg', 'file')]
    const [imageGroups, videoGroups, fileGroups] = await Promise.all([
      Promise.all([imageRoot].map(root => this.walkFiles(root, (_path, name) => name.toLowerCase().endsWith('.dat')))),
      Promise.all(videoRoots.map(root => this.walkFiles(root, () => true))),
      Promise.all(fileRoots.map(root => this.walkFiles(root, () => true)))
    ])
    return {
      images: new Set(imageGroups.flat()).size,
      videos: new Set(videoGroups.flat()).size,
      files: new Set(fileGroups.flat()).size
    }
  }

  private async performInspection(): Promise<InspectResult> {
    try {
      emitProgress({ phase: 'connecting', message: '正在连接原始数据库' })
      const connected = await chatService.connect()
      if (!connected.success) return { success: false, error: connected.error || '数据库连接失败' }

      const dbRoot = String(this.configService.get('dbPath') || '').trim()
      const wxid = String(this.configService.getMyWxidCleaned() || '').trim()
      if (!dbRoot || !wxid) return { success: false, error: '请先配置数据库路径和微信账号' }
      const accountDir = this.configService.getAccountDir(dbRoot, wxid)
      if (!accountDir) return { success: false, error: '未找到当前微信账号目录' }
      const dbStorage = join(accountDir, 'db_storage')
      if (!existsSync(dbStorage)) return { success: false, error: '未找到 db_storage 目录' }

      emitProgress({ phase: 'databases', message: '正在发现数据库文件', detail: dbStorage })
      const databaseFiles = await this.walkFiles(dbStorage, (_path, name) => name.toLowerCase().endsWith('.db'))
      const externalSnsDb = join(accountDir, 'sns', 'sns.db')
      if (existsSync(externalSnsDb)) databaseFiles.push(externalSnsDb)
      const uniqueDatabaseFiles = Array.from(new Set(databaseFiles)).sort()
      const databases: DatabaseOverview[] = []
      let rowCount = 0
      let tableCount = 0
      let unreadableTableCount = 0

      for (let dbIndex = 0; dbIndex < uniqueDatabaseFiles.length; dbIndex += 1) {
        const dbPath = uniqueDatabaseFiles[dbIndex]
        const relativePath = toRelativePath(accountDir, dbPath)
        const classification = this.classifyDatabase(relativePath)
        emitProgress({
          phase: 'tables',
          message: '正在统计数据库与表',
          current: dbIndex + 1,
          total: uniqueDatabaseFiles.length,
          detail: relativePath
        })
        const tableNames = await this.listTables(classification.queryKind, dbPath)
        const tables: DatabaseTableOverview[] = []
        for (const tableName of tableNames) {
          const rows = await this.countTableRows(classification.queryKind, dbPath, tableName)
          tables.push({ name: tableName, rows })
          tableCount += 1
          if (rows === null) unreadableTableCount += 1
          else rowCount += rows
        }
        let size = 0
        try { size = statSync(dbPath).size } catch {}
        databases.push({
          name: basename(dbPath),
          relativePath,
          kind: classification.label,
          size,
          tables
        })
      }

      emitProgress({ phase: 'resources', message: '正在统计本地资源文件' })
      const resources = await this.countResources(accountDir)
      const data: DatabaseBrowserOverview = {
        generatedAt: new Date().toISOString(),
        source: { account: basename(accountDir), dbRoot },
        summary: {
          databaseCount: databases.length,
          tableCount,
          rowCount,
          resourceCount: resources.images + resources.videos + resources.files
        },
        resources,
        databases,
        unreadableTableCount
      }
      this.cached = { at: Date.now(), data }
      emitProgress({ phase: 'done', message: '数据库统计完成', current: databases.length, total: databases.length })
      return { success: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitProgress({ phase: 'failed', message })
      return { success: false, error: message }
    }
  }

  async inspect(forceRefresh = false): Promise<InspectResult> {
    if (!forceRefresh && this.cached && Date.now() - this.cached.at <= CACHE_TTL_MS) {
      return { success: true, data: this.cached.data }
    }
    if (this.activeInspection) return this.activeInspection
    this.activeInspection = this.performInspection().finally(() => {
      this.activeInspection = null
    })
    return this.activeInspection
  }
}

export const databaseBrowserService = new DatabaseBrowserService()
