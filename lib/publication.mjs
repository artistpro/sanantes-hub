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

