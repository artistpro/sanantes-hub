let local;
export async function query(sql,args=[]) {
  if(process.env.TURSO_DATABASE_URL){
    const base=process.env.TURSO_DATABASE_URL.replace(/^(libsql|turso):/, 'https:');
    if(!base.startsWith('https://')) throw new Error('La base remota requiere HTTPS');
    const response=await fetch(base.replace(/\/$/,'')+'/v2/pipeline',{method:'POST',headers:{Authorization:`Bearer ${process.env.TURSO_AUTH_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args:args.map(v=>v===null?{type:'null'}:typeof v==='number'?{type:'integer',value:String(v)}:{type:'text',value:String(v)}),want_rows:true}},{type:'close'}]}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error('No se pudo conectar con la base de datos');
    const payload=await response.json();const r=payload.results?.[0];
    if(r?.type==='error') throw new Error('Error de base de datos: '+r.error.message);
    if(!r?.response?.result) throw new Error('Respuesta de base de datos inválida');
    const result=r.response.result;
    return result.rows.map(row=>Object.fromEntries(result.cols.map((c,i)=>[c.name,row[i].type==='null'?null:['integer','float'].includes(row[i].type)?Number(row[i].value):row[i].value])));
  }
  if(process.env.VERCEL || !process.env.LOCAL_DATABASE_PATH) throw new Error('Falta configurar la base de datos persistente');
  if(!local){const {DatabaseSync}=await import('node:sqlite');local=new DatabaseSync(process.env.LOCAL_DATABASE_PATH);local.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');}
  return local.prepare(sql).all(...args);
}
