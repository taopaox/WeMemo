import { reactive } from 'vue'

const channel = new URLSearchParams(location.search).get('channel') || ''
const parentOrigin = location.protocol === 'file:' ? '*' : location.origin
const pending = new Map()
let serial = 0
window.addEventListener('message', event => {
  if (event.source !== window.parent || (parentOrigin !== '*' && event.origin !== parentOrigin)) return
  const msg = event.data
  if (msg?.namespace !== 'wememo-annual-v2' || msg.channel !== channel || msg.type !== 'response') return
  const job = pending.get(msg.id)
  if (!job) return
  clearTimeout(job.timer)
  pending.delete(msg.id)
  msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg.result)
})
export function request(method, args = {}) {
  if (!channel || window.parent === window) return Promise.reject(new Error('请从 WeMemo 左侧「年分析版本2」打开，以读取当前账号的数据。'))
  return new Promise((resolve, reject) => {
    const id = String(++serial)
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('处理超时，请重新生成报告')) }, 15 * 60 * 1000)
    pending.set(id, { resolve, reject, timer })
    window.parent.postMessage({ namespace: 'wememo-annual-v2', channel, type: 'request', id, method, args }, parentOrigin)
  })
}
const route = reactive({ query: Object.fromEntries(new URLSearchParams(location.search)) })
export const useRoute = () => route
export const useRouter = () => ({
  replace: async ({ query }) => {
    route.query = query
    const url = new URL(location.href)
    url.search = new URLSearchParams({ ...query, channel }).toString()
    history.replaceState(null, '', url)
  },
  push: async () => request('back')
})
export const useHead = ({ title }) => { document.title = title }
window.wechatDesktop = Object.fromEntries(['captureRegion', 'wrappedBatchBegin', 'wrappedBatchCapture', 'wrappedBatchFinish', 'wrappedBatchAbort'].map(method => [method, args => request(method, args)]))
