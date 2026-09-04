import { existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, join, relative, sep } from 'path'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import type { BrowserResult, BrowseTableRequest, DatabaseCatalog, DatabaseColumn, DatabaseTablePage } from '../../shared/databaseBrowser'

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"'
}

// Native WCDB does not bind parameters yet. Escape literals and validate identifiers;
// the renderer never supplies SQL.
function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

export class DatabaseBrowserService {
  private configService = new ConfigService()

  private async source() {
    const connected = await chatService.connect()
    if (!connected.success) throw new Error(connected.error || '数据库连接失败')
    const dbRoot = String(this.configService.get('dbPath') || '').trim()
    const wxid = String(this.configService.getMyWxidCleaned() || '').trim()
    if (!dbRoot || !wxid) throw new Error('请先配置数据库路径和微信账号')
    const directory = this.configService.getAccountDir(dbRoot, wxid)
    if (!directory) throw new Error('未找到当前微信账号目录')
    return { accountDir: realpathSync(directory), dbRoot }
  }

  private async walkFiles(root: string): Promise<string[]> {
    if (!existsSync(root)) return []
    const files: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) files.push(...await this.walkFiles(path))
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.db')) files.push(path)
    }
    return files
  }

  private classifyDatabase(path: string): string {
    const folders = path.toLowerCase().split('/')
    for (const kind of ['session', 'contact', 'emoticon', 'sns', 'hardlink', 'media', 'message']) {
      if (folders.includes(kind)) return kind
    }
    return folders.includes('emotion') ? 'emoticon' : 'message'
  }

  private async databaseTarget(database: string) {
    if (typeof database !== 'string' || !database || database.includes('\0')) throw new Error('无效的数据库路径')
    const { accountDir } = await this.source()
    const path = realpathSync(join(accountDir, database))
    const relativePath = relative(accountDir, path).split(sep).join('/')
    // Restrict access to current-account database storage and the known SNS database.
    if (relativePath !== database || (!relativePath.startsWith('db_storage/') && relativePath !== 'sns/sns.db') ||
      !path.toLowerCase().endsWith('.db') || !statSync(path).isFile()) {
      throw new Error('只能浏览当前账号目录中的数据库')
    }
    return { path, kind: this.classifyDatabase(relativePath) }
  }

  private async query(kind: string, path: string, sql: string): Promise<Record<string, unknown>[]> {
    let result = await wcdbService.execQuery(kind, path, sql)
    if (!result.success && kind !== 'message') result = await wcdbService.execQuery('message', path, sql)
    if (!result.success || !Array.isArray(result.rows)) throw new Error(result.error || '读取数据库失败')
    return result.rows
  }

  private async listTables(kind: string, path: string): Promise<string[]> {
    const listed = await wcdbService.listTables(kind, path).catch(() => null)
    if (listed?.success && Array.isArray(listed.tables)) return [...new Set(listed.tables)].sort()
    const rows = await this.query(kind, path, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return rows.map(row => String(row.name))
  }

  async inspect(_forceRefresh = false): Promise<BrowserResult<DatabaseCatalog>> {
    try {
      const { accountDir, dbRoot } = await this.source()
      const storage = join(accountDir, 'db_storage')
      if (!existsSync(storage)) throw new Error('未找到 db_storage 目录')
      const paths = await this.walkFiles(storage)
      const sns = join(accountDir, 'sns', 'sns.db')
      if (existsSync(sns)) paths.push(sns)
      const databases = [...new Set(paths)].sort().map(path => {
        const relativePath = relative(accountDir, path).split(sep).join('/')
        return { name: basename(path), relativePath, kind: this.classifyDatabase(relativePath), size: statSync(path).size }
      })
      return { success: true, data: { source: { account: basename(accountDir), dbRoot }, databases } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async tables(database: string): Promise<BrowserResult<string[]>> {
    try {
      const { path, kind } = await this.databaseTarget(database)
      return { success: true, data: await this.listTables(kind, path) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async readTable(request: BrowseTableRequest): Promise<BrowserResult<DatabaseTablePage>> {
    try {
      if (!request || typeof request.table !== 'string') throw new Error('请选择数据表')
      const { path, kind } = await this.databaseTarget(request.database)
      const tables = await this.listTables(kind, path)
      if (!tables.includes(request.table)) throw new Error('数据表不存在，请刷新列表')
      const table = quoteIdentifier(request.table)
      const metadata = await this.query(kind, path, 'PRAGMA table_info(' + table + ')')
      const columns: DatabaseColumn[] = metadata.map(row => ({
        name: String(row.name), type: String(row.type || ''), notNull: Number(row.notnull) === 1,
        primaryKey: Number(row.pk || 0), defaultValue: row.dflt_value ?? null
      }))
      if (!columns.length) throw new Error('无法读取表结构')
      const limit = request.limit ?? 50
      const offset = request.offset ?? 0
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('无效的分页参数（每页最多 200 条）')
      }
      const search = request.search ?? ''
      if (typeof search !== 'string' || search.length > 500 || search.includes('\0')) throw new Error('搜索词无效或超过 500 字')
      const where = search ? ' WHERE (' + columns.map(column =>
        'instr(lower(CAST(' + quoteIdentifier(column.name) + ' AS TEXT)), lower(' + quoteLiteral(search) + ')) > 0'
      ).join(' OR ') + ')' : ''
      if (request.sortColumn && !columns.some(column => column.name === request.sortColumn)) throw new Error('排序字段不存在')
      if (request.sortDirection && !['asc', 'desc'].includes(request.sortDirection)) throw new Error('排序方向无效')
      const primaryKeys = columns.filter(column => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey)
      const rowid = ['rowid', '_rowid_', 'oid'].find(name => !columns.some(column => column.name.toLowerCase() === name))
      const stableOrder = primaryKeys.length ? primaryKeys.map(column => quoteIdentifier(column.name)) :
        rowid ? [quoteIdentifier(rowid)] : columns.map(column => quoteIdentifier(column.name))
      const order = request.sortColumn
        ? [quoteIdentifier(request.sortColumn) + (request.sortDirection === 'desc' ? ' DESC' : ' ASC'), ...stableOrder]
        : stableOrder
      // One extra row indicates a next page, without a full-table COUNT(*) scan.
      const rows = await this.query(kind, path, 'SELECT * FROM ' + table + where + ' ORDER BY ' + order.join(', ') + ' LIMIT ' + (limit + 1) + ' OFFSET ' + offset)
      return { success: true, data: { columns, rows: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export const databaseBrowserService = new DatabaseBrowserService()
