import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import annualV2Manifests from '../../shared/annualReportV2.json'
const validAnnualV2Year = (year: number) => Number.isInteger(year) && year >= 2000 && year <= new Date().getFullYear()
import { getMyWxidCleaned } from '../services/config'
import './AnnualReportV2Page.scss'

export default function AnnualReportV2Page() {
  const navigate = useNavigate()
  const iframe = useRef<HTMLIFrameElement>(null)
  const channel = useMemo(() => crypto.randomUUID(), [])
  const [status, setStatus] = useState('')
  const [frameReady, setFrameReady] = useState(false)
  const frameUrl = useMemo(() => {
    const url = new URL('./annual-v2/index.html', window.location.href.split('#')[0])
    url.search = new URLSearchParams({ channel }).toString()
    return url.href
  }, [channel])

  useEffect(() => {
    let disposed = false
    let account = ''
    let years: number[] = []
    let snapshot: Promise<any> | null = null
    let selectedYear = 0
    let generation = 0
    const invoke = (method: string, args: unknown = {}) => window.electronAPI.annualReportV2.request({ method, args, channel })
    const unsubscribe = window.electronAPI.annualReportV2.onProgress(payload => {
      if (!disposed && payload.channel === channel) setStatus(`${payload.status} · ${payload.progress}%`)
    })
    const checkAccount = async () => {
      const current = await getMyWxidCleaned() || ''
      if (disposed) throw new Error('页面已关闭')
      if (account && current !== account) {
        snapshot = null
        void invoke('cancel')
        throw new Error('账号已切换，请重新打开年分析版本2')
      }
      account = current
      return account
    }
    const receive = async (event: MessageEvent) => {
      const frame = iframe.current
      if (!frame || event.source !== frame.contentWindow) return
      const expectedOrigin = new URL(frameUrl).origin
      if (event.origin !== expectedOrigin) return
      const msg = event.data
      if (msg?.namespace !== 'wememo-annual-v2' || msg.channel !== channel || msg.type !== 'request' || typeof msg.id !== 'string') return
      const args = msg.args || {}
      let result: unknown, error: string | undefined
      try {
        if (msg.method === 'back') { navigate('/annual-report'); return }
        if (msg.method === 'accounts') {
          const id = await checkAccount()
          result = { accounts: id ? [{ account: id }] : [] }
        } else if (msg.method === 'meta') {
          await checkAccount()
          if (!account) throw new Error('请先连接微信数据库')
          ++generation
          snapshot = null
          await invoke('cancel')
          setStatus('正在读取可用年份…')
          const available = await window.electronAPI.annualReport.getAvailableYears()
          if (!available.success) throw new Error(available.error || '无法读取年份')
          years = (available.data || []).filter(validAnnualV2Year).sort((a: number,b: number)=>b-a)
          if (!years.length) throw new Error('当前账号没有可分析的聊天记录')
          selectedYear = years.includes(Number(args.year)) ? Number(args.year) : years[0]
          result = { account, year: selectedYear, availableYears: years, cards: annualV2Manifests }
          setStatus('')
        } else if (msg.method === 'card') {
          await checkAccount()
          if (Number(args.year) !== selectedYear || !years.includes(selectedYear) || !annualV2Manifests.some(c=>c.id===args.id)) throw new Error('报告参数已过期，请重新生成')
          const token = generation
          if (!snapshot) {
            setStatus('正在分析聊天记录…')
            snapshot = invoke('analyze', { year: selectedYear, account }).then(response => {
              if (!response.ok) throw new Error(response.error || '生成报告失败')
              return response.cards
            }).catch(e => { if (token === generation) snapshot = null; throw e }).finally(() => { if (!disposed && token === generation) setStatus('') })
          }
          const cards = await snapshot
          if (token !== generation) throw new Error('年份已切换')
          await checkAccount()
          result = cards.find((c: any) => c.id === args.id)
          if (!result) throw new Error('未找到此页数据')
        } else if (['captureRegion','wrappedBatchBegin','wrappedBatchCapture','wrappedBatchFinish','wrappedBatchAbort'].includes(msg.method)) {
          await checkAccount()
          if (msg.method === 'captureRegion' || msg.method === 'wrappedBatchCapture') {
            const rect = frame.getBoundingClientRect()
            const {x,y,width,height} = args
            if (![x,y,width,height].every(Number.isFinite) || x<0 || y<0 || width<=0 || height<=0 || x+width>rect.width+2 || y+height>rect.height+2) throw new Error('截图范围超出报告区域')
            result = await invoke(msg.method, { ...args, x: x + rect.left, y: y + rect.top })
          } else result = await invoke(msg.method,args)
        } else throw new Error('不支持的操作')
      } catch (e) { error = e instanceof Error ? e.message : String(e);setStatus('') }
      if (!disposed) frame.contentWindow?.postMessage({ namespace:'wememo-annual-v2',channel,type:'response',id:msg.id,result,error },expectedOrigin==='null'?'*':expectedOrigin)
    }
    window.addEventListener('message',receive)
    return () => { disposed=true;++generation;unsubscribe();window.removeEventListener('message',receive);void invoke('cancel') }
  }, [channel, frameUrl, navigate])

  return <div className="annual-v2-host">
    {!frameReady && <div className="annual-v2-host__loading">正在打开年分析版本2…</div>}
    <iframe ref={iframe} src={frameUrl} title="年分析版本2" onLoad={() => setFrameReady(true)} sandbox="allow-scripts allow-same-origin allow-downloads" />
    {status && <div className="annual-v2-host__status" role="status">{status}</div>}
  </div>
}
