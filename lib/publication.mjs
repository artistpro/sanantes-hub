// Eligibility is applied after Jev determines the format.
export function exclusionReason(video){
 const seconds=Number(video.duration);
 const isShort=/#shorts?\b/i.test(video.title||'')||/#shorts?\b/i.test(video.description||'')||(video.url&&/\/shorts\//i.test(video.url))||(video.platform==='youtube'&&Number.isFinite(seconds)&&seconds>0&&seconds<=60);
 if(isShort)return 'Formato corto (Short): excluido del catálogo de episodios';
 if(video.kind!=='live')return null;
 const musical=video.category==='Música y relajación'||/música|musica|melodías|melodias/i.test(video.title||'');
 return musical&&Number.isFinite(seconds)&&seconds>0&&seconds<3600?'Emisión musical interrumpida: menos de una hora':null;
}
export async function excludeInterrupted(query){
 const rows=await query("SELECT * FROM videos WHERE status!='hidden'");
 let excluded=0;
 for(const v of rows)if(exclusionReason(v)){await query("UPDATE videos SET status='hidden' WHERE id=?",[v.id]);excluded++;}
 return excluded;
}
export function canonicalVideoKey(title){
 return String(title||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function canonicalRank(v){
 const plat=v.platform==='youtube'?2:(v.platform==='odysee'?1:0);
 const descLen=Number.isFinite(v.desc_len)?v.desc_len:String(v.description||'').length;
 const ts=v.published_at?Date.parse(v.published_at)||0:0;
 return [plat,descLen,ts];
}
export function pickCanonicalVideo(candidates){
 if(!candidates||!candidates.length)return null;
 return [...candidates].sort((a,b)=>{
  const ra=canonicalRank(a),rb=canonicalRank(b);
  for(let i=0;i<ra.length;i++)if(rb[i]!==ra[i])return rb[i]-ra[i];
  return String(a.id).localeCompare(String(b.id));
 })[0];
}
export function dedupeVideos(videos){
 const groups=new Map();
 for(const v of videos){
  const key=canonicalVideoKey(v.title)||v.id;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(v);
 }
 const winners=new Set();
 for(const group of groups.values()){
  const win=pickCanonicalVideo(group);
  if(win)winners.add(win.id);
 }
 return videos.filter(v=>winners.has(v.id));
}

