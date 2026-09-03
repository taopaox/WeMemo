import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, File, Files, HardDrive, Image, RefreshCw, Rows3, Table2, Video } from 'lucide-react'
import './DatabaseBrowserPage.scss'

type Overview = NonNullable<Awaited<ReturnType<typeof window.electronAPI.databaseBrowser.inspect>>['data']>
type Progress = Parameters<Parameters<typeof window.electronAPI.databaseBrowser.onProgress>[0]>[0]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function DatabaseBrowserPage() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadOverview = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    setProgress({ phase: 'connecting', message: '正在连接原始数据库' })
    try {
      const result = await window.electronAPI.databaseBrowser.inspect({ forceRefresh })
      if (!result.success || !result.data) {
        setError(result.error || '读取数据库概况失败')
        return
      }
      setOverview(result.data)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const removeProgressListener = window.electronAPI.databaseBrowser.onProgress(setProgress)
    void loadOverview(false)
    return removeProgressListener
  }, [loadOverview])

  const percent = progress?.total && progress.total > 0
    ? Math.min(100, Math.round(((progress.current || 0) / progress.total) * 100))
    : 8

  const totals = overview?.summary || {
    databaseCount: 0,
    tableCount: 0,
    rowCount: 0,
    resourceCount: 0
  }

  const totalDatabaseSize = useMemo(
    () => (overview?.databases || []).reduce((sum, database) => sum + Number(database.size || 0), 0),
    [overview]
  )

  return (
    <div className="database-browser-page">
      <header className="database-browser-header">
        <div>
          <h1>数据库浏览器</h1>
          <p>只读查看当前微信账号的原始数据库概况</p>
        </div>
        <button
          className="database-browser-refresh"
          type="button"
          disabled={loading}
          onClick={() => void loadOverview(true)}
        >
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          <span>刷新</span>
        </button>
      </header>

      <section className="database-browser-summary" aria-label="数据库概况">
        <article>
          <Database size={19} />
          <span>数据库</span>
          <strong>{totals.databaseCount.toLocaleString()}</strong>
        </article>
        <article>
          <Table2 size={19} />
          <span>表</span>
          <strong>{totals.tableCount.toLocaleString()}</strong>
        </article>
        <article>
          <Rows3 size={19} />
          <span>行</span>
          <strong>{totals.rowCount.toLocaleString()}</strong>
        </article>
        <article>
          <Files size={19} />
          <span>资源</span>
          <strong>{totals.resourceCount.toLocaleString()}</strong>
        </article>
      </section>

      {(loading || error) && (
        <section className={`database-browser-status ${error ? 'error' : ''}`}>
          <div className="database-browser-status-icon">
            {error ? <Database size={21} /> : <RefreshCw size={21} className="spinning" />}
          </div>
          <div>
            <strong>{error || progress?.message || '正在读取数据库概况'}</strong>
            {!error && <span>{progress?.detail || '首次统计可能需要一些时间'}</span>}
            {!error && loading && (
              <div className="database-browser-progress">
                <i style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </section>
      )}

      {overview && (
        <>
          <section className="database-browser-source">
            <div>
              <span>当前账号</span>
              <strong>{overview.source.account}</strong>
            </div>
            <div>
              <span>数据库目录</span>
              <strong title={overview.source.dbRoot}>{overview.source.dbRoot}</strong>
            </div>
            <div>
              <span>数据库大小</span>
              <strong>{formatBytes(totalDatabaseSize)}</strong>
            </div>
          </section>

          <section className="database-browser-resources">
            <div className="database-browser-section-heading">
              <div>
                <h2>资源</h2>
                <p>按本地实际文件统计</p>
              </div>
            </div>
            <div className="database-browser-resource-grid">
              <div><Image size={17} /><span>图片</span><strong>{overview.resources.images.toLocaleString()}</strong></div>
              <div><Video size={17} /><span>视频</span><strong>{overview.resources.videos.toLocaleString()}</strong></div>
              <div><File size={17} /><span>文件</span><strong>{overview.resources.files.toLocaleString()}</strong></div>
            </div>
          </section>

          <section className="database-browser-databases">
            <div className="database-browser-section-heading">
              <div>
                <h2>数据库与表</h2>
                <p>展开数据库查看表名和行数</p>
              </div>
              {overview.unreadableTableCount > 0 && (
                <span className="database-browser-warning">
                  {overview.unreadableTableCount} 张表未能统计行数
                </span>
              )}
            </div>

            <div className="database-browser-list">
              {overview.databases.map((database) => {
                const databaseRows = database.tables.reduce(
                  (sum, table) => sum + (typeof table.rows === 'number' ? table.rows : 0),
                  0
                )
                return (
                  <details key={database.relativePath} className="database-browser-database">
                    <summary>
                      <span className="database-browser-db-icon"><HardDrive size={18} /></span>
                      <span className="database-browser-db-name">
                        <strong>{database.name}</strong>
                        <em>{database.relativePath}</em>
                      </span>
                      <span className="database-browser-db-kind">{database.kind}</span>
                      <span className="database-browser-db-stat">{database.tables.length} 表</span>
                      <span className="database-browser-db-stat">{databaseRows.toLocaleString()} 行</span>
                      <span className="database-browser-db-size">{formatBytes(database.size)}</span>
                    </summary>
                    <div className="database-browser-table-list">
                      <div className="database-browser-table-head">
                        <span>表名</span>
                        <span>行数</span>
                      </div>
                      {database.tables.length > 0 ? database.tables.map(table => (
                        <div className="database-browser-table-row" key={table.name}>
                          <span>{table.name}</span>
                          <strong>{table.rows === null ? '未读取' : table.rows.toLocaleString()}</strong>
                        </div>
                      )) : (
                        <div className="database-browser-empty">没有发现可读取的数据表</div>
                      )}
                    </div>
                  </details>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export default DatabaseBrowserPage
