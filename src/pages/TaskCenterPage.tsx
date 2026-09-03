import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  FileWarning,
  ListTodo,
  Loader2,
  PauseCircle,
  PlayCircle,
  StopCircle,
  Trash2,
  XCircle
} from 'lucide-react'
import type { BackgroundTaskItem, BackgroundTaskRecord, BackgroundTaskStatus } from '../types/backgroundTask'
import {
  clearSettledBackgroundTasks,
  requestCancelBackgroundTask,
  requestPauseBackgroundTask,
  requestResumeBackgroundTask,
  subscribeBackgroundTasks
} from '../services/backgroundTaskMonitor'
import { backgroundTaskSourceLabels, backgroundTaskStatusLabels } from './Export/constants'
import './TaskCenterPage.scss'

type TaskFilter = 'all' | 'active' | 'failed' | 'completed'

const ACTIVE_STATUSES = new Set<BackgroundTaskStatus>(['running', 'pause_requested', 'paused', 'cancel_requested'])
const SETTLED_STATUSES = new Set<BackgroundTaskStatus>(['completed', 'failed', 'canceled'])
const ITEM_PAGE_SIZE = 200

const parseProgress = (progressText?: string): { current: number; total: number; percent: number } | null => {
  const match = String(progressText || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/)
  if (!match) return null
  const current = Number(match[1].replace(/,/g, ''))
  const total = Number(match[2].replace(/,/g, ''))
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null
  return { current, total, percent: Math.max(0, Math.min(100, Math.round(current / total * 100))) }
}

const formatTime = (timestamp?: number): string => timestamp
  ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  : '—'

const formatDuration = (startedAt?: number, finishedAt?: number): string => {
  if (!startedAt) return '—'
  const durationMs = Math.max(0, (finishedAt || Date.now()) - startedAt)
  if (durationMs < 1000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

const itemStatusLabel: Record<BackgroundTaskItem['status'], string> = {
  pending: '等待中',
  processing: '处理中',
  completed: '成功',
  failed: '失败',
  skipped: '已跳过'
}

const TaskStatusIcon = ({ status }: { status: BackgroundTaskStatus }) => {
  if (status === 'running' || status === 'pause_requested' || status === 'cancel_requested') {
    return <Loader2 className="spin" size={15} />
  }
  if (status === 'completed') return <CheckCircle2 size={15} />
  if (status === 'paused') return <PauseCircle size={15} />
  return <XCircle size={15} />
}

const ItemStatusIcon = ({ status }: { status: BackgroundTaskItem['status'] }) => {
  if (status === 'processing') return <Loader2 className="spin" size={14} />
  if (status === 'completed') return <CheckCircle2 size={14} />
  if (status === 'failed') return <XCircle size={14} />
  if (status === 'skipped') return <Circle size={14} />
  return <Clock3 size={14} />
}

export default function TaskCenterPage() {
  const [tasks, setTasks] = useState<BackgroundTaskRecord[]>([])
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set())
  const [failuresOnlyTaskIds, setFailuresOnlyTaskIds] = useState<Set<string>>(new Set())
  const [itemLimits, setItemLimits] = useState<Record<string, number>>({})
  const autoExpandedFailureTaskIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => subscribeBackgroundTasks(setTasks), [])

  useEffect(() => {
    const taskIdsToExpand = tasks
      .filter(task => task.items?.some(item => item.status === 'failed'))
      .map(task => task.id)
      .filter(taskId => !autoExpandedFailureTaskIdsRef.current.has(taskId))
    if (taskIdsToExpand.length === 0) return
    taskIdsToExpand.forEach(taskId => autoExpandedFailureTaskIdsRef.current.add(taskId))
    setExpandedTaskIds(previous => new Set([...previous, ...taskIdsToExpand]))
    setFailuresOnlyTaskIds(previous => new Set([...previous, ...taskIdsToExpand]))
  }, [tasks])

  const counts = useMemo(() => ({
    all: tasks.length,
    active: tasks.filter(task => ACTIVE_STATUSES.has(task.status)).length,
    failed: tasks.filter(task => task.status === 'failed' || task.items?.some(item => item.status === 'failed')).length,
    completed: tasks.filter(task => task.status === 'completed').length
  }), [tasks])

  const visibleTasks = useMemo(() => tasks.filter(task => {
    if (filter === 'active') return ACTIVE_STATUSES.has(task.status)
    if (filter === 'failed') return task.status === 'failed' || Boolean(task.items?.some(item => item.status === 'failed'))
    if (filter === 'completed') return task.status === 'completed'
    return true
  }), [filter, tasks])

  const toggleExpanded = (taskId: string) => {
    setExpandedTaskIds(previous => {
      const next = new Set(previous)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleFailuresOnly = (taskId: string) => {
    setFailuresOnlyTaskIds(previous => {
      const next = new Set(previous)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
    setItemLimits(previous => ({ ...previous, [taskId]: ITEM_PAGE_SIZE }))
  }

  return (
    <div className="standalone-task-center">
      <header className="standalone-task-header">
        <div>
          <div className="eyebrow"><ListTodo size={15} /> 后台任务</div>
          <h1>任务中心</h1>
          <p>查看每个文件或消息的处理进度、失败位置和原始错误原因。</p>
        </div>
        {tasks.some(task => SETTLED_STATUSES.has(task.status)) && (
          <button className="task-clear-button" onClick={() => clearSettledBackgroundTasks()}>
            <Trash2 size={15} /> 清理已结束
          </button>
        )}
      </header>

      <div className="task-overview">
        {([
          ['all', '全部任务'],
          ['active', '进行中'],
          ['failed', '有失败项'],
          ['completed', '已完成']
        ] as Array<[TaskFilter, string]>).map(([value, label]) => (
          <button
            key={value}
            className={`task-overview-card ${filter === value ? 'active' : ''} filter-${value}`}
            onClick={() => setFilter(value)}
          >
            <span>{label}</span>
            <strong>{counts[value]}</strong>
          </button>
        ))}
      </div>

      {visibleTasks.length === 0 ? (
        <div className="task-center-empty">
          <ListTodo size={34} />
          <h2>{tasks.length === 0 ? '还没有任务' : '当前筛选下没有任务'}</h2>
          <p>语音转写、媒体解密、导出和数据分析任务会显示在这里。</p>
        </div>
      ) : (
        <div className="standalone-task-list">
          {visibleTasks.map(task => {
            const progress = parseProgress(task.progressText)
            const items = task.items || []
            const failedItems = items.filter(item => item.status === 'failed')
            const completedItems = items.filter(item => item.status === 'completed').length
            const processingItems = items.filter(item => item.status === 'processing').length
            const pendingItems = items.filter(item => item.status === 'pending').length
            const skippedItems = items.filter(item => item.status === 'skipped').length
            const failuresOnly = failuresOnlyTaskIds.has(task.id)
            const sortedItems = [...items]
              .filter(item => !failuresOnly || item.status === 'failed')
              .sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'))
            const itemLimit = itemLimits[task.id] || ITEM_PAGE_SIZE
            // 失败报告要完整可见；只看失败时不做截断。
            const displayedItems = failuresOnly ? sortedItems : sortedItems.slice(0, itemLimit)
            const isExpanded = expandedTaskIds.has(task.id)
            const sourceLabel = backgroundTaskSourceLabels[task.sourcePage] || '后台任务'

            return (
              <article key={task.id} className={`standalone-task-card status-${task.status}`}>
                <div className="standalone-task-card-main">
                  <button className="task-expand-button" onClick={() => toggleExpanded(task.id)} aria-label={isExpanded ? '收起详情' : '展开详情'}>
                    <ChevronDown size={18} className={isExpanded ? 'expanded' : ''} />
                  </button>
                  <div className="standalone-task-card-content">
                    <div className="standalone-task-title-row">
                      <h2>{task.title}</h2>
                      <span className="task-source-chip">{sourceLabel}</span>
                      <span className={`task-status-chip status-${task.status}`}>
                        <TaskStatusIcon status={task.status} />
                        {backgroundTaskStatusLabels[task.status]}
                      </span>
                    </div>
                    <div className="standalone-task-meta">
                      <span>开始 {formatTime(task.startedAt)}</span>
                      <span>耗时 {formatDuration(task.startedAt, task.finishedAt)}</span>
                      {items.length > 0 && <span>{items.length} 个处理对象</span>}
                    </div>
                    {task.detail && <p className="standalone-task-detail">{task.detail}</p>}
                    {progress && (
                      <div className="standalone-task-progress">
                        <div><span style={{ width: `${progress.percent}%` }} /></div>
                        <strong>{progress.current.toLocaleString()} / {progress.total.toLocaleString()} · {progress.percent}%</strong>
                      </div>
                    )}
                    {items.length > 0 && (
                      <div className="task-item-summary">
                        <span className="success">成功 {completedItems}</span>
                        <span className={failedItems.length > 0 ? 'failure' : ''}>失败 {failedItems.length}</span>
                        <span>处理中 {processingItems}</span>
                        <span>待处理 {pendingItems}</span>
                        {skippedItems > 0 && <span>已跳过 {skippedItems}</span>}
                      </div>
                    )}
                    {failedItems.length > 0 && !isExpanded && (
                      <div className="task-first-error">
                        <FileWarning size={14} />
                        共失败 {failedItems.length} 项，展开查看每一项的处理对象和错误原因
                      </div>
                    )}
                  </div>
                  <div className="standalone-task-actions">
                    {task.status === 'running' && task.resumable && (
                      <button onClick={() => requestPauseBackgroundTask(task.id)} title="暂停"><PauseCircle size={18} /></button>
                    )}
                    {task.status === 'paused' && task.resumable && (
                      <button onClick={() => requestResumeBackgroundTask(task.id)} title="继续"><PlayCircle size={18} /></button>
                    )}
                    {ACTIVE_STATUSES.has(task.status) && task.cancelable && (
                      <button className="danger" onClick={() => requestCancelBackgroundTask(task.id)} title="停止"><StopCircle size={18} /></button>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="task-detail-panel">
                    <div className="task-detail-toolbar">
                      <div>
                        <strong>处理明细</strong>
                        <span>失败项排在最前，保留原始错误信息</span>
                      </div>
                      {failedItems.length > 0 && (
                        <button className={failuresOnly ? 'active' : ''} onClick={() => toggleFailuresOnly(task.id)}>
                          {failuresOnly ? '显示全部' : `只看失败（${failedItems.length}）`}
                        </button>
                      )}
                    </div>
                    {items.length === 0 ? (
                      <div className="task-no-item-detail">该任务只上报了总体进度，没有单项处理记录。</div>
                    ) : (
                      <>
                        <div className="task-item-table">
                          <div className="task-item-table-head">
                            <span>处理对象</span><span>状态</span><span>处理结果 / 错误原因</span><span>耗时</span>
                          </div>
                          {displayedItems.map(item => (
                            <div key={item.id} className={`task-item-row status-${item.status}`}>
                              <div className="task-item-name">
                                <strong title={item.name}>{item.name}</strong>
                                {item.target && <code title={item.target}>{item.target}</code>}
                              </div>
                              <span className="task-item-status"><ItemStatusIcon status={item.status} /> {itemStatusLabel[item.status]}</span>
                              <div className="task-item-result">
                                {item.detail && <span>{item.detail}</span>}
                                {item.error && <strong>{item.error}</strong>}
                              </div>
                              <span className="task-item-duration">{formatDuration(item.startedAt, item.finishedAt)}</span>
                            </div>
                          ))}
                        </div>
                        {!failuresOnly && sortedItems.length > displayedItems.length && (
                          <button
                            className="task-load-more"
                            onClick={() => setItemLimits(previous => ({ ...previous, [task.id]: itemLimit + ITEM_PAGE_SIZE }))}
                          >
                            再显示 {Math.min(ITEM_PAGE_SIZE, sortedItems.length - displayedItems.length)} 条
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
