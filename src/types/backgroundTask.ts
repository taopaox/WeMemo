export type BackgroundTaskSourcePage =
  | 'export'
  | 'chat'
  | 'analytics'
  | 'sns'
  | 'groupAnalytics'
  | 'annualReport'
  | 'other'

export type BackgroundTaskStatus =
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'canceled'

export type BackgroundTaskItemStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface BackgroundTaskItem {
  id: string
  name: string
  target?: string
  detail?: string
  error?: string
  status: BackgroundTaskItemStatus
  startedAt?: number
  finishedAt?: number
}

export type BackgroundTaskItemInput = Omit<BackgroundTaskItem, 'status'> & {
  status?: BackgroundTaskItemStatus
}

export interface BackgroundTaskRecord {
  id: string
  sourcePage: BackgroundTaskSourcePage
  title: string
  detail?: string
  progressText?: string
  cancelable: boolean
  resumable: boolean
  cancelRequested: boolean
  pauseRequested: boolean
  status: BackgroundTaskStatus
  startedAt: number
  updatedAt: number
  finishedAt?: number
  items?: BackgroundTaskItem[]
}

export interface BackgroundTaskInput {
  sourcePage: BackgroundTaskSourcePage
  title: string
  detail?: string
  progressText?: string
  cancelable?: boolean
  resumable?: boolean
  items?: BackgroundTaskItemInput[]
  onCancel?: () => void | Promise<void>
  onPause?: () => void | Promise<void>
  onResume?: () => void | Promise<void>
}

export interface BackgroundTaskUpdate {
  title?: string
  detail?: string
  progressText?: string
  status?: BackgroundTaskStatus
  cancelable?: boolean
}

export type BackgroundTaskItemUpdate = Partial<Omit<BackgroundTaskItem, 'id'>>
