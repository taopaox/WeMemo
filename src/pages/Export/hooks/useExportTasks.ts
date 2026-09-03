/**
 * ExportV2 — useExportTasks hook
 *
 * Manages the queue and state of manual export tasks.
 * Includes starting tasks via electronAPI, tracking progress, and aborting.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { ExportTask, ExportTaskPayload, TaskStatus } from '../types'
import { createEmptyProgress } from '../constants'
import { useExportTaskStore } from '../../../stores/exportTaskStore'
import { buildProgressPayloadSignature } from '../utils/progress'
import { resolvePerfStageByPhase, applyProgressToTaskPerformance } from '../utils/performance'
import { emitExportSessionStatus, onExportSessionStatusRequest } from '../../../services/exportBridge'
import { useAutomationStore } from './useAutomation'
import type { ExportProgress } from '../types'
import type { ExportAutomationTask } from '../../../types/exportAutomation'
import {
  finishBackgroundTask,
  getBackgroundTaskSnapshot,
  registerBackgroundTask,
  requestCancelBackgroundTask,
  setBackgroundTaskItems,
  updateBackgroundTask,
  updateBackgroundTaskItem
} from '../../../services/backgroundTaskMonitor'

export interface ExportTasksResult {
  tasks: ExportTask[]
  activeTasks: ExportTask[]
  completedTasks: ExportTask[]
  startTask: (payload: ExportTaskPayload) => void
  cancelTask: (taskId: string) => void
  clearCompletedTasks: () => void
}

const generateTaskId = () => `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`

const updateAutomationRunState = (
  automationTaskId: string | undefined,
  updater: (prev: ExportAutomationTask) => ExportAutomationTask
) => {
  if (!automationTaskId) return
  void useAutomationStore.getState().updateTask(automationTaskId, updater)
}

export function useExportTasks(): ExportTasksResult {
  const [tasks, setTasks] = useState<ExportTask[]>([])
  
  const tasksRef = useRef<ExportTask[]>([])
  const backgroundTaskIdsRef = useRef<Map<string, string>>(new Map())
  tasksRef.current = tasks

  const { setSessionStatus } = useExportTaskStore()

  const publishSessionStatus = useCallback(() => {
    const activeTasks = tasksRef.current.filter(t => t.status === 'running' || t.status === 'cancel_requested')
    const inProgressSessionIds = new Set<string>()
    activeTasks.forEach(task => {
      task.payload.sessionIds.forEach(id => inProgressSessionIds.add(id))
    })

    const payload = {
      activeTaskCount: activeTasks.length,
      inProgressSessionIds: Array.from(inProgressSessionIds)
    }

    setSessionStatus(payload)
    emitExportSessionStatus(payload)
  }, [setSessionStatus])

  // Track the ongoing tasks to update the global zustand store badge
  useEffect(() => {
    publishSessionStatus()
  }, [tasks, publishSessionStatus])

  useEffect(() => {
    const unsubscribe = onExportSessionStatusRequest(publishSessionStatus)
    publishSessionStatus()
    return unsubscribe
  }, [publishSessionStatus])

  const updateTask = useCallback((taskId: string, updater: (prev: ExportTask) => ExportTask) => {
    setTasks(prev => prev.map(t => t.id === taskId ? updater(t) : t))
  }, [])

  const startTask = useCallback((payload: ExportTaskPayload) => {
    const taskId = generateTaskId()
    const title = payload.sessionIds.length > 1
        ? `批量导出 ${payload.sessionIds.length} 个会话`
        : `导出 ${payload.sessionNames[0] || '会话'}`

    const newTask: ExportTask = {
      id: taskId,
      title,
      status: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
      payload,
      progress: createEmptyProgress()
    }

    setTasks(prev => [newTask, ...prev])

    const backgroundTaskId = registerBackgroundTask({
      sourcePage: 'export',
      title,
      detail: '正在准备导出任务...',
      progressText: `0 / ${payload.sessionIds.length}`,
      cancelable: true,
      resumable: false,
      items: payload.sessionIds.map((sessionId, index) => ({
        id: sessionId,
        name: payload.sessionNames[index] || sessionId,
        target: sessionId
      })),
      onCancel: async () => {
        await window.electronAPI.export.cancelTask(taskId)
      }
    })
    backgroundTaskIdsRef.current.set(taskId, backgroundTaskId)

    if (payload.source === 'automation') {
      updateAutomationRunState(payload.automationTaskId, (prev) => ({
        ...prev,
        updatedAt: Date.now(),
        runState: {
          ...(prev.runState || {}),
          lastRunStatus: 'running',
          lastStartedAt: Date.now(),
          lastSkipReason: undefined,
          lastError: undefined
        }
      }))
    }

    // Kick off via electron API
    const run = async () => {
      let progressUnsubscribe: (() => void) | null = null
      let lastProgressSig = ''
      
      try {
        // Subscribe to progress
        progressUnsubscribe = window.electronAPI.export.onProgress((progressPayload: ExportProgress) => {
          if ((progressPayload as any).taskId && (progressPayload as any).taskId !== taskId) return

          const sig = buildProgressPayloadSignature(progressPayload)
          if (sig === lastProgressSig) return
          lastProgressSig = sig

          const mirroredTaskId = backgroundTaskIdsRef.current.get(taskId)
          if (mirroredTaskId) {
            const phaseLabel = progressPayload.phaseLabel || progressPayload.phase || '正在导出'
            updateBackgroundTask(mirroredTaskId, {
              detail: progressPayload.currentSession
                ? `${progressPayload.currentSession}：${phaseLabel}`
                : phaseLabel,
              progressText: `${Math.max(0, Number(progressPayload.current) || 0)} / ${Math.max(0, Number(progressPayload.total) || payload.sessionIds.length)}`
            })
            const currentSessionId = String(progressPayload.currentSessionId || '').trim()
            if (currentSessionId) {
              updateBackgroundTaskItem(mirroredTaskId, currentSessionId, {
                status: progressPayload.phase === 'complete' ? 'completed' : 'processing',
                detail: phaseLabel,
                startedAt: getBackgroundTaskSnapshot()
                  .find(task => task.id === mirroredTaskId)?.items
                  ?.find(item => item.id === currentSessionId)?.startedAt || Date.now(),
                finishedAt: progressPayload.phase === 'complete' ? Date.now() : undefined
              })
            }
          }

          updateTask(taskId, (task) => {
            if (task.status !== 'running') return task

            const nextProgress = { ...task.progress, ...progressPayload }
            // The original expected performance from task or undefined. 
            // The signature is applyProgressToTaskPerformance(task: ExportTask, payload: ExportProgress, now: number)
            const nextPerf = applyProgressToTaskPerformance(task, progressPayload, Date.now())

            return {
              ...task,
              progress: nextProgress,
              performance: nextPerf
            }
          })
        })

        const frontendOptions = payload.options as any
        const electronOptions = { ...frontendOptions }
        if (frontendOptions?.useAllTime) {
          electronOptions.dateRange = null
        } else if (frontendOptions?.dateRange) {
          electronOptions.dateRange = {
            start: frontendOptions.dateRange.start.getTime(),
            end: frontendOptions.dateRange.end.getTime()
          }
        }

        const result = await window.electronAPI.export.exportSessions(
          payload.sessionIds,
          payload.outputDir,
          electronOptions,
          { taskId }
        )

        const mirroredTaskId = backgroundTaskIdsRef.current.get(taskId)
        if (mirroredTaskId) {
          const successIds = new Set(result?.successSessionIds || [])
          const failedIds = new Set(result?.failedSessionIds || [])
          const pendingIds = new Set(result?.pendingSessionIds || [])
          const mirroredTask = getBackgroundTaskSnapshot().find(task => task.id === mirroredTaskId)
          const finishedAt = Date.now()
          setBackgroundTaskItems(mirroredTaskId, (mirroredTask?.items || []).map(item => {
            if (failedIds.has(item.id)) {
              return {
                ...item,
                status: 'failed',
                detail: '导出失败',
                error: result?.failedSessionErrors?.[item.id] || result?.error || '导出失败',
                finishedAt
              }
            }
            if (successIds.has(item.id)) {
              const outputPath = result?.sessionOutputPaths?.[item.id]
              return {
                ...item,
                status: 'completed',
                detail: outputPath ? `已导出到 ${outputPath}` : '导出完成',
                error: undefined,
                finishedAt
              }
            }
            if (pendingIds.has(item.id) || result?.stopped || result?.paused) {
              return { ...item, status: 'pending', detail: '未处理' }
            }
            return item
          }))
          const failedCount = Math.max(0, Number(result?.failCount) || failedIds.size)
          const successCount = Math.max(0, Number(result?.successCount) || successIds.size)
          const finalStatus = result?.stopped ? 'canceled' : (failedCount > 0 || !result?.success ? 'failed' : 'completed')
          finishBackgroundTask(mirroredTaskId, finalStatus, {
            detail: result?.stopped
              ? `导出已停止：成功 ${successCount}，失败 ${failedCount}`
              : `导出完成：成功 ${successCount}，失败 ${failedCount}`,
            progressText: `成功 ${successCount} / 失败 ${failedCount}`
          })
        }

        updateTask(taskId, (task) => ({
          ...task,
          status: result?.success ? 'success' : 'error',
          finishedAt: Date.now(),
          error: result?.error || undefined,
          sessionOutputPaths: result?.sessionOutputPaths
        }))

        if (payload.source === 'automation') {
          const finishedAt = Date.now()
          updateAutomationRunState(payload.automationTaskId, (prev) => {
            const previousSuccessCount = Math.max(0, Math.floor(Number(prev.runState?.successCount || 0)))
            return {
              ...prev,
              updatedAt: finishedAt,
              runState: {
                ...(prev.runState || {}),
                lastRunStatus: result?.success ? 'success' : 'error',
                lastFinishedAt: finishedAt,
                lastSuccessAt: result?.success ? finishedAt : prev.runState?.lastSuccessAt,
                lastError: result?.success ? undefined : (result?.error || '导出失败'),
                successCount: result?.success ? previousSuccessCount + 1 : previousSuccessCount
              }
            }
          })
        }

      } catch (err: any) {
        console.error('[useExportTasks] Task failed:', err)
        const errorMessage = err.message || '未知错误'
        const mirroredTaskId = backgroundTaskIdsRef.current.get(taskId)
        if (mirroredTaskId) {
          const mirroredTask = getBackgroundTaskSnapshot().find(task => task.id === mirroredTaskId)
          const finishedAt = Date.now()
          setBackgroundTaskItems(mirroredTaskId, (mirroredTask?.items || []).map(item => (
            item.status === 'completed'
              ? item
              : { ...item, status: 'failed', detail: '导出任务异常', error: errorMessage, finishedAt }
          )))
          finishBackgroundTask(mirroredTaskId, 'failed', {
            detail: `导出失败：${errorMessage}`,
            progressText: '任务异常结束'
          })
        }
        updateTask(taskId, (task) => ({
          ...task,
          status: 'error',
          finishedAt: Date.now(),
          error: errorMessage
        }))
        if (payload.source === 'automation') {
          const finishedAt = Date.now()
          updateAutomationRunState(payload.automationTaskId, (prev) => ({
            ...prev,
            updatedAt: finishedAt,
            runState: {
              ...(prev.runState || {}),
              lastRunStatus: 'error',
              lastFinishedAt: finishedAt,
              lastError: errorMessage
            }
          }))
        }
      } finally {
        if (progressUnsubscribe) {
          progressUnsubscribe()
        }
        backgroundTaskIdsRef.current.delete(taskId)
      }
    }

    void run()
  }, [updateTask])

  const cancelTask = useCallback((taskId: string) => {
    updateTask(taskId, (task) => {
      if (task.status === 'running') {
        const backgroundTaskId = backgroundTaskIdsRef.current.get(taskId)
        if (backgroundTaskId) requestCancelBackgroundTask(backgroundTaskId)
        else window.electronAPI.export.cancelTask(taskId)
        return { ...task, status: 'cancel_requested' }
      }
      return task
    })
  }, [updateTask])

  const clearCompletedTasks = useCallback(() => {
    setTasks(prev => prev.filter(t => t.status === 'running' || t.status === 'cancel_requested'))
  }, [])

  const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'cancel_requested')
  const completedTasks = tasks.filter(t => t.status === 'success' || t.status === 'error')

  return {
    tasks,
    activeTasks,
    completedTasks,
    startTask,
    cancelTask,
    clearCompletedTasks
  }
}
