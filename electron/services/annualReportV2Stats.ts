import wechatEmojiAssets from '../../shared/annualV2EmojiAssets.json'
import { decompress } from 'fzstd'
import { annualV2Manifests, type AnnualV2Card } from '../../shared/annualReportV2'

type Row = Record<string, any>
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const pad = (v: number) => String(v).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const inc = (map: Map<string, number>, key: string, n = 1) => map.set(key, (map.get(key) || 0) + n)
const top = (map: Map<string, number>, n = 20) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const bestIndex = (a: number[]) => a.indexOf(Math.max(...a))
export function decodeAnnualContent(raw: unknown): string {
  if (!raw) return ''
  let bytes: Buffer | null = null
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) bytes = Buffer.from(raw)
  else if (typeof raw === 'object' && (raw as any).type === 'Buffer') bytes = Buffer.from((raw as any).data)
  else if (typeof raw === 'string') {
    // Only decode binary strings with the Zstandard magic; ordinary text stays text.
    if (/^(28b52ffd)/i.test(raw) && /^[\da-f]+$/i.test(raw)) bytes = Buffer.from(raw, 'hex')
    else if (raw.startsWith('KLUv/Q')) bytes = Buffer.from(raw, 'base64')
    else return raw
  }
  if (!bytes) return ''
  try { return Buffer.from(bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528 ? decompress(bytes) : bytes).toString('utf8') } catch { return '' }
}
export function annualV2SessionAllowed(username: string, self: string): boolean {
  return !!username && username !== self && !username.startsWith('gh_') && !/^(filehelper|weixin|qqmail|fmessage|medianote|floatbottle|newsapp|brandsessionholder|brandservicesessionholder|notifymessage|notification_messages|opencustomerservicemsg|userexperience_alarm|@?helper_folders|@?placeholder_foldgroup|service_)/.test(username) && !/@(kefu\.)?openim$/.test(username)
}
const monthStats = () => ({ total: 0, sent: 0, received: 0, replies: 0, replySum: 0, replySumCapped: 0, interaction: 0, days: new Set<number>(), hours: new Set<number>() })
type Contact = ReturnType<typeof makeContact>
const makeContact = (username: string, displayName: string, avatarUrl: string, days: number) => ({
  username, displayName, maskedName: '*'.repeat(Math.min(6, [...displayName].length)), avatarUrl,
  group: username.endsWith('@chatroom'), sent: 0, received: 0, total: 0, replies: 0, replySum: 0, replySumCapped: 0, fastest: Infinity, slowest: 0,
  initiated: 0, approached: 0, night: 0, myNight: 0, nightSample: null as Row | null,
  last: null as { ts: number; sent: boolean } | null, prompt: null as number | null,
  daily: Array(days).fill(0) as number[], dailySent: Array(days).fill(0) as number[], dailyReceived: Array(days).fill(0) as number[],
  months: Array.from({ length: 12 }, monthStats)
})
export class AnnualV2Accumulator {
  readonly year: number
  readonly days: number
  readonly contacts = new Map<string, Contact>()
  readonly matrix = Array.from({ length: 7 }, () => Array(24).fill(0) as number[])
  readonly daily: number[]
  readonly dailySent: number[]
  readonly dailyReceived: number[]
  readonly sentCharsDaily: number[]
  readonly receivedCharsDaily: number[]
  readonly stickerDaily: number[]
  readonly phrases = new Map<string, number>()
  readonly phraseSamples = new Map<string, Row>()
  readonly stickers = new Map<string, Row>()
  readonly stickerHistory = new Map<string, Set<number>>()
  readonly stickerPartners = new Map<string, number>()
  readonly textEmoji = new Map<string, number>()
  readonly unicodeEmoji = new Map<string, number>()
  readonly replyGaps = new Map<number, number>()
  readonly kindCounts = new Map<string, number>()
  readonly added = new Set<string>()
  sent = 0; received = 0; sentChars = 0; receivedChars = 0; stickerCount = 0
  readonly stickerHours = Array(24).fill(0) as number[]
  readonly stickerWeekdays = Array(7).fill(0) as number[]
  earliest: Row | null = null; latest: Row | null = null; first: Row | null = null; last: Row | null = null
  voice = { sentCount: 0, sentSeconds: 0, receivedCount: 0, receivedSeconds: 0 }
  calls = { totalCount: 0, totalSeconds: 0 }
  constructor(year: number, private self: string) {
    this.year = year
    this.days = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000)
    this.daily = Array(this.days).fill(0); this.dailySent = [...this.daily]; this.dailyReceived = [...this.daily]
    this.sentCharsDaily = [...this.daily]; this.receivedCharsDaily = [...this.daily]; this.stickerDaily = [...this.daily]
  }
  addContact(username: string, row: Row = {}) {
    const name = String(row.remark || row.remark_name || row.display_name || row.displayName || row.nick_name || row.nickName || row.nickname || username)
    this.contacts.set(username, makeContact(username, name, String(row.avatar_url || row.avatarUrl || row.small_head_url || ''), this.days))
  }
  add(username: string, row: Row) {
    const c = this.contacts.get(username)
    if (!c) return
    const ts = Number(row.create_time ?? row.createTime ?? row.timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return
    const d = new Date(ts * 1000)
    const doy = Math.round((Date.UTC(this.year, d.getMonth(), d.getDate()) - Date.UTC(this.year, 0, 1)) / 86400000)
    const weekday = (d.getDay() + 6) % 7, hour = d.getHours(), month = d.getMonth()
    const direction = row.computed_is_send ?? row.is_send ?? row.isSend
    const sender = String(row.sender_username || row.sender || '')
    const sent = direction !== undefined && direction !== null ? Number(direction) === 1 : sender === this.self
    const type = Number(row.local_type ?? row.type ?? 1) % 4294967296
    let content = decodeAnnualContent(row.compress_content) || decodeAnnualContent(row.message_content ?? row.content)
    if (c.group) content = content.replace(/^[^\n:]{1,100}:\n/, '')
    if (type === 47 && sent && d.getFullYear() <= this.year) {
      const md5 = content.match(/\bmd5=["']([\da-f]{32})/i)?.[1]
      if (md5) {
        let times = this.stickerHistory.get(md5)
        if (!times) { times = new Set();this.stickerHistory.set(md5,times) }
        times.add(Math.floor(ts / 86400))
      }
    }
    if (d.getFullYear() !== this.year) return
    if (type >= 10000) {
      if (!c.group && /现在可以开始聊天了|你们已经是好友/.test(content)) this.added.add(username)
      return
    }
    c.total++; this.daily[doy]++; c.daily[doy]++
    const m = c.months[month];m.total++;m.days.add(doy);m.hours.add(Math.floor(hour / 6))
    if (sent) { this.sent++;c.sent++;m.sent++;this.dailySent[doy]++;c.dailySent[doy]++;this.matrix[weekday][hour]++ }
    else { this.received++;c.received++;m.received++;this.dailyReceived[doy]++;c.dailyReceived[doy]++ }
    const moment = { username, displayName: c.displayName, maskedName: c.maskedName, avatarUrl: c.avatarUrl, date: dateKey(d), time: `${pad(hour)}:${pad(d.getMinutes())}`, content: type === 1 ? content.slice(0, 180) : ({ 3: '[图片]', 34: '[语音]', 43: '[视频]', 47: '[表情包]' } as Row)[type] || '[消息]', timestamp: ts, fromMe: sent, direction: sent ? 'sent' : 'received' }
    if (sent) {
      const sec = hour * 3600 + d.getMinutes() * 60 + d.getSeconds()
      if (!this.earliest || sec < this.earliest.secondOfDay) this.earliest = { ...moment, secondOfDay: sec }
      if (!this.latest || sec > this.latest.secondOfDay) this.latest = { ...moment, secondOfDay: sec }
      if (!this.first || ts < this.first.timestamp) this.first = moment
      if (!this.last || ts > this.last.timestamp) this.last = moment
      inc(this.kindCounts, ({ 1: 'text', 3: 'image', 34: 'voice', 43: 'video', 47: 'emoji', 49: 'link' } as Row)[type] || 'other')
    }
    if (!c.group) {
      if (hour < 6) { c.night++; if (sent) c.myNight++; if (!c.nightSample || ts > c.nightSample.timestamp) c.nightSample = moment }
      if (!c.last || ts - c.last.ts > 1800) { if (sent) c.initiated++; else c.approached++ }
      if (c.last && c.last.sent !== sent) m.interaction++
      if (sent && c.prompt !== null) {
        const gap = ts - c.prompt
        if (gap >= 0) { c.replies++;c.replySum += gap;c.replySumCapped += Math.min(gap,21600);c.fastest = Math.min(c.fastest,gap);c.slowest = Math.max(c.slowest,gap);m.replies++;m.replySum += gap;m.replySumCapped += Math.min(gap,21600);this.replyGaps.set(gap,(this.replyGaps.get(gap)||0)+1) }
        c.prompt = null
      } else if (!sent) c.prompt = ts
      c.last = { ts, sent }
    }
    if (type === 1) {
      const length = [...content.replace(/\s/g, '')].length
      if (sent) { this.sentChars += length;this.sentCharsDaily[doy] += length }
      else { this.receivedChars += length;this.receivedCharsDaily[doy] += length }
      if (sent) {
        const phrase = content.trim()
        if (phrase.length >= 2 && phrase.length <= 30 && !/https?:|<[^>]*>/.test(phrase)) {
          if (this.phrases.has(phrase) || this.phrases.size < 200000) { inc(this.phrases,phrase); if (!this.phraseSamples.has(phrase)) this.phraseSamples.set(phrase,moment) }
        }
        for (const item of content.match(/\[[^\]\n]{1,10}\]/g) || []) inc(this.textEmoji,item)
        for (const item of content.match(/\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*/gu) || []) inc(this.unicodeEmoji,item)
      }
    }
    if (type === 34) {
      const duration = Number(content.match(/voicelength=["'](\d+)/)?.[1] || 0) / 1000
      if (sent) { this.voice.sentCount++;this.voice.sentSeconds += duration } else { this.voice.receivedCount++;this.voice.receivedSeconds += duration }
    }
    if (type === 50) {
      const duration = content.match(/(?:通话时长|时长)[：:\s]*(?:(\d+):)?(\d{1,2}):(\d{2})/)
      this.calls.totalCount++
      if (duration) this.calls.totalSeconds += Number(duration[1] || 0)*3600+Number(duration[2])*60+Number(duration[3])
    }
    if (type === 47 && sent) {
      this.stickerCount++;if(!c.group)inc(this.stickerPartners,username);this.stickerDaily[doy]++;this.stickerHours[hour]++;this.stickerWeekdays[weekday]++
      const md5 = content.match(/\bmd5=["']([\da-f]{32})/i)?.[1]
      if (md5) {
        let st = this.stickers.get(md5)
        if (!st) { st = { md5, count: 0, emojiUrl: '', sampleUsername: username, sampleDisplayName: c.displayName };this.stickers.set(md5,st) }
        st.count++
        const url = content.match(/\b(?:cdnurl|thumburl)=["']([^"']+)/i)?.[1]?.replace(/&amp;/g,'&')
        if (url && /^https?:\/\//.test(url)) st.emojiUrl = url
      }
    }
  }
  finish(): AnnualV2Card[] {
    const privateContacts = [...this.contacts.values()].filter(c => !c.group && c.total)
    const profile = (c: Contact) => ({ username: c.username, displayName: c.displayName, maskedName: c.maskedName, avatarUrl: c.avatarUrl })
    const longest = (a: number[]) => { let max = 0, run = 0;for(const n of a) { run = n ? run + 1 : 0;max = Math.max(max,run) }return max }
    const detail = (c: Contact) => ({ ...profile(c), totalMessages: c.total, messages: c.sent, outgoingMessages: c.sent, incomingMessages: c.received, replyCount: c.replies, avgReplySeconds: c.replies ? c.replySum/c.replies : null, fastestReplySeconds: c.replies ? c.fastest : null, slowestReplySeconds: c.replies ? c.slowest : null, longestStreakDays: longest(c.daily) })
    const totals = [...privateContacts].sort((a,b)=>b.total-a.total)
    const buddies = privateContacts.filter(c=>c.replies).sort((a,b)=>Math.log1p(Math.min(b.sent,b.received))/(1+b.replySumCapped/b.replies/1800)-Math.log1p(Math.min(a.sent,a.received))/(1+a.replySumCapped/a.replies/1800)||a.username.localeCompare(b.username))
    const peak = bestIndex(this.daily), peakDate = new Date(this.year,0,peak+1)
    const peakContact = [...this.contacts.values()].sort((a,b)=>b.daily[peak]-a.daily[peak])[0]
    const hours = Array.from({length:24},(_,h)=>sum(this.matrix.map(row=>row[h])))
    const weekdayCounts = this.matrix.map(sum)
    const activeDays = this.daily.filter(Boolean).length
    const phrases = top(this.phrases,100).map(([word,count])=>({word,count}))
    const typeLabels: Row = {text:'文字',image:'图片',voice:'语音',video:'视频',emoji:'表情包',link:'分享',other:'其他'}
    const topKind = top(this.kindCounts,1)[0]
    const highlights = [['sent_chars_max',this.sentCharsDaily],['received_chars_max',this.receivedCharsDaily],['sent_messages_max',this.dailySent],['received_messages_max',this.dailyReceived],['sticker_messages_max',this.stickerDaily]].map(([key,values])=>({key,doy:bestIndex(values as number[]),count:Math.max(...values as number[])})).filter(x=>x.count>0)
    const annualHeatmap = {year:this.year,days:this.days,direction:'both',totalMessages:this.sent+this.received,activeDays,dailyCounts:this.daily,highlights}
    const peakDay = this.daily[peak] ? {date:dateKey(peakDate),count:this.daily[peak],weekdayName:weekdays[(peakDate.getDay()+6)%7],multiple:Number((this.daily[peak]/((this.sent+this.received)/this.days||1)).toFixed(1)),topContact:peakContact?{...profile(peakContact),count:peakContact.daily[peak],messages:peakContact.daily[peak]}:null}:null
    const mostSent = [...privateContacts].sort((a,b)=>b.sent-a.sent)[0]
    const mostGroup = [...this.contacts.values()].filter(c=>c.group&&c.sent).sort((a,b)=>b.sent-a.sent)[0]
    const overview = {year:this.year,totalMessages:this.sent,activeDays,addedFriends:this.added.size,messagesPerDay:this.sent/this.days,sentMediaCount:(this.kindCounts.get('image')||0)+(this.kindCounts.get('video')||0),sentStickerCount:this.stickerCount,mostActiveHour:this.sent?bestIndex(hours):null,mostActiveWeekdayName:this.sent?weekdays[bestIndex(weekdayCounts)]:'',topContact:mostSent?{...profile(mostSent),messages:mostSent.sent}:null,topGroup:mostGroup?{...profile(mostGroup),messages:mostGroup.sent}:null,topKind:topKind?{kind:topKind[0],label:typeLabels[topKind[0]],count:topKind[1],ratio:topKind[1]/(this.sent||1)}:null,topPhrase:phrases[0]?{phrase:phrases[0].word,count:phrases[0].count}:null,peakDay,annualHeatmap}
    const nightBest = [...privateContacts].sort((a,b)=>b.night-a.night)[0]
    const nightCompanion = nightBest?.night ? {partner:{...profile(nightBest),sharePct:Number((100*nightBest.night/(sum(privateContacts.map(c=>c.night))||1)).toFixed(1))},latestMoment:nightBest.nightSample,nightMessagesTotal:sum(privateContacts.map(c=>c.night)),myNightMessages:sum(privateContacts.map(c=>c.myNight)),partnerNightMessages:nightBest.night,share:nightBest.night/(sum(privateContacts.map(c=>c.night))||1),sample:nightBest.nightSample,...nightBest.nightSample}:null
    const schedule = {year:this.year,totalMessages:this.sent,matrix:this.matrix,weekdayLabels:weekdays,earliestSent:this.earliest,latestSent:this.latest,yearFirstSent:this.first,yearLastSent:this.last,nightCompanion}
    const chars = {year:this.year,sentChars:this.sentChars,receivedChars:this.receivedChars,sentBook:{text:`约 ${(this.sentChars/100000).toFixed(1)} 本十万字的书`},receivedA4:{a4:{sheets:Math.ceil(this.receivedChars/800),heightCm:Math.ceil(this.receivedChars/800)*0.01},object:'每页约 800 字'},keyboard:{totalKeyHits:Math.round(this.sentChars*2.8)+Math.round(Math.round(this.sentChars*2.8)*.15),estimated:true},voice:this.voice,calls:this.calls}
    const totalReplies = sum([...this.replyGaps.values()])
    const quantile = (q:number) => {let n=0;for(const [sec,count] of [...this.replyGaps].sort((a,b)=>a[0]-b[0])) {n+=count;if(n>=Math.ceil(totalReplies*q))return sec}return null}
    const byFast = [...buddies].sort((a,b)=>a.fastest-b.fastest),bySlow=[...buddies].sort((a,b)=>b.slowest-a.slowest)
    const initiated = sum(privateContacts.map(c=>c.initiated)),approached=sum(privateContacts.map(c=>c.approached))
    const rankInit = (key:'initiated'|'approached')=>[...privateContacts].filter(c=>c[key]).sort((a,b)=>b[key]-a[key]).slice(0,3).map(c=>({...profile(c),count:c[key]}))
    const mutual = privateContacts.filter(c=>c.sent&&c.received).sort((a,b)=>(Math.min(b.sent,b.received)/Math.max(b.sent,b.received))-(Math.min(a.sent,a.received)/Math.max(a.sent,a.received))||b.total-a.total)[0]
    const initiative={conversationCount:initiated+approached,initiatedByMe:initiated,initiatedByOthers:approached,initiationRatePct:100*initiated/(initiated+approached||1),topInitiatedByMe:rankInit('initiated'),topInitiatedToMe:rankInit('approached'),mutualFriend:mutual?{...profile(mutual),sentCount:mutual.sent,receivedCount:mutual.received,ratio:Math.min(mutual.sent,mutual.received)/Math.max(mutual.sent,mutual.received)}:null}
    const cumulative = (values:number[])=>{let n=0;return values.map(v=>n+=v)}
    const reply={year:this.year,sentToContacts:privateContacts.filter(c=>c.sent).length,replyEvents:totalReplies,replyStats:totalReplies?{p50Seconds:quantile(.5),p90Seconds:quantile(.9)}:null,bestBuddy:buddies[0]?detail(buddies[0]):null,fastest:byFast[0]?{...profile(byFast[0]),seconds:byFast[0].fastest}:null,slowest:bySlow[0]?{...profile(bySlow[0]),seconds:bySlow[0].slowest}:null,fastestReplySeconds:byFast[0]?.fastest??null,longestReplySeconds:bySlow[0]?.slowest??null,topTotals:totals.slice(0,20).map(detail),topBuddies:buddies.slice(0,10).map(detail),allContacts:totals.map(detail),initiative,race:{days:this.days,series:totals.slice(0,15).map(c=>({...detail(c),cumulativeCounts:cumulative(c.daily),cumulativeOutgoingCounts:cumulative(c.dailySent),cumulativeIncomingCounts:cumulative(c.dailyReceived)}))},settings:{usedIndex:true,gapCapSeconds:21600,tauSeconds:1800}}
    const winners = new Map<string,number>()
    const months = Array.from({length:12},(_,i)=>{
      const contenders=privateContacts.filter(c=>{const m=c.months[i];return m.total>=8&&Math.min(m.sent,m.received)>=3&&m.replies>=1&&m.days.size>=2})
      const maxInteraction=Math.max(1,...contenders.map(c=>Math.min(c.months[i].sent,c.months[i].received)))
      const maxDays=Math.max(1,...contenders.map(c=>c.months[i].days.size))
      const metrics=(c:Contact)=>{const m=c.months[i];return {interactionScore:Math.log1p(Math.min(m.sent,m.received))/Math.log1p(maxInteraction),speedScore:1/(1+m.replySumCapped/(m.replies||1)/1800),continuityScore:m.days.size/maxDays,coverageScore:m.hours.size/4}}
      const score=(c:Contact)=>{const m=metrics(c);return m.interactionScore*.4+m.speedScore*.3+m.continuityScore*.2+m.coverageScore*.1}
      const c=contenders.sort((a,b)=>score(b)-score(a)||Math.min(b.months[i].sent,b.months[i].received)-Math.min(a.months[i].sent,a.months[i].received)||a.username.localeCompare(b.username))[0]
      if(!c)return {month:i+1,winner:null,metrics:null,raw:null}
      inc(winners,c.username)
      const m=c.months[i]
      return {month:i+1,winner:{...profile(c),score100:Number((score(c)*100).toFixed(1))},metrics:metrics(c),raw:{totalMessages:m.total,interaction:Math.min(m.sent,m.received),activeDays:m.days.size,avgReplySecondsCapped:m.replies?m.replySumCapped/m.replies:null}}
    })
    const champion=top(winners,1)[0]
    const monthly={year:this.year,months,summary:{monthsWithWinner:months.filter(m=>m.winner).length,topChampion:champion?{...profile(this.contacts.get(champion[0])!),monthsWon:champion[1]}:null}}
    const keyword={year:this.year,topKeyword:phrases[0]||null,keywords:phrases,bubbleMessages:phrases.slice(0,30).map(p=>({text:p.word,count:p.count,...this.phraseSamples.get(p.word)})),examples:phrases.slice(0,20).map(p=>({word:p.word,...this.phraseSamples.get(p.word)})),meta:{matchedCandidates:sum([...this.phrases.values()])}}
    const topStickers=[...this.stickers.values()].sort((a,b)=>b.count-a.count).slice(0,100).map(s=>({...s,ratio:s.count/(this.stickerCount||1)}))
    const startDay=Math.floor(new Date(this.year,0,1).getTime()/86400000)
    const newStickers:Row[]=[],revivedStickers:Row[]=[]
    for(const sticker of this.stickers.values()) {
      const history=[...(this.stickerHistory.get(sticker.md5)||[])].sort((a,b)=>a-b)
      if(history[0]>=startDay)newStickers.push(sticker)
      let gap=0
      for(let i=1;i<history.length;i++)if(history[i]>=startDay)gap=Math.max(gap,history[i]-history[i-1])
      if(gap>=60)revivedStickers.push({...sticker,gapDays:gap})
    }
    const battle=top(this.stickerPartners,1)[0]
    const emoji={year:this.year,sentStickerCount:this.stickerCount,stickerActiveDays:this.stickerDaily.filter(Boolean).length,stickerPerActiveDay:this.stickerCount/(this.stickerDaily.filter(Boolean).length||1),stickerShareOfSentMessages:this.stickerCount/(this.sent||1),uniqueStickerTypeCount:this.stickers.size,topStickers:topStickers.slice(0,12),stickerPoolSamples:topStickers,topWechatEmojis:top(this.textEmoji).map(([key,count])=>({key,count,assetPath:(wechatEmojiAssets as Record<string,string>)[key]||''})),topUnicodeEmojis:top(this.unicodeEmoji).map(([emoji,count])=>({emoji,count})),stickerHourCounts:this.stickerHours,stickerWeekdayCounts:this.stickerWeekdays,peakHour:this.stickerCount?bestIndex(this.stickerHours):null,peakWeekdayName:this.stickerCount?weekdays[bestIndex(this.stickerWeekdays)]:'',persona:{label:this.stickerCount?'表情收藏家':'文字表达者',reason:'根据本年度发送的表情统计'},historyAvailable:true,newStickerCountThisYear:newStickers.length,newStickerShare:newStickers.length/(this.stickers.size||1),newStickerSamples:newStickers.sort((a,b)=>b.count-a.count).slice(0,12),revivedStickerCount:revivedStickers.length,revivedStickerShare:revivedStickers.length/(this.stickers.size||1),revivedMaxGapDays:Math.max(0,...revivedStickers.map(s=>s.gapDays)),revivedStickerSamples:revivedStickers.sort((a,b)=>b.count-a.count).slice(0,12),topBattlePartner:battle?{...profile(this.contacts.get(battle[0])!),stickerCount:battle[1]}:null}
    const snapshot={...overview,sentChars:this.sentChars,receivedChars:this.receivedChars,bestBuddy:reply.bestBuddy,monthlyBestBuddies:months.map(m=>({month:m.month,...m.winner,messages:m.raw?.totalMessages||0})),monthlySummary:monthly.summary,nightCompanion,weekdayHourMatrix:this.matrix,matrix:this.matrix,sentBook:chars.sentBook,keyboard:chars.keyboard,weekdayLabels:weekdays,replyStats:reply.replyStats,initiative,...emoji,fastest:reply.fastest,slowest:reply.slowest,topTotals:reply.topTotals,yearFirstSent:this.first,yearLastSent:this.last,keywords:phrases,keywordMeta:keyword.meta,topSticker:emoji.topStickers[0]||null,topStickerThumbs:emoji.topStickers,topUnicodeEmoji:emoji.topUnicodeEmojis[0]?.emoji||null,topUnicodeEmojiCount:emoji.topUnicodeEmojis[0]?.count||0,topKeywords:phrases,topKeyword:phrases[0]||null,topStickers:emoji.topStickers,voice:this.voice,calls:this.calls}
    const payloads:Record<number,Row>={0:overview,1:schedule,2:chars,3:reply,4:monthly,5:emoji,6:keyword,7:{year:this.year,snapshot}}
    return annualV2Manifests.map(m=>({...m,status:'ok',narrative:'基于本地聊天记录生成',data:payloads[m.id]}))
  }
}
