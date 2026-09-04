import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { resolveAccountDir } from './services/accountDirResolver'
import { AnnualV2Accumulator, annualV2SessionAllowed } from './services/annualReportV2Stats'

const config = workerData as {year:number;dbPath:string;decryptKey:string;myWxid:string;resourcesPath:string;userDataPath:string}
process.env.WEMEMO_WORKER = '1'
process.env.WCDB_RESOURCES_PATH = config.resourcesPath
wcdbService.setPaths(config.resourcesPath,config.userDataPath)
async function run() {
  const dir = resolveAccountDir(config.dbPath,config.myWxid)
  if (!dir || !await wcdbService.open(dir,config.decryptKey)) throw new Error('无法打开当前账号数据库，请先连接数据库。')
  const sessions = await wcdbService.getSessions()
  if (!sessions.success || !sessions.sessions) throw new Error(sessions.error || '无法读取会话')
  const ids = [...new Set((sessions.sessions as any[]).map(s=>String(s.username||s.user_name||s.userName||'')))].filter(id=>annualV2SessionAllowed(id,config.myWxid))
  const contacts = await wcdbService.getContactsCompact(ids)
  const profiles = new Map((contacts.contacts || []).map(c=>[String(c.username||c.user_name||c.userName),c]))
  const avatars = await wcdbService.getAvatarUrls(ids)
  const stats = new AnnualV2Accumulator(config.year,config.myWxid)
  const end=new Date(config.year+1,0,1).getTime()/1000-1
  for (let i=0;i<ids.length;i++) {
    const id=ids[i]
    stats.addContact(id,{...profiles.get(id),avatarUrl:avatars.map?.[id]||profiles.get(id)?.avatarUrl||''})
    const cursor=await wcdbService.openMessageCursor(id,1000,true,0,end)
    if(!cursor.success||!cursor.cursor) throw new Error(cursor.error||`无法读取会话 ${i+1}`)
    try {
      let more=true
      while(more) {
        const batch=await wcdbService.fetchMessageBatch(cursor.cursor)
        if(!batch.success||!batch.rows)throw new Error(batch.error||'读取消息失败')
        for(const row of batch.rows)stats.add(id,row)
        more=batch.hasMore===true
      }
    } finally {await wcdbService.closeMessageCursor(cursor.cursor)}
    parentPort?.postMessage({type:'progress',progress:Math.round((i+1)/Math.max(1,ids.length)*100),status:`已分析 ${i+1}/${ids.length} 个会话`})
  }
  parentPort?.postMessage({type:'result',cards:stats.finish()})
}
run().catch(error=>parentPort?.postMessage({type:'error',error:error instanceof Error?error.message:String(error)})).finally(()=>wcdbService.shutdown())
