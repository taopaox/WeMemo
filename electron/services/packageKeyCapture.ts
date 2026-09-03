import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }

type JsonEvent =
  | { event: 'status'; message?: string; level?: number }
  | { event: 'result'; success?: boolean; db_key?: string; error?: string }

function packagesRoot(): string {
  const candidates: string[] = []
  if (typeof app !== 'undefined' && app?.isPackaged) {
    candidates.push(join(process.resourcesPath, 'packages'))
    candidates.push(join(process.resourcesPath, 'resources', 'packages'))
  }
  const cwd = process.cwd()
  candidates.push(join(cwd, 'packages'))
  try {
    candidates.push(join(app.getAppPath(), 'packages'))
  } catch {
    // app may not be ready in tests
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0]
}

function resolveCaptureScript(): { script: string; requirements?: string; platformLabel: string } {
  if (process.platform === 'darwin') {
    const script = join(packagesRoot(), 'wechat-key-mac', 'capture_key.py')
    return { script, platformLabel: 'macOS' }
  }
  if (process.platform === 'win32') {
    const dir = join(packagesRoot(), 'wechat-key-win')
    return {
      script: join(dir, 'capture_key.py'),
      requirements: join(dir, 'requirements.txt'),
      platformLabel: 'Windows'
    }
  }
  throw new Error('当前平台请继续使用原有密钥获取方式')
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function runPythonCheck(bin: string, prefixArgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...prefixArgs, '-c', 'import sys; print(sys.version_info[0])'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0 && out.trim().startsWith('3')))
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve(false)
    }, 5000)
  })
}

function listPythonInstalls(): string[] {
  const found: string[] = []
  const push = (p: string) => {
    if (p && fileExists(p) && !found.includes(p)) found.push(p)
  }

  if (process.platform === 'darwin') {
    push('/usr/bin/python3')
    push('/opt/homebrew/bin/python3')
    push('/usr/local/bin/python3')
    return found
  }

  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows'
    push(join(root, 'py.exe'))
    push(join(root, 'System32', 'py.exe'))
    const local = process.env.LOCALAPPDATA
    if (local) {
      const programs = join(local, 'Programs', 'Python')
      if (fileExists(programs)) {
        try {
          for (const name of readdirSync(programs)) {
            push(join(programs, name, 'python.exe'))
          }
        } catch { /* ignore */ }
      }
    }
    for (const envName of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const base = process.env[envName]
      if (!base) continue
      try {
        for (const name of readdirSync(base)) {
          if (/^Python3/i.test(name)) push(join(base, name, 'python.exe'))
        }
      } catch { /* ignore */ }
    }
  }

  return found
}

async function findPython(): Promise<{ bin: string; prefixArgs: string[] }> {
  const named: Array<{ bin: string; prefixArgs: string[] }> = process.platform === 'win32'
    ? [
        { bin: 'py', prefixArgs: ['-3'] },
        { bin: 'python', prefixArgs: [] },
        { bin: 'python3', prefixArgs: [] }
      ]
    : [
        { bin: 'python3', prefixArgs: [] },
        { bin: 'python', prefixArgs: [] }
      ]

  const abs = listPythonInstalls().map((bin) => ({
    bin,
    prefixArgs: /(?:^|[/\\])py\.exe$/i.test(bin) ? ['-3'] : []
  }))

  for (const candidate of [...abs, ...named]) {
    if (candidate.bin.includes('\\') || candidate.bin.includes('/')) {
      if (!fileExists(candidate.bin)) continue
    }
    if (await runPythonCheck(candidate.bin, candidate.prefixArgs)) {
      return candidate
    }
  }

  throw new Error(
    process.platform === 'win32'
      ? '未找到 Python 3。请安装 Python 3.9+ 并勾选 Add python.exe to PATH，然后重试。'
      : '未找到 python3。请安装 Python 3.9+（macOS 可执行 xcode-select --install）后重试。'
  )
}

function spawnPython(
  python: { bin: string; prefixArgs: string[] },
  args: string[],
  options: {
    cwd?: string
    timeoutMs: number
    onStdoutLine?: (line: string) => void
  }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }
  const child = spawn(python.bin, [...python.prefixArgs, '-u', ...args], {
    cwd: options.cwd || (args[0]?.includes('.py') ? dirname(args[0]) : undefined),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let stdoutBuf = ''
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      if (!settled) {
        settled = true
        reject(new Error('获取密钥超时'))
      }
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      stdoutBuf += text
      const parts = stdoutBuf.split(/\r?\n/)
      stdoutBuf = parts.pop() || ''
      for (const line of parts) options.onStdoutLine?.(line)
    })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (stdoutBuf) options.onStdoutLine?.(stdoutBuf)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseJsonLine(line: string): JsonEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as JsonEvent
    if (parsed && (parsed.event === 'status' || parsed.event === 'result')) return parsed
  } catch {
    return null
  }
  return null
}

async function ensureWindowsDeps(
  python: { bin: string; prefixArgs: string[] },
  requirements: string,
  onStatus?: (message: string, level: number) => void
): Promise<void> {
  const checkCode = 'import pymem, yara, Crypto, pefile, psutil'
  try {
    const result = await spawnPython(python, ['-c', checkCode], { timeoutMs: 20_000 })
    if (result.code === 0) return
  } catch {
    // fall through to install
  }

  if (!fileExists(requirements)) {
    throw new Error('缺少 Windows 密钥捕获依赖，且未找到 requirements.txt')
  }

  onStatus?.('正在安装 Python 依赖（pymem / yara-python 等）...', 0)
  const installed = await spawnPython(
    python,
    ['-m', 'pip', 'install', '--user', '-r', requirements],
    { timeoutMs: 180_000, cwd: dirname(requirements) }
  )
  if (installed.code !== 0) {
    const detail = (installed.stderr || installed.stdout || '').trim().slice(-400)
    throw new Error(
      '自动安装 Python 依赖失败。请在终端执行：pip install -r packages/wechat-key-win/requirements.txt'
      + (detail ? `\n${detail}` : '')
    )
  }

  const verified = await spawnPython(python, ['-c', checkCode], { timeoutMs: 20_000 })
  if (verified.code !== 0) {
    throw new Error('Python 依赖安装后仍无法导入，请手动执行 pip install -r packages/wechat-key-win/requirements.txt')
  }
}

export async function captureDbKeyFromPackage(
  timeoutMs = 180_000,
  onStatus?: (message: string, level: number) => void,
  options?: { database?: string }
): Promise<DbKeyResult> {
  const logs: string[] = []
  const pushStatus = (message: string, level = 0) => {
    const text = String(message || '').trim()
    if (!text) return
    logs.push(text)
    onStatus?.(text, level)
  }

  try {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return { success: false, error: '当前平台不支持 packages 密钥捕获', logs }
    }

    const { script, requirements, platformLabel } = resolveCaptureScript()
    if (!fileExists(script)) {
      return { success: false, error: `未找到 ${platformLabel} 密钥脚本: ${script}`, logs }
    }

    pushStatus('正在查找 Python 运行时...', 0)
    const python = await findPython()

    if (process.platform === 'win32' && requirements) {
      await ensureWindowsDeps(python, requirements, pushStatus)
    }

    const helperTimeoutSec = process.platform === 'darwin'
      ? Math.max(300, Math.ceil(timeoutMs / 1000))
      : Math.max(60, Math.ceil(timeoutMs / 1000))
    const processTimeoutMs = process.platform === 'darwin'
      ? Math.max(20 * 60_000, timeoutMs + 5 * 60_000)
      : Math.max(3 * 60_000, timeoutMs + 60_000)

    const args = [script, '--json']
    if (process.platform === 'darwin') {
      args.push('--no-prompt', '--timeout', String(helperTimeoutSec))
      pushStatus('即将备份并临时重签微信，请在系统密码框中授权', 0)
    } else {
      pushStatus('正在扫描已登录的微信进程内存...', 0)
    }
    if (options?.database) {
      args.push('--database', options.database)
    }

    const holder: { result: Extract<JsonEvent, { event: 'result' }> | null } = { result: null }
    const finished = await spawnPython(python, args, {
      cwd: dirname(script),
      timeoutMs: processTimeoutMs,
      onStdoutLine: (line) => {
        const parsed = parseJsonLine(line)
        if (!parsed) return
        if (parsed.event === 'status') {
          pushStatus(String(parsed.message || ''), Number(parsed.level || 0))
        } else if (parsed.event === 'result') {
          holder.result = parsed
        }
      }
    })

    const result = holder.result
    if (result?.success && result.db_key) {
      const key = String(result.db_key).trim().toLowerCase()
      if (/^[0-9a-f]{64}$/.test(key)) {
        pushStatus('密钥获取成功', 1)
        return { success: true, key, logs }
      }
      return { success: false, error: `返回的密钥格式无效: ${result.db_key}`, logs }
    }

    if (result?.error) {
      return { success: false, error: String(result.error), logs }
    }

    const fallback = (finished.stderr || finished.stdout || '').trim().slice(-500)
    return {
      success: false,
      error: fallback || `密钥捕获进程退出码 ${finished.code ?? 'unknown'}`,
      logs
    }
  } catch (e: any) {
    const message = String(e?.message || e || '密钥捕获失败').trim()
    return { success: false, error: message, logs }
  }
}

export function defaultProbeDatabaseHint(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const container = join(homedir(), 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')
      return fileExists(container) ? container : undefined
    }
    if (process.platform === 'win32') {
      const docs = join(process.env.USERPROFILE || homedir(), 'Documents', 'xwechat_files')
      return fileExists(docs) ? docs : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}
