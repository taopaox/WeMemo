import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  createWriteStream,
  openSync,
  writeSync,
  closeSync,
  rmSync
} from 'fs'
import { join } from 'path'
import * as https from 'https'
import * as http from 'http'
import { ConfigService } from './config'

type OfflineRecognizer = any

export type VoiceModelEngine = 'sensevoice' | 'whisper'

export type VoiceModelFileSpec = {
  key: 'model' | 'encoder' | 'decoder' | 'tokens'
  fileName: string
  urls: string[]
}

export type VoiceModelCatalogItem = {
  id: string
  name: string
  engine: VoiceModelEngine
  size: string
  sizeBytes: number
  speed: string
  quality: string
  description: string
  recommended?: boolean
  files: VoiceModelFileSpec[]
}

export type VoiceModelCard = VoiceModelCatalogItem & {
  downloaded: boolean
  selected: boolean
  deletable: boolean
  downloadable: boolean
  downloadStatus: 'idle' | 'running' | 'error'
  downloadPercent?: number
  downloadError?: string
  path?: string
}

export type VoiceModelsState = {
  success: boolean
  exists: boolean
  selectedModel: string
  modelsRoot: string
  modelPath?: string
  tokensPath?: string
  encoderPath?: string
  decoderPath?: string
  sizeBytes?: number
  models: VoiceModelCard[]
  error?: string
}

export type DownloadProgress = {
  modelId: string
  modelName: string
  downloadedBytes: number
  totalBytes?: number
  percent?: number
  speed?: number
}

type ResolvedModelPaths = {
  item: VoiceModelCatalogItem
  dir: string
  modelPath?: string
  encoderPath?: string
  decoderPath?: string
  tokensPath: string
}

const DEFAULT_MODEL_ID = 'sensevoice'

function modelscopeUrl(owner: string, repo: string, fileName: string): string {
  return `https://modelscope.cn/models/${owner}/${repo}/resolve/master/${fileName}`
}

function hfMirrorUrl(owner: string, repo: string, fileName: string): string {
  return `https://hf-mirror.com/${owner}/${repo}/resolve/main/${fileName}`
}

function hfUrl(owner: string, repo: string, fileName: string): string {
  return `https://huggingface.co/${owner}/${repo}/resolve/main/${fileName}`
}

function whisperFile(id: string, key: VoiceModelFileSpec['key'], fileName: string): VoiceModelFileSpec {
  const repo = `sherpa-onnx-whisper-${id}`
  return {
    key,
    fileName,
    urls: [
      modelscopeUrl('csukuangfj', repo, fileName),
      hfMirrorUrl('csukuangfj', repo, fileName),
      hfUrl('csukuangfj', repo, fileName)
    ]
  }
}

export const VOICE_MODEL_CATALOG: VoiceModelCatalogItem[] = [
  {
    id: 'sensevoice',
    name: 'SenseVoice Small',
    engine: 'sensevoice',
    size: '约 245 MB',
    sizeBytes: 245_000_000,
    speed: '快',
    quality: '中文最佳',
    description: '默认推荐。专为中文、粤语优化，同时支持英日韩。',
    recommended: true,
    files: [
      {
        key: 'model',
        fileName: 'model.int8.onnx',
        urls: [
          modelscopeUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'model.int8.onnx'),
          hfMirrorUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'model.int8.onnx'),
          hfUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'model.int8.onnx')
        ]
      },
      {
        key: 'tokens',
        fileName: 'tokens.txt',
        urls: [
          modelscopeUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'tokens.txt'),
          hfMirrorUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'tokens.txt'),
          hfUrl('pengzhendong', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'tokens.txt')
        ]
      }
    ]
  },
  {
    id: 'tiny',
    name: 'Tiny',
    engine: 'whisper',
    size: '约 103 MB',
    sizeBytes: 103_000_000,
    speed: '最快',
    quality: '基础',
    description: '适合快速预览和低配置设备。',
    files: [
      whisperFile('tiny', 'encoder', 'tiny-encoder.int8.onnx'),
      whisperFile('tiny', 'decoder', 'tiny-decoder.int8.onnx'),
      whisperFile('tiny', 'tokens', 'tiny-tokens.txt')
    ]
  },
  {
    id: 'base',
    name: 'Base',
    engine: 'whisper',
    size: '约 160 MB',
    sizeBytes: 160_000_000,
    speed: '很快',
    quality: '入门',
    description: '速度与基础准确率兼顾。',
    files: [
      whisperFile('base', 'encoder', 'base-encoder.int8.onnx'),
      whisperFile('base', 'decoder', 'base-decoder.int8.onnx'),
      whisperFile('base', 'tokens', 'base-tokens.txt')
    ]
  },
  {
    id: 'small',
    name: 'Small',
    engine: 'whisper',
    size: '约 374 MB',
    sizeBytes: 374_000_000,
    speed: '较快',
    quality: '良好',
    description: '日常中文聊天的轻量选择。',
    files: [
      whisperFile('small', 'encoder', 'small-encoder.int8.onnx'),
      whisperFile('small', 'decoder', 'small-decoder.int8.onnx'),
      whisperFile('small', 'tokens', 'small-tokens.txt')
    ]
  },
  {
    id: 'medium',
    name: 'Medium',
    engine: 'whisper',
    size: '约 945 MB',
    sizeBytes: 945_000_000,
    speed: '中等',
    quality: '较高',
    description: '兼顾准确率与资源占用，适合性能较好的设备。',
    files: [
      whisperFile('medium', 'encoder', 'medium-encoder.int8.onnx'),
      whisperFile('medium', 'decoder', 'medium-decoder.int8.onnx'),
      whisperFile('medium', 'tokens', 'medium-tokens.txt')
    ]
  },
  {
    id: 'large-v3',
    name: 'Large v3',
    engine: 'whisper',
    size: '约 1.6 GB',
    sizeBytes: 1_600_000_000,
    speed: '较慢',
    quality: '最高',
    description: '追求最高准确率，适合高性能设备。',
    files: [
      whisperFile('large-v3', 'encoder', 'large-v3-encoder.int8.onnx'),
      whisperFile('large-v3', 'decoder', 'large-v3-decoder.int8.onnx'),
      whisperFile('large-v3', 'tokens', 'large-v3-tokens.txt')
    ]
  }
]

const VOICE_MODEL_IDS = new Set(VOICE_MODEL_CATALOG.map((item) => item.id))

function getCatalogItem(id: string): VoiceModelCatalogItem | undefined {
  return VOICE_MODEL_CATALOG.find((item) => item.id === id)
}

export class VoiceTranscribeService {
  private configService = new ConfigService()
  private downloadTasks = new Map<string, Promise<{ success: boolean; path?: string; error?: string }>>()
  private cancelledDownloads = new Set<string>()
  private downloadProgress = new Map<string, DownloadProgress>()
  private downloadErrors = new Map<string, string>()
  private recognizer: OfflineRecognizer | null = null
  private transcribeQueueTail: Promise<void> = Promise.resolve()

  private buildTranscribeWorkerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const platformPkg = `sherpa-onnx-${platform}-${process.arch}`
    const candidates = [
      join(__dirname, '..', 'node_modules', platformPkg),
      join(__dirname, 'node_modules', platformPkg),
      join(process.cwd(), 'node_modules', platformPkg),
      process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', platformPkg) : ''
    ].filter((item): item is string => Boolean(item) && existsSync(item))

    if (process.platform === 'darwin') {
      const key = 'DYLD_LIBRARY_PATH'
      const existing = env[key] || ''
      const merged = [...candidates, ...existing.split(':').filter(Boolean)]
      env[key] = Array.from(new Set(merged)).join(':')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    } else if (process.platform === 'linux') {
      const key = 'LD_LIBRARY_PATH'
      const existing = env[key] || ''
      const merged = [...candidates, ...existing.split(':').filter(Boolean)]
      env[key] = Array.from(new Set(merged)).join(':')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    } else if (process.platform === 'win32') {
      const existing = env['PATH'] || ''
      const merged = [...candidates, ...existing.split(';').filter(Boolean)]
      env['PATH'] = Array.from(new Set(merged)).join(';')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    }

    return env
  }

  private resolveModelsRoot(): string {
    const configured = String(this.configService.get('whisperModelDir') || '').trim()
    if (configured) return configured
    return join(app.getPath('documents'), 'WeMemo', 'models')
  }

  private resolveModelDir(modelId: string): string {
    const configured = String(this.configService.get('whisperModelDir') || '').trim()
    if (
      configured
      && modelId === 'sensevoice'
      && existsSync(join(configured, 'model.int8.onnx'))
    ) {
      return configured
    }
    return join(this.resolveModelsRoot(), modelId)
  }

  private resolveModelPaths(item: VoiceModelCatalogItem): ResolvedModelPaths {
    const dir = this.resolveModelDir(item.id)
    const byKey = (key: VoiceModelFileSpec['key']) => {
      const spec = item.files.find((file) => file.key === key)
      return spec ? join(dir, spec.fileName) : undefined
    }
    return {
      item,
      dir,
      modelPath: byKey('model'),
      encoderPath: byKey('encoder'),
      decoderPath: byKey('decoder'),
      tokensPath: byKey('tokens') || join(dir, 'tokens.txt')
    }
  }

  private isModelDownloaded(item: VoiceModelCatalogItem): boolean {
    const paths = this.resolveModelPaths(item)
    return item.files.every((file) => existsSync(join(paths.dir, file.fileName)))
  }

  private readStoredModelId(): string {
    const stored = String(this.configService.get('whisperModelName') || '').trim()
    if (VOICE_MODEL_IDS.has(stored)) return stored
    return DEFAULT_MODEL_ID
  }

  private persistSelectedModel(modelId: string): void {
    this.configService.set('whisperModelName', modelId)
  }

  private resolveSelectedModelId(): string {
    const stored = this.readStoredModelId()
    const storedItem = getCatalogItem(stored)
    if (stored === 'base') {
      const baseDownloaded = Boolean(storedItem && this.isModelDownloaded(storedItem))
      if (!baseDownloaded) {
        this.persistSelectedModel(DEFAULT_MODEL_ID)
        return DEFAULT_MODEL_ID
      }
    }
    return storedItem ? stored : DEFAULT_MODEL_ID
  }

  private assertNotCancelled(modelId: string): void {
    if (this.cancelledDownloads.has(modelId)) {
      throw new Error('DOWNLOAD_CANCELLED')
    }
  }

  getSelectedModelId(): string {
    return this.resolveSelectedModelId()
  }

  getCatalog(): VoiceModelCatalogItem[] {
    return VOICE_MODEL_CATALOG
  }

  getModelStatus(modelId?: string): VoiceModelsState {
    try {
      const selectedModel = modelId && VOICE_MODEL_IDS.has(modelId)
        ? modelId
        : this.resolveSelectedModelId()
      const models = VOICE_MODEL_CATALOG.map((item) => {
        const downloaded = this.isModelDownloaded(item)
        const progress = this.downloadProgress.get(item.id)
        const downloadError = this.downloadErrors.get(item.id)
        const running = this.downloadTasks.has(item.id)
        return {
          ...item,
          downloaded,
          selected: item.id === selectedModel,
          deletable: downloaded || running,
          downloadable: !downloaded,
          downloadStatus: running ? 'running' : downloadError ? 'error' : 'idle',
          downloadPercent: progress?.percent,
          downloadError,
          path: this.resolveModelDir(item.id)
        } satisfies VoiceModelCard
      })
      const selected = models.find((item) => item.id === selectedModel) || models[0]
      const paths = selected ? this.resolveModelPaths(selected) : undefined
      return {
        success: true,
        exists: Boolean(selected?.downloaded),
        selectedModel,
        modelsRoot: this.resolveModelsRoot(),
        modelPath: paths?.modelPath || paths?.encoderPath,
        tokensPath: paths?.tokensPath,
        encoderPath: paths?.encoderPath,
        decoderPath: paths?.decoderPath,
        sizeBytes: selected?.downloaded
          ? selected.files.reduce((sum, file) => {
              const filePath = join(paths!.dir, file.fileName)
              return sum + (existsSync(filePath) ? statSync(filePath).size : 0)
            }, 0)
          : undefined,
        models
      }
    } catch (error) {
      return {
        success: false,
        exists: false,
        selectedModel: DEFAULT_MODEL_ID,
        modelsRoot: this.resolveModelsRoot(),
        models: [],
        error: String(error)
      }
    }
  }

  async selectModel(modelId: string): Promise<{ success: boolean; selectedModel?: string; error?: string }> {
    const item = getCatalogItem(modelId)
    if (!item) {
      return { success: false, error: `未知模型: ${modelId}` }
    }
    if (!this.isModelDownloaded(item)) {
      return { success: false, error: `${item.name} 尚未下载到本机` }
    }
    this.persistSelectedModel(item.id)
    return { success: true, selectedModel: item.id }
  }

  async deleteModel(modelId: string): Promise<{ success: boolean; selectedModel?: string; error?: string }> {
    const item = getCatalogItem(modelId)
    if (!item) {
      return { success: false, error: `未知模型: ${modelId}` }
    }

    this.cancelledDownloads.add(modelId)
    const pending = this.downloadTasks.get(modelId)
    if (pending) {
      await pending.catch(() => undefined)
    }

    const dir = this.resolveModelDir(item.id)
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch (error) {
      this.cancelledDownloads.delete(modelId)
      return { success: false, error: `删除失败: ${String(error)}` }
    }

    this.downloadProgress.delete(modelId)
    this.downloadErrors.delete(modelId)
    this.cancelledDownloads.delete(modelId)

    let selectedModel = this.resolveSelectedModelId()
    if (selectedModel === modelId) {
      const fallback = VOICE_MODEL_CATALOG.find((candidate) => (
        candidate.id !== modelId && this.isModelDownloaded(candidate)
      ))
      selectedModel = fallback?.id || DEFAULT_MODEL_ID
      this.persistSelectedModel(selectedModel)
    }

    return { success: true, selectedModel }
  }

  async downloadModel(
    modelIdOrProgress?: string | ((progress: DownloadProgress) => void),
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }> {
    const modelId = typeof modelIdOrProgress === 'string' ? modelIdOrProgress : undefined
    const progressCallback = typeof modelIdOrProgress === 'function' ? modelIdOrProgress : onProgress
    return this.downloadModelNow(modelId, progressCallback)
  }

  private async downloadModelNow(
    modelId: string | undefined,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }> {
    const targetId = modelId && VOICE_MODEL_IDS.has(modelId)
      ? modelId
      : this.resolveSelectedModelId()
    const item = getCatalogItem(targetId)
    if (!item) {
      return { success: false, error: `未知模型: ${targetId}` }
    }

    const pending = this.downloadTasks.get(item.id)
    if (pending) return pending

    this.cancelledDownloads.delete(item.id)
    this.downloadErrors.delete(item.id)

    const task = (async () => {
      try {
        const paths = this.resolveModelPaths(item)
        if (!existsSync(paths.dir)) {
          mkdirSync(paths.dir, { recursive: true })
        }

        const emit = (downloadedBytes: number, percent: number, speed?: number) => {
          const progress: DownloadProgress = {
            modelId: item.id,
            modelName: item.name,
            downloadedBytes,
            totalBytes: item.sizeBytes,
            percent,
            speed
          }
          this.downloadProgress.set(item.id, progress)
          onProgress?.(progress)
        }

        emit(0, 0)

        const weights = item.files.map((file) => (
          file.key === 'tokens' ? 0.08 : 1
        ))
        const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
        let completedWeight = 0

        for (let index = 0; index < item.files.length; index += 1) {
          this.assertNotCancelled(item.id)
          const file = item.files[index]
          const weight = weights[index]
          const targetPath = join(paths.dir, file.fileName)
          console.info(`[VoiceTranscribe] 开始下载 ${item.name} / ${file.fileName}`)
          await this.downloadWithFallback(
            file.urls,
            targetPath,
            file.fileName,
            (downloaded, total, speed) => {
              this.assertNotCancelled(item.id)
              const fileRatio = total ? downloaded / total : 0
              const percent = ((completedWeight + fileRatio * weight) / weightSum) * 100
              const downloadedBytes = Math.min(
                item.sizeBytes,
                Math.round((percent / 100) * item.sizeBytes)
              )
              emit(downloadedBytes, percent, speed)
            }
          )
          completedWeight += weight
        }

        this.assertNotCancelled(item.id)
        emit(item.sizeBytes, 100, 0)
        this.downloadProgress.delete(item.id)
        console.info(`[VoiceTranscribe] ${item.name} 下载完成`)

        const selected = this.resolveSelectedModelId()
        const selectedItem = getCatalogItem(selected)
        if (!selectedItem || !this.isModelDownloaded(selectedItem)) {
          this.persistSelectedModel(item.id)
        }

        return {
          success: true,
          modelPath: paths.modelPath || paths.encoderPath,
          tokensPath: paths.tokensPath
        }
      } catch (error) {
        const message = String(error)
        const cancelled = message.includes('DOWNLOAD_CANCELLED')
        const dir = this.resolveModelDir(item.id)
        try {
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true })
          }
        } catch { /* ignore cleanup errors */ }
        this.downloadProgress.delete(item.id)
        if (!cancelled) {
          this.downloadErrors.set(item.id, message)
        }
        return {
          success: false,
          error: cancelled ? '已停止下载并删除临时文件' : message
        }
      } finally {
        this.downloadTasks.delete(item.id)
        this.cancelledDownloads.delete(item.id)
      }
    })()

    this.downloadTasks.set(item.id, task)
    return task
  }

  async transcribeWavBuffer(
    wavData: Buffer,
    onPartial?: (text: string) => void,
    languages?: string[]
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return this.runInTranscribeQueue(() => this.transcribeWavBufferNow(wavData, onPartial, languages))
  }

  private async runInTranscribeQueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.transcribeQueueTail
    let release!: () => void
    this.transcribeQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private async transcribeWavBufferNow(
    wavData: Buffer,
    onPartial?: (text: string) => void,
    languages?: string[]
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return new Promise((resolve) => {
      try {
        const selectedId = this.resolveSelectedModelId()
        const item = getCatalogItem(selectedId)
        if (!item) {
          resolve({ success: false, error: '未找到可用的语音识别模型' })
          return
        }
        if (!this.isModelDownloaded(item)) {
          resolve({ success: false, error: '模型文件不存在，请先下载模型' })
          return
        }

        const paths = this.resolveModelPaths(item)
        let supportedLanguages = languages
        if (!supportedLanguages || supportedLanguages.length === 0) {
          supportedLanguages = this.configService.get('transcribeLanguages')
          if (!supportedLanguages || supportedLanguages.length === 0) {
            supportedLanguages = ['zh', 'yue']
          }
        }

        const { fork } = require('child_process')
        const workerPath = join(__dirname, 'transcribeWorker.js')

        const worker = fork(workerPath, [], {
          env: this.buildTranscribeWorkerEnv(),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced'
        })

        let settled = false
        let shutdownRequested = false
        let shutdownTimer: NodeJS.Timeout | null = null

        const clearShutdownTimer = () => {
          if (shutdownTimer) {
            clearTimeout(shutdownTimer)
            shutdownTimer = null
          }
        }

        const requestShutdown = () => {
          shutdownRequested = true
          try {
            if (worker.connected) {
              worker.disconnect()
            }
          } catch { /* ignore */ }

          shutdownTimer = setTimeout(() => {
            try {
              if (!worker.killed) {
                worker.kill('SIGTERM')
              }
            } catch { /* ignore */ }
          }, 1500)
        }

        const settle = (result: { success: boolean; transcript?: string; error?: string }, shutdown = true) => {
          if (settled) return
          settled = true
          if (shutdown) requestShutdown()
          resolve(result)
        }

        worker.send({
          engine: item.engine,
          modelPath: paths.modelPath,
          encoderPath: paths.encoderPath,
          decoderPath: paths.decoderPath,
          tokensPath: paths.tokensPath,
          wavData,
          sampleRate: 16000,
          languages: supportedLanguages
        }, (error: Error | null | undefined) => {
          if (error) {
            settle({ success: false, error: `发送转写任务失败: ${String(error)}` })
          }
        })

        worker.on('message', (msg: any) => {
          if (msg.type === 'partial') {
            onPartial?.(msg.text)
          } else if (msg.type === 'final') {
            settle({ success: true, transcript: String(msg.text || '') })
          } else if (msg.type === 'error') {
            console.error('[VoiceTranscribe] Worker 错误:', msg.error)
            settle({ success: false, error: String(msg.error || '转写进程返回未知错误') })
          }
        })

        worker.on('error', (err: Error) => {
          settle({ success: false, error: String(err) })
        })

        worker.on('exit', (code: number | null, signal: string | null) => {
          clearShutdownTimer()
          if (settled) return

          if (signal === 'SIGSEGV') {
            console.error(`[VoiceTranscribe] Worker 异常崩溃，信号: ${signal}。可能是由于底层 C++ 运行库在当前系统上发生段错误。`)
            settle({
              success: false,
              error: 'SEGFAULT_ERROR'
            }, false)
            return
          }

          if (signal) {
            const error = shutdownRequested
              ? '转写进程已结束'
              : `转写进程被系统终止: ${signal}`
            settle({ success: false, error }, false)
            return
          }

          if (code !== 0) {
            settle({ success: false, error: `Worker exited with code ${code}` }, false)
            return
          }

          settle({ success: false, error: '转写进程未返回结果' }, false)
        })
      } catch (error) {
        resolve({ success: false, error: String(error) })
      }
    })
  }

  private async downloadWithFallback(
    urls: string[],
    targetPath: string,
    fileName: string,
    onProgress?: (downloaded: number, total?: number, speed?: number) => void
  ): Promise<void> {
    let lastError: unknown
    for (const url of urls) {
      try {
        await this.downloadToFile(url, targetPath, fileName, onProgress)
        return
      } catch (error) {
        lastError = error
        console.warn(`[VoiceTranscribe] ${fileName} 下载失败，尝试备用源: ${url}`, error)
        try {
          if (existsSync(targetPath)) unlinkSync(targetPath)
        } catch { /* ignore */ }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || '下载失败'))
  }

  private async downloadToFile(
    url: string,
    targetPath: string,
    fileName: string,
    onProgress?: (downloaded: number, total?: number, speed?: number) => void
  ): Promise<void> {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath)
    }

    console.info(`[VoiceTranscribe] 准备下载 ${fileName}: ${url}`)

    let probeResult
    try {
      probeResult = await this.probeUrl(url)
    } catch (err) {
      console.warn(`[VoiceTranscribe] ${fileName} 探测失败，使用单线程`, err)
      return this.downloadSingleThread(url, targetPath, fileName, onProgress)
    }

    const { totalSize, acceptRanges, finalUrl } = probeResult

    if (totalSize < 2 * 1024 * 1024 || !acceptRanges) {
      return this.downloadSingleThread(finalUrl, targetPath, fileName, onProgress)
    }

    console.info(`[VoiceTranscribe] ${fileName} 开始多线程下载 (4 线程), 大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)

    const threadCount = 4
    const chunkSize = Math.ceil(totalSize / threadCount)
    const fd = openSync(targetPath, 'w')

    let downloadedTotal = 0
    let lastDownloaded = 0
    let lastTime = Date.now()
    let speed = 0

    const speedInterval = setInterval(() => {
      const now = Date.now()
      const duration = (now - lastTime) / 1000
      if (duration > 0) {
        speed = (downloadedTotal - lastDownloaded) / duration
        lastDownloaded = downloadedTotal
        lastTime = now
        onProgress?.(downloadedTotal, totalSize, speed)
      }
    }, 1000)

    try {
      const promises = []
      for (let i = 0; i < threadCount; i++) {
        const start = i * chunkSize
        const end = i === threadCount - 1 ? totalSize - 1 : (i + 1) * chunkSize - 1

        promises.push(this.downloadChunk(finalUrl, fd, start, end, (bytes) => {
          downloadedTotal += bytes
        }))
      }

      await Promise.all(promises)
      onProgress?.(totalSize, totalSize, 0)
      console.info(`[VoiceTranscribe] ${fileName} 多线程下载完成`)
    } catch (err) {
      console.error(`[VoiceTranscribe] ${fileName} 多线程下载失败:`, err)
      throw err
    } finally {
      clearInterval(speedInterval)
      closeSync(fd)
    }
  }

  private async probeUrl(url: string, remainingRedirects = 5): Promise<{ totalSize: number, acceptRanges: boolean, finalUrl: string }> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/',
          'Range': 'bytes=0-0'
        }
      }

      const req = protocol.get(url, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
          const location = res.headers.location
          if (location && remainingRedirects > 0) {
            const nextUrl = new URL(location, url).href
            this.probeUrl(nextUrl, remainingRedirects - 1).then(resolve).catch(reject)
            return
          }
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          reject(new Error(`Probe failed: HTTP ${res.statusCode}`))
          return
        }

        const contentRange = res.headers['content-range']
        let totalSize = 0
        if (contentRange) {
          const parts = contentRange.split('/')
          totalSize = parseInt(parts[parts.length - 1], 10)
        } else {
          totalSize = parseInt(res.headers['content-length'] || '0', 10)
        }

        const acceptRanges = res.headers['accept-ranges'] === 'bytes' || !!contentRange
        resolve({ totalSize, acceptRanges, finalUrl: url })
        res.destroy()
      })
      req.on('error', reject)
    })
  }

  private async downloadChunk(url: string, fd: number, start: number, end: number, onData: (bytes: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/',
          'Range': `bytes=${start}-${end}`
        }
      }

      const req = protocol.get(url, options, (res) => {
        if (res.statusCode !== 206) {
          reject(new Error(`Chunk download failed: HTTP ${res.statusCode}`))
          return
        }

        let currentOffset = start
        res.on('data', (chunk: Buffer) => {
          try {
            writeSync(fd, chunk, 0, chunk.length, currentOffset)
            currentOffset += chunk.length
            onData(chunk.length)
          } catch (err) {
            reject(err)
            res.destroy()
          }
        })

        res.on('end', () => resolve())
        res.on('error', reject)
      })
      req.on('error', reject)
    })
  }

  private async downloadSingleThread(
    url: string,
    targetPath: string,
    fileName: string,
    onProgress?: (downloaded: number, total?: number, speed?: number) => void,
    remainingRedirects = 5
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/'
        }
      }

      const request = protocol.get(url, options, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
          const location = response.headers.location
          if (location && remainingRedirects > 0) {
            const nextUrl = new URL(location, url).href
            this.downloadSingleThread(nextUrl, targetPath, fileName, onProgress, remainingRedirects - 1).then(resolve).catch(reject)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Fallback download failed: HTTP ${response.statusCode}`))
          return
        }

        const totalBytes = Number(response.headers['content-length'] || 0) || undefined
        let downloadedBytes = 0
        let lastDownloaded = 0
        let lastTime = Date.now()
        let speed = 0

        const speedInterval = setInterval(() => {
          const now = Date.now()
          const duration = (now - lastTime) / 1000
          if (duration > 0) {
            speed = (downloadedBytes - lastDownloaded) / duration
            lastDownloaded = downloadedBytes
            lastTime = now
            onProgress?.(downloadedBytes, totalBytes, speed)
          }
        }, 1000)

        const writer = createWriteStream(targetPath)
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length
        })

        writer.on('finish', () => {
          clearInterval(speedInterval)
          writer.close()
          resolve()
        })

        writer.on('error', (err) => {
          clearInterval(speedInterval)
          writer.destroy()
          reject(err)
        })

        response.on('error', (err) => {
          clearInterval(speedInterval)
          writer.destroy()
          reject(err)
        })

        response.pipe(writer)
      })
      request.on('error', reject)
    })
  }

  dispose() {
    if (this.recognizer) {
      this.recognizer = null
    }
  }
}

export const voiceTranscribeService = new VoiceTranscribeService()
