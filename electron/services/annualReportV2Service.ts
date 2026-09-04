import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import JSZip from 'jszip'
import { validAnnualV2Year } from '../../shared/annualReportV2'

type Config = {dbPath:string;decryptKey:string;myWxid:string}
const safeName = (value:unknown) => String(value || '年度总结').replace(/[\x00-\x1f\\/:*?"<>|]/g,'_').replace(/^\.+|\.+$/g,'').slice(0,100) || '年度总结'
export function registerAnnualReportV2(getConfig:()=>Config) {
  const jobs = new Map<string,{worker:Worker;cancel:()=>void}>()
  const batches = new Map<string,{owner:string;images:Array<{name:string;data:Buffer}>}>()
  const watched = new Set<number>()
  const cleanupOwner = (owner:string) => {
    jobs.get(owner)?.cancel()
    for(const [id,batch] of batches)if(batch.owner===owner)batches.delete(id)
  }
  const capture = async(event:IpcMainInvokeEvent,args:any) => {
    const bounds=BrowserWindow.fromWebContents(event.sender)?.getContentBounds()
    const x=Math.round(Number(args.x)),y=Math.round(Number(args.y)),width=Math.round(Number(args.width)),height=Math.round(Number(args.height))
    if(!bounds||![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<=0||height<=0||x+width>bounds.width+2||y+height>bounds.height+2)throw new Error('截图范围无效，请重试')
    const outWidth=Math.round(Number(args.outWidth)||width),outHeight=Math.round(Number(args.outHeight)||height)
    if(outWidth<1||outHeight<1||outWidth>8192||outHeight>8192||outWidth*outHeight>24000000)throw new Error('导出尺寸过大')
    const img=await event.sender.capturePage({x,y,width,height})
    if(img.isEmpty())throw new Error('未能捕获画面')
    return {data:img.resize({width:outWidth,height:outHeight,quality:'best'}).toPNG(),width:outWidth,height:outHeight}
  }
  ipcMain.handle('annualReportV2:request',async(event,payload:any)=>{
    try {
      if(event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许应用主页面访问报告服务')
      const {method,args={},channel}=payload||{}
      if(typeof channel!=='string'||!/^[\w-]{8,100}$/.test(channel))throw new Error('无效的报告会话')
      const owner=`${event.sender.id}:${channel}`
      if(!watched.has(event.sender.id)) {
        const id=event.sender.id;watched.add(id)
        event.sender.once('destroyed',()=>{for(const key of jobs.keys())if(key.startsWith(`${id}:`))cleanupOwner(key);for(const [key,b] of batches)if(b.owner.startsWith(`${id}:`))batches.delete(key);watched.delete(id)})
      }
      if(method==='cancel') {cleanupOwner(owner);return {ok:true}}
      if(method==='analyze') {
        if(!validAnnualV2Year(args.year))throw new Error('请选择有效年份')
        const config=getConfig()
        if(!config.dbPath||!config.decryptKey||!config.myWxid)throw new Error('请先连接微信数据库')
        if(args.account!==config.myWxid)throw new Error('账号已切换，请重新打开年分析版本2')
        cleanupOwner(owner)
        return await new Promise(resolve=>{
          const worker=new Worker(join(__dirname,'annualReportV2Worker.js'),{workerData:{...config,year:args.year,resourcesPath:app.isPackaged?join(process.resourcesPath,'resources'):join(app.getAppPath(),'resources'),userDataPath:app.getPath('userData')}})
          let done=false
          const finish=(result:any)=>{if(done)return;done=true;clearTimeout(timer);jobs.delete(owner);worker.removeAllListeners();void worker.terminate();resolve(result)}
          const timer=setTimeout(()=>finish({ok:false,error:'统计超时，请稍后重试'}),14*60*1000)
          jobs.set(owner,{worker,cancel:()=>finish({ok:false,error:'报告生成已取消'})})
          worker.on('message',msg=>{if(msg.type==='result')finish({ok:true,cards:msg.cards});else if(msg.type==='error')finish({ok:false,error:msg.error});else if(msg.type==='progress'&&!event.sender.isDestroyed())event.sender.send('annualReportV2:progress',{channel,...msg})})
          worker.on('error',error=>finish({ok:false,error:error.message}))
          worker.on('exit',code=>finish({ok:false,error:`报告线程提前退出（${code}）`}))
        })
      }
      if(method==='captureRegion') {
        const image=await capture(event,args)
        const win=BrowserWindow.fromWebContents(event.sender)
        const options={title:'保存年分析图片',defaultPath:`${safeName(args.name)}.png`,filters:[{name:'PNG 图片',extensions:['png']}]}
        const save=win?await dialog.showSaveDialog(win,options):await dialog.showSaveDialog(options)
        if(save.canceled||!save.filePath)return {ok:false,error:'已取消保存'}
        await writeFile(save.filePath,image.data)
        return {ok:true,width:image.width,height:image.height}
      }
      if(method==='wrappedBatchBegin') {
        for(const [id,b] of batches)if(b.owner===owner)batches.delete(id)
        const id=randomUUID();batches.set(id,{owner,images:[]});return {ok:true,batchId:id}
      }
      const batch=batches.get(args.batchId)
      if(!batch||batch.owner!==owner)throw new Error('导出会话已失效，请重试')
      if(method==='wrappedBatchAbort'){batches.delete(args.batchId);return {ok:true}}
      if(method==='wrappedBatchCapture') {
        if(batch.images.length>=12)throw new Error('超过报告页数限制')
        const image=await capture(event,args)
        if(batch.images.reduce((n,x)=>n+x.data.length,0)+image.data.length>150*1024*1024)throw new Error('导出图片过大，请分开导出')
        batch.images.push({name:`${String(batch.images.length+1).padStart(2,'0')}-${safeName(args.name)}.png`,data:image.data})
        return {ok:true}
      }
      if(method==='wrappedBatchFinish') {
        batches.delete(args.batchId)
        const zip=new JSZip();for(const img of batch.images)zip.file(img.name,img.data)
        const data=await zip.generateAsync({type:'nodebuffer'})
        const win=BrowserWindow.fromWebContents(event.sender)
        const options={title:'保存整份年分析',defaultPath:`${safeName(args.zipName)}.zip`,filters:[{name:'ZIP 压缩文件',extensions:['zip']}]}
        const save=win?await dialog.showSaveDialog(win,options):await dialog.showSaveDialog(options)
        if(save.canceled||!save.filePath)return {ok:false,error:'已取消保存'}
        await writeFile(save.filePath,data)
        return {ok:true,count:batch.images.length,bytes:data.length}
      }
      throw new Error('不支持的报告操作')
    } catch(error) {return {ok:false,error:error instanceof Error?error.message:String(error)}}
  })
}
