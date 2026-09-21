export const platforms=['youtube','odysee','vimeo','dailymotion','rumble'];
const hosts={youtube:['youtube.com','www.youtube.com','youtu.be','m.youtube.com'],odysee:['odysee.com','www.odysee.com'],vimeo:['vimeo.com','www.vimeo.com','player.vimeo.com'],dailymotion:['dailymotion.com','www.dailymotion.com','dai.ly'],rumble:['rumble.com','www.rumble.com']};
export function mediaURL(raw,platform){let u;try{u=new URL(raw)}catch{throw new Error('Introduce una URL válida')};if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts[platform]?.includes(u.hostname))throw new Error('El enlace no corresponde a la plataforma');return u;}
export function identify(raw,platform){const u=mediaURL(raw,platform);let id;
  if(platform==='youtube')id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v')||u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
  if(platform==='vimeo')id=u.pathname.match(/\/(\d+)(?:\/|$)/)?.[1];
  if(platform==='dailymotion')id=u.pathname.match(/(?:video\/|^\/)([a-zA-Z0-9]+)(?:_|$)/)?.[1];
  if(platform==='rumble')id=u.pathname.replace(/^\//,'');
  if(platform==='odysee')id=decodeURIComponent(u.pathname).replace(/^\//,'');
  if(!id||id.length>400||(platform==='youtube'&&!/^[\w-]{11}$/.test(id)))throw new Error('No se pudo reconocer el video');
  return id;
}
export function youtubeKind(v){
  if(v.liveStreamingDetails||['live','upcoming'].includes(v.snippet?.liveBroadcastContent))return 'live';
  return 'review';
}
export function odyseeKind(){return 'review';}
export function safeImage(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return ''}}
async function json(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw new Error(`La plataforma respondió ${r.status}`);return r.json();}
async function rpc(method,params){const r=await json('https://api.na-backend.odysee.com/api/v1/proxy?m='+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});if(r.error)throw new Error(r.error.message||'Error de Odysee');return r.result;}
export async function fetchSource(source){
  const u=mediaURL(source.url,source.platform);const page=source.cursor||'';
  if(source.platform==='odysee'){
    let channel=source.external_id;
    if(!channel){const uri='lbry://'+decodeURIComponent(u.pathname.slice(1)).replace(':','#');const resolved=await rpc('resolve',{urls:[uri]});channel=resolved[uri]?.claim_id;if(!channel)throw new Error('Canal de Odysee no encontrado');}
    const result=await rpc('claim_search',{channel_ids:[channel],claim_type:'stream',stream_types:['video'],page:Number(page||1),page_size:50,order_by:['release_time']});
    return {external_id:channel,cursor:result.items?.length===50?String(Number(page||1)+1):null,videos:(result.items||[]).map(item=>{const v=item.value||{};const duration=Math.round(v.video?.duration||0);return {external_id:item.claim_id,title:v.title||item.name,description:v.description||'',url:'https://odysee.com/'+(item.canonical_url||item.permanent_url).replace('lbry://','').replaceAll('#',':'),thumbnail:safeImage(v.thumbnail?.url),duration,published_at:new Date((v.release_time||item.timestamp)*1000).toISOString(),kind:odyseeKind()}})};
  }
  if(source.platform==='youtube'){
    const key=process.env.YOUTUBE_API_KEY;if(!key)throw new Error('Conecta la clave de YouTube Data API en Vercel');
    const api=async(resource,params)=>json('https://www.googleapis.com/youtube/v3/'+resource+'?'+new URLSearchParams({...params,key}));
    let playlist=source.external_id;
    if(!playlist){const channelID=u.pathname.match(/\/channel\/(UC[\w-]+)/)?.[1];const r=await api('channels',{part:'contentDetails',...(channelID?{id:channelID}:{forHandle:u.pathname.split('/')[1]})});playlist=r.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;if(!playlist)throw new Error('Canal de YouTube no encontrado');}
    const r=await api('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:'50',...(page?{pageToken:page}:{})});const ids=(r.items||[]).map(x=>x.contentDetails.videoId);
    if(!ids.length)return {external_id:playlist,cursor:null,videos:[]};
    const details=await api('videos',{id:ids.join(','),part:'snippet,contentDetails,liveStreamingDetails,status'});
    return {external_id:playlist,cursor:r.nextPageToken||null,videos:details.items.filter(v=>v.status?.privacyStatus==='public').map(v=>({external_id:v.id,title:v.snippet.title,description:v.snippet.description,url:'https://www.youtube.com/watch?v='+v.id,thumbnail:safeImage(v.snippet.thumbnails?.high?.url),duration:duration(v.contentDetails.duration),published_at:v.snippet.publishedAt,kind:youtubeKind(v)}))};
  }
  if(source.platform==='vimeo'){
    if(!process.env.VIMEO_ACCESS_TOKEN)throw new Error('Conecta VIMEO_ACCESS_TOKEN para sincronizar este canal');
    const name=u.pathname.replace(/^\//,'');if(!/^(user\d+|\d+)$/.test(name))throw new Error('Usa el enlace de usuario Vimeo: vimeo.com/user12345');
    const r=await json('https://api.vimeo.com/users/'+name+'/videos?per_page=50&page='+Number(page||1),{headers:{Authorization:'Bearer '+process.env.VIMEO_ACCESS_TOKEN}});
    return {cursor:r.paging?.next?String(Number(page||1)+1):null,videos:(r.data||[]).map(v=>({external_id:v.uri.split('/').pop(),title:v.name,description:v.description||'',url:v.link,thumbnail:safeImage(v.pictures?.sizes?.at(-1)?.link),duration:v.duration||0,published_at:v.created_time,kind:'review'}))};
  }
  if(source.platform==='dailymotion'){
    const name=u.pathname.split('/').filter(Boolean).at(-1);if(!/^[\w-]+$/.test(name))throw new Error('Canal de Dailymotion inválido');
    const r=await json('https://api.dailymotion.com/user/'+name+'/videos?fields=id,title,description,url,thumbnail_url,duration,created_time&limit=50&page='+Number(page||1));
    return {cursor:r.has_more?String(Number(page||1)+1):null,videos:(r.list||[]).map(v=>({external_id:v.id,title:v.title,description:v.description||'',url:v.url,thumbnail:safeImage(v.thumbnail_url),duration:v.duration||0,published_at:new Date(v.created_time*1000).toISOString(),kind:'review'}))};
  }
  throw new Error('Rumble: añade los videos por enlace. La sincronización automática no está habilitada.');
}
function duration(s){const m=(s||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);return m?(Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0)):0;}
