import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Database, KeyRound, RefreshCw, Search, Table2, X } from 'lucide-react'
import type { BrowseTableRequest, DatabaseCatalog, DatabaseTablePage } from '../../shared/databaseBrowser'
import './DatabaseBrowserPage.scss'

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value === '' ? '(空字符串)' : value
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function DatabaseBrowserPage() {
  const [catalog, setCatalog] = useState<DatabaseCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [revision, setRevision] = useState(0)
  const [database, setDatabase] = useState('')
  const [tables, setTables] = useState<string[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState('')
  const [tableFilter, setTableFilter] = useState('')
  const [request, setRequest] = useState<BrowseTableRequest | null>(null)
  const [page, setPage] = useState<DatabaseTablePage | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [tab, setTab] = useState<'data' | 'schema'>('data')
  const [cell, setCell] = useState<{ column: string; value: unknown; row: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError('')
    setCatalog(null)
    setDatabase('')
    setRequest(null)
    window.electronAPI.databaseBrowser.inspect({ forceRefresh: revision > 0 }).then(result => {
      if (cancelled) return
      if (!result.success || !result.data) throw new Error(result.error || '无法加载数据库')
      setCatalog(result.data)
      setDatabase(result.data.databases[0]?.relativePath || '')
    }).catch(error => {
      if (!cancelled) setCatalogError(String(error.message || error))
    }).finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => { cancelled = true }
  }, [revision])

  useEffect(() => {
    let cancelled = false
    setTables([])
    setTablesError('')
    setRequest(null)
    setSearchInput('')
    setTableFilter('')
    if (!database) { setTablesLoading(false); return }
    setTablesLoading(true)
    window.electronAPI.databaseBrowser.tables(database).then(result => {
      if (cancelled) return
      if (!result.success || !result.data) throw new Error(result.error || '无法加载数据表')
      setTables(result.data)
      if (result.data.length) setRequest({ database, table: result.data[0], offset: 0, limit: 50 })
    }).catch(error => {
      if (!cancelled) setTablesError(String(error.message || error))
    }).finally(() => { if (!cancelled) setTablesLoading(false) })
    return () => { cancelled = true }
  }, [database])

  useEffect(() => {
    let cancelled = false
    setCell(null)
    setPage(null)
    setRowsError('')
    if (!request) { setRowsLoading(false); return }
    setRowsLoading(true)
    window.electronAPI.databaseBrowser.readTable(request).then(result => {
      if (cancelled) return
      if (!result.success || !result.data) throw new Error(result.error || '读取记录失败')
      setPage(result.data)
    }).catch(error => {
      if (!cancelled) setRowsError(String(error.message || error))
    }).finally(() => { if (!cancelled) setRowsLoading(false) })
    return () => { cancelled = true }
  }, [request])

  const visibleTables = useMemo(() => tables.filter(name => name.toLowerCase().includes(tableFilter.toLowerCase())), [tables, tableFilter])

  function selectTable(table: string) {
    setRequest({ database, table, offset: 0, limit: request?.limit || 50 })
    setSearchInput('')
    setTab('data')
  }

  function sort(column: string) {
    if (!request) return
    setRequest({ ...request, offset: 0, sortColumn: column, sortDirection: request.sortColumn === column && request.sortDirection !== 'desc' ? 'desc' : 'asc' })
  }

  return (
    <div className="database-browser-page">
      <header className="database-browser-header">
        <div>
          <h1>数据库浏览器 <span className="db-readonly">只读</span></h1>
          <p>选择数据表，浏览原始记录与字段结构</p>
        </div>
        <button type="button" disabled={catalogLoading} onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={16} className={catalogLoading ? 'spinning' : ''} />刷新数据库
        </button>
      </header>
      {catalogError && <div className="db-error" role="alert">{catalogError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div>}
      <div className="db-workspace">
        <aside className="db-sidebar" aria-label="数据库和表">
          <div className="db-sidebar-heading">
            <Database size={16} /><strong>数据库</strong>
            {catalog && <span>{catalog.databases.length}</span>}
          </div>
          {catalog && <div className="db-account" title={catalog.source.dbRoot}>{catalog.source.account}</div>}
          <div className="db-tree">
            {catalogLoading && <div className="db-hint" role="status">正在加载数据库…</div>}
            {!catalogLoading && catalog?.databases.length === 0 && <div className="db-hint">没有找到数据库</div>}
            {catalog?.databases.map(item => (
              <section key={item.relativePath}>
                <button className={database === item.relativePath ? 'db-database active' : 'db-database'}
                  aria-expanded={database === item.relativePath} title={item.relativePath}
                  onClick={() => { if (database !== item.relativePath) setDatabase(item.relativePath) }}>
                  {database === item.relativePath ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Database size={16} />
                  <span><strong>{item.name}</strong><small>{item.relativePath}</small></span>
                </button>
                {database === item.relativePath && (
                  <div className="db-tables">
                    {tablesLoading ? <div className="db-hint" role="status">正在读取表列表…</div> : tablesError ? (
                      <div className="db-error" role="alert">{tablesError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div>
                    ) : (
                      <>
                        <label className="db-table-search"><Search size={14} /><input aria-label="筛选表名" placeholder="筛选表名…" value={tableFilter} onChange={event => setTableFilter(event.target.value)} /></label>
                        {visibleTables.map(name => <button key={name} className={request?.table === name ? 'db-table active' : 'db-table'}
                          aria-current={request?.table === name ? 'true' : undefined} title={name} onClick={() => selectTable(name)}>
                          <Table2 size={14} /><span>{name}</span>
                        </button>)}
                        {!visibleTables.length && <div className="db-hint">{tables.length ? '没有匹配的数据表' : '该数据库没有数据表'}</div>}
                      </>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
        </aside>
        <main className="db-main" aria-label="表内容">
          {!request ? (
            <div className="db-placeholder"><Table2 size={36} /><h2>选择一张表开始浏览</h2><p>左侧展开数据库，点击表名查看实际记录。</p></div>
          ) : (
            <>
              <div className="db-table-heading"><div><small title={database}>{database}</small><h2 title={request.table}>{request.table}</h2></div>
                <button disabled={rowsLoading} aria-label="刷新当前表" title="刷新当前表" onClick={() => setRequest({ ...request })}><RefreshCw size={16} className={rowsLoading ? 'spinning' : ''} /></button>
              </div>
              <div className="db-tabs" role="tablist" aria-label="查看内容">
                <button role="tab" aria-selected={tab === 'data'} onClick={() => setTab('data')}>数据</button>
                <button role="tab" aria-selected={tab === 'schema'} onClick={() => setTab('schema')}>表结构</button>
              </div>
              {tab === 'data' && <form className="db-toolbar" onSubmit={event => { event.preventDefault(); setRequest({ ...request, offset: 0, search: searchInput }) }}>
                <label className="db-record-search"><Search size={16} /><input aria-label="搜索当前表的记录" placeholder="搜索当前表所有字段（回车查询）" maxLength={500} value={searchInput} onChange={event => setSearchInput(event.target.value)} /></label>
                <button type="submit" disabled={rowsLoading}>查询</button>
                {request.search && <button type="button" disabled={rowsLoading} onClick={() => { setSearchInput(''); setRequest({ ...request, offset: 0, search: '' }) }}>清除筛选</button>}
              </form>}
              {rowsError && <div className="db-error" role="alert">{rowsError}<button onClick={() => setRequest({ ...request })}>重试</button></div>}
              {rowsLoading && <div className="db-hint" role="status"><RefreshCw size={16} className="spinning" />正在读取记录…</div>}
              {!rowsLoading && !rowsError && page && (
                <div className="db-grid-scroll" role="tabpanel" tabIndex={0} aria-label={tab === 'data' ? '数据记录，可横向滚动' : '字段结构'}>
                  {tab === 'schema' ? (
                    <table className="db-grid db-schema"><thead><tr><th>字段名</th><th>类型</th><th>主键顺序</th><th>NOT NULL</th><th>默认值</th></tr></thead>
                      <tbody>{page.columns.map(column => <tr key={column.name}><td>{column.name}</td><td>{column.type || '未声明'}</td><td>{column.primaryKey || '—'}</td><td>{column.notNull ? '是' : '否'}</td><td><pre>{cellText(column.defaultValue)}</pre></td></tr>)}</tbody>
                    </table>
                  ) : (
                    <table className="db-grid"><thead><tr><th className="db-row-number">#</th>{page.columns.map(column => (
                      <th key={column.name} aria-sort={request.sortColumn === column.name ? request.sortDirection === 'desc' ? 'descending' : 'ascending' : 'none'}>
                        <button onClick={() => sort(column.name)} title={'按 ' + column.name + ' 排序'}>
                          {column.primaryKey > 0 && <KeyRound size={12} />}<span>{column.name}<small>{column.type || '未声明类型'}</small></span>
                          {request.sortColumn === column.name && (request.sortDirection === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />)}
                        </button>
                      </th>
                    ))}</tr></thead>
                    <tbody>{page.rows.map((row, index) => <tr key={page.offset + index}>
                      <td className="db-row-number">{page.offset + index + 1}</td>
                      {page.columns.map(column => <td key={column.name} className={row[column.name] == null ? 'db-null' : ''}>
                        <button className={cell?.column === column.name && cell.row === page.offset + index + 1 ? 'db-cell selected' : 'db-cell'}
                          aria-label={'查看第 ' + (page.offset + index + 1) + ' 行 ' + column.name + ' 的完整内容'}
                          onClick={() => setCell({ column: column.name, value: row[column.name], row: page.offset + index + 1 })}>
                          {cellText(row[column.name]).slice(0, 300)}
                        </button>
                      </td>)}
                    </tr>)}</tbody></table>
                  )}
                  {tab === 'data' && !page.rows.length && <div className="db-placeholder"><h2>{request.search ? '没有匹配的记录' : page.offset ? '本页没有记录' : '这是一张空表'}</h2><p>{request.search ? '试试其他关键词，或清除筛选。' : '仍可切换到「表结构」查看字段。'}</p></div>}
                </div>
              )}
              {cell && tab === 'data' && <section className="db-cell-detail" aria-label="单元格完整内容">
                <header><strong>第 {cell.row} 行 · {cell.column}</strong><button aria-label="关闭单元格详情" onClick={() => setCell(null)}><X size={16} /></button></header>
                <pre tabIndex={0}>{cellText(cell.value)}</pre>
              </section>}
              <footer className="db-pagination">
                <span>{page ? page.rows.length ? '第 ' + (page.offset + 1) + '–' + (page.offset + page.rows.length) + ' 条' : '0 条记录' : '—'}{request.search ? ' · 已筛选' : ''}</span>
                <span className="db-cell-tip">点击单元格查看完整内容</span>
                <label>每页 <select aria-label="每页记录数" value={request.limit || 50} disabled={rowsLoading} onChange={event => setRequest({ ...request, limit: Number(event.target.value), offset: 0 })}>
                  <option value={50}>50 条</option><option value={100}>100 条</option><option value={200}>200 条</option>
                </select></label>
                <button aria-label="上一页" disabled={rowsLoading || !request.offset} onClick={() => setRequest({ ...request, offset: Math.max(0, (request.offset || 0) - (request.limit || 50)) })}><ChevronLeft size={16} /></button>
                <span>第 {Math.floor((request.offset || 0) / (request.limit || 50)) + 1} 页</span>
                <button aria-label="下一页" disabled={rowsLoading || !page?.hasMore} onClick={() => setRequest({ ...request, offset: (request.offset || 0) + (request.limit || 50) })}><ChevronRight size={16} /></button>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default DatabaseBrowserPage
