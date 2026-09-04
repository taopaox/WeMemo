export type BrowserResult<T> = { success: boolean; data?: T; error?: string }

export interface DatabaseCatalog {
  source: { account: string; dbRoot: string }
  databases: { name: string; relativePath: string; kind: string; size: number }[]
}

export interface DatabaseColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: number
  defaultValue: unknown
}

export interface BrowseTableRequest {
  database: string
  table: string
  offset?: number
  limit?: number
  search?: string
  sortColumn?: string
  sortDirection?: 'asc' | 'desc'
}

export interface DatabaseTablePage {
  columns: DatabaseColumn[]
  rows: Record<string, unknown>[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface DatabaseBrowserAPI {
  inspect: (options?: { forceRefresh?: boolean }) => Promise<BrowserResult<DatabaseCatalog>>
  tables: (database: string) => Promise<BrowserResult<string[]>>
  readTable: (request: BrowseTableRequest) => Promise<BrowserResult<DatabaseTablePage>>
}
