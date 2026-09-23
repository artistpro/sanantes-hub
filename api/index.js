import {exclusionReason,excludeInterrupted} from '../lib/publication.mjs';
import {query} from '../lib/db.mjs';
import {token,hash,now,fail,origin,cookie,setSession,user,requireUser,rate,secretEqual,text,devAuth} from '../lib/auth.mjs';
import {fetchSource,identify,mediaURL,platforms,safeImage} from '../lib/media.mjs';
import {organizePending} from '../lib/editorial.mjs';
import {randomUUID} from 'node:crypto';
import {classificationDefaults,classifierSettings,classify,classifyPending} from '../lib/classifier.mjs';
const id=()=>randomUUID();
const safeFileUrl=raw=>{if(typeof raw!=='string'||!raw)return '';if(raw.startsWith('data:application/pdf;')&&raw.length<=4500000)return raw;try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return ''}};
const defaults={title:'Comunidad Sanantes',subtitle:'El Podcast del Cáncer',intro:'Un espacio para aprender, escuchar y acompañarnos.',accent:'#d65337',donationGoal:'500',donationUrl:'https://paypal.me/podcastcancer',donationTitle:'Hagamos posible el próximo episodio',welcomePoints:'10',referralPoints:'20',privacyContact:'',privacyText:'',autoPublish:'1'};
async function settings(){return {...defaults,...classificationDefaults,...Object.fromEntries((await query('SELECT * FROM settings')).map(x=>[x.key,x.value]))};}
async function body(req){if(req.body){if(typeof req.body==='string')return JSON.parse(req.body);return req.body;}let b='';for await(const c of req){b+=c;if(b.length>5000000)fail('El contenido supera el límite permitido',413)}return b?JSON.parse(b):{};}
function send(res,value,status=200){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
async function audit(actor,action){await query('INSERT INTO audit(id,actor,action) VALUES(?,?,?)',[id(),actor,action]);}
async function sync(source){
  const result=await fetchSource(source);let added=0,attempted=0;const config=await classifierSettings();const auto=(await settings()).autoPublish==='1';
  for(const v of result.videos){mediaURL(v.url,source.platform);const row=await query('INSERT INTO videos(id,source_id,platform,external_id,title,description,url,thumbnail,duration,published_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,external_id) DO NOTHING RETURNING id',[id(),source.id,source.platform,v.external_id,v.title.slice(0,400),v.description.slice(0,15000),v.url,v.thumbnail,v.duration,v.published_at,v.kind]);added+=row.length;if(row.length&&v.kind!=='review'&&auto)await query("UPDATE videos SET status='published' WHERE id=?",[row[0].id]);
  }
  await excludeInterrupted(query);
  let classificationError=null;
  if(config.classificationEnabled==='1'&&process.env.TYPESAFE_API_KEY){try{await classifyPending(10);await organizePending(10)}catch(e){classificationError=e.message}}
  await query('UPDATE sources SET cursor=?,external_id=COALESCE(?,external_id),last_sync=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?',[result.cursor||null,result.external_id||null,source.id]);
  return {added,hasMore:!!result.cursor,classificationError};
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
    const u=new URL(req.url,'http://localhost');const path=u.searchParams.get('route')||u.pathname.replace(/^\/api\/?/,'');const method=req.method;
    if(!['GET','POST','DELETE'].includes(method))fail('Método no permitido',405);
    if(method!=='GET' && req.headers.origin!==origin())fail('Origen de solicitud no permitido',403);
    if(path==='health')return send(res,{ok:true});
    if(path==='public'&&method==='GET'){
      const s=await settings();const [total]=await query('SELECT COALESCE(SUM(amount),0) total FROM donations');
      return send(res,{settings:s,donated:total.total,sources:await query('SELECT id,name,platform,url,own,last_sync FROM sources WHERE enabled=1'),videos:(await query("SELECT videos.*,sources.name source_name,sources.own FROM videos LEFT JOIN sources ON sources.id=videos.source_id WHERE videos.status='published' AND videos.kind IN ('video','live') ORDER BY featured DESC,published_at DESC LIMIT 300")).filter(v=>!exclusionReason(v)),posts:await query("SELECT * FROM posts WHERE status='published' ORDER BY updated_at DESC"),me:await user(req)});
    }
    if(path==='auth/request'&&method==='POST'){
      const b=await body(req);const email=text(b.email,254).toLowerCase();const name=text(b.name,80)||email.split('@')[0];if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Revisa tu correo electrónico');if(!b.consent)fail('Acepta la política de privacidad para continuar');
      await rate('auth-ip:'+(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown'),15);await rate('auth-email:'+email,3);
      if(!devAuth()&&(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM))fail('El correo de acceso aún no está conectado. Contacta al administrador.',503);
      const t=token();await query('INSERT INTO login_tokens(token,email,name,ref,expires) VALUES(?,?,?,?,?)',[hash(t),email,name,text(b.ref,64)||null,now()+900]);
      const link=origin()+'/api/auth/verify?token='+t;
      if(devAuth())return send(res,{ok:true,devLink:link});
      const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[email],subject:'Tu acceso a Comunidad Sanantes',text:`Abre este enlace para entrar a Comunidad Sanantes. Caduca en 15 minutos y solo funciona una vez.\n\n${link}\n\nSi no solicitaste este acceso, ignora este mensaje.`}),signal:AbortSignal.timeout(15000)});
      if(!r.ok){await query('DELETE FROM login_tokens WHERE token=?',[hash(t)]);fail('No pudimos enviar el correo. Inténtalo más tarde.',502)}return send(res,{ok:true});
    }
    if(path==='auth/verify'&&method==='GET'){
      const raw=u.searchParams.get('token')||'';const [t]=await query('DELETE FROM login_tokens WHERE token=? AND expires>? RETURNING *',[hash(raw),now()]);if(!t)fail('El enlace ha caducado o ya fue utilizado. Solicita uno nuevo.');
      const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
      const role=t.email===adminEmail?'admin':'member';
      await query('INSERT INTO users(id,email,name,role) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role',[id(),t.email,t.name,role]);const [member]=await query('SELECT * FROM users WHERE email=?',[t.email]);const s=await settings();
      const welcomed=await query('INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING RETURNING id',[id(),member.id,Number(s.welcomePoints),'Bienvenida a la comunidad','welcome:'+member.id]);
      if(welcomed.length&&t.ref){await query("INSERT INTO points(id,user_id,amount,reason,event_key) SELECT ?,shares.user_id,?,'Nuevo miembro invitado',? FROM shares JOIN videos ON videos.id=shares.video_id WHERE shares.id=? AND shares.user_id<>? AND videos.status='published' AND (SELECT COUNT(*) FROM points p WHERE p.user_id=shares.user_id AND p.reason='Nuevo miembro invitado' AND p.created_at>=date('now'))<5 ON CONFLICT(event_key) DO NOTHING",[id(),Number(s.referralPoints),'referral:'+member.id,t.ref,member.id]);}
      const session=token();await query('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)',[hash(session),member.id,now()+604800]);setSession(res,session);res.statusCode=302;res.setHeader('Location',origin()+(role==='admin'?'/#admin':'/#comunidad'));return res.end();
    }
    if(path==='auth/logout'&&method==='POST'){await query('DELETE FROM sessions WHERE token=?',[hash(cookie(req,'session'))]);setSession(res,'');return send(res,{ok:true});}
    if(path==='community'&&method==='GET'){const me=await requireUser(req);return send(res,{me,ledger:await query('SELECT amount,reason,created_at FROM points WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[me.id]),total:(await query('SELECT COALESCE(SUM(amount),0) total FROM points WHERE user_id=?',[me.id]))[0].total});}
    if(path==='share'&&method==='POST'){const me=await requireUser(req);const b=await body(req);if(!(await query("SELECT id FROM videos WHERE id=? AND status='published'",[text(b.videoId,64)])).length)fail('Video no disponible',404);await rate('share:'+me.id,50);await query('INSERT INTO shares(id,user_id,video_id) VALUES(?,?,?) ON CONFLICT(user_id,video_id) DO NOTHING',[id(),me.id,b.videoId]);const [s]=await query('SELECT id FROM shares WHERE user_id=? AND video_id=?',[me.id,b.videoId]);return send(res,{url:origin()+'/?ref='+s.id+'#video/'+b.videoId});}
    if(path==='post/unlock'&&method==='POST'){const me=await user(req);const b=await body(req);const slug=text(b.slug,100);const [p]=(await query("SELECT id,title FROM posts WHERE slug=? AND status='published'",[slug]))||[];if(!p)fail('Artículo no disponible',404);let awarded=0;if(me){const s=await settings();const pts=Number(s.referralPoints||10);const r=await query("INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,'download_share:'||?||':'||?) ON CONFLICT(event_key) DO NOTHING RETURNING id",[id(),me.id,pts,'Compartir lectura: '+text(p.title,60),me.id,p.id]);if(r.length)awarded=pts;}return send(res,{ok:true,awarded});}
    if(path==='cron'&&method==='GET'){
      if(!secretEqual(req.headers.authorization||'', 'Bearer '+(process.env.CRON_SECRET||''))||!process.env.CRON_SECRET)fail('No autorizado',401);
      const sources=await query("SELECT * FROM sources WHERE enabled=1 AND platform!='rumble' ORDER BY COALESCE(last_sync,'') ASC LIMIT 1");const results=[];for(const s of sources){try{results.push({source:s.id,...await sync(s)})}catch(e){await query('UPDATE sources SET last_error=?,last_sync=CURRENT_TIMESTAMP WHERE id=?',[e.message,s.id]);results.push({source:s.id,error:e.message})}}
      await query('DELETE FROM rate_limits WHERE expires<?',[now()]);await query('DELETE FROM login_tokens WHERE expires<?',[now()]);await query('DELETE FROM sessions WHERE expires<?',[now()]);return send(res,{results});
    }
    if(path.startsWith('admin')){
      const me=await requireUser(req,true);
      if(path==='admin'&&method==='GET')return send(res,{classifierReady:!!process.env.TYPESAFE_API_KEY,classifications:await query('SELECT * FROM classifications ORDER BY created_at DESC LIMIT 100'),sources:await query('SELECT * FROM sources ORDER BY own DESC,name'),videos:await query('SELECT videos.*,media_labels.relevance,media_labels.response editorial_response FROM videos LEFT JOIN media_labels ON videos.id=media_labels.video_id ORDER BY videos.published_at DESC LIMIT 1000'),posts:await query('SELECT * FROM posts ORDER BY updated_at DESC'),users:await query('SELECT users.id,users.email,users.name,users.role,users.created_at,COALESCE(SUM(points.amount),0) points FROM users LEFT JOIN points ON users.id=points.user_id GROUP BY users.id'),settings:await settings(),donations:await query('SELECT * FROM donations ORDER BY created_at DESC'),audit:await query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 50')});
      const b=await body(req);
      if(path==='admin/organize'&&method==='POST'){await rate('organize:'+me.id,12);try{const r=await organizePending();await audit(me.id,'Organización Jev: '+r.processed+' contenidos');return send(res,r)}catch(e){fail(e.message,502)}}
      if(path==='admin/classify'&&method==='POST'){await rate('classify:'+me.id,12);try{const result=await classifyPending();await audit(me.id,'Clasificación Jev: '+result.processed+' evaluados');return send(res,result)}catch(e){fail(e.message,502)}}
      if(path==='admin/source'&&method==='POST'){if(!platforms.includes(b.platform))fail('Plataforma no válida');mediaURL(b.url,b.platform);if(b.id){await query('UPDATE sources SET name=?,own=?,enabled=? WHERE id=?',[text(b.name,120),b.own?1:0,b.enabled?1:0,b.id]);}else{await query('INSERT INTO sources(id,name,platform,url,own) VALUES(?,?,?,?,?)',[id(),text(b.name,120)||b.platform,b.platform,b.url,b.own?1:0]);}await audit(me.id,'Fuente guardada: '+text(b.name));return send(res,{ok:true});}
      if(path==='admin/sync'&&method==='POST'){await rate('sync:'+me.id,30);const [s]=await query('SELECT * FROM sources WHERE id=?',[text(b.id,64)]);if(!s)fail('Fuente no encontrada',404);if(b.restart){s.cursor=null;await query('UPDATE sources SET cursor=NULL WHERE id=?',[s.id]);}try{const r=await sync(s);await audit(me.id,`Sincronización ${s.name}: ${r.added} nuevos`);return send(res,r)}catch(e){await query('UPDATE sources SET last_error=? WHERE id=?',[e.message,s.id]);fail(e.message,502);}}
      if(path==='admin/video'&&method==='POST'){
        if(!['video','live','review'].includes(b.kind)||!['pending','published','hidden'].includes(b.status))fail('Estado o tipo inválido');if(b.status==='published'&&b.kind==='review')fail('Clasifica el contenido como video o directo antes de publicarlo');
        const [existing]=b.id?await query('SELECT * FROM videos WHERE id=?',[b.id]):[];
        if(b.status==='published'&&exclusionReason({...existing,...b,duration:existing?.duration||0}))fail('Los directos musicales de menos de una hora están excluidos del catálogo');
        const title=text(b.title,400);if(!title)fail('Escribe un título');
        if(b.id)await query('UPDATE videos SET title=?,description=?,category=?,kind=?,status=?,featured=? WHERE id=?',[title,text(b.description,15000),text(b.category,80)||'Conversaciones',b.kind,b.status,b.featured?1:0,b.id]);
        else{if(!platforms.includes(b.platform))fail('Plataforma inválida');const external=identify(b.url,b.platform);if(!b.source_id||!(await query('SELECT id FROM sources WHERE id=? AND platform=?',[b.source_id,b.platform])).length)fail('Selecciona una fuente de la misma plataforma');await query('INSERT INTO videos(id,source_id,platform,external_id,title,description,url,thumbnail,published_at,kind,status,category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id(),b.source_id,b.platform,external,title,text(b.description,15000),b.url,safeImage(b.thumbnail),new Date().toISOString(),b.kind,b.status,text(b.category,80)||'Conversaciones']);}
        if(b.id)await query('INSERT INTO editorial_overrides(video_id) VALUES(?) ON CONFLICT(video_id) DO NOTHING',[b.id]);await audit(me.id,'Video editado: '+title);return send(res,{ok:true});
      }
      if(path==='admin/post'&&method==='POST'){const title=text(b.title,250),slug=text(b.slug,100);if(!title||!/^[-a-z0-9]+$/.test(slug)||!text(b.body,50000)||!['draft','published'].includes(b.status))fail('Revisa título, slug, contenido y estado');const postImg=(typeof b.image==='string'&&b.image.startsWith('data:image/')&&b.image.length<=600000)?b.image:safeImage(b.image);const dlUrl=safeFileUrl(b.download_url),dlTitle=text(b.download_title,150)||'';await query('INSERT INTO posts(id,slug,title,excerpt,body,category,status,image,download_url,download_title) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,excerpt=excluded.excerpt,body=excluded.body,category=excluded.category,status=excluded.status,image=excluded.image,download_url=excluded.download_url,download_title=excluded.download_title,updated_at=CURRENT_TIMESTAMP',[b.id||id(),slug,title,text(b.excerpt,500),text(b.body,50000),text(b.category,80)||'Comunidad',b.status,postImg||'',dlUrl,dlTitle]);await audit(me.id,'Artículo guardado: '+title);return send(res,{ok:true});}
      if(path==='admin/post'&&method==='DELETE'){await query('DELETE FROM posts WHERE id=?',[b.id]);await audit(me.id,'Artículo eliminado: '+text(b.id,64));return send(res,{ok:true});}
      if(path==='admin/settings'&&method==='POST'){
        for(const [key,val] of Object.entries(b)){if(!(key in {...defaults,...classificationDefaults}))continue;const value=text(String(val),['privacyText','classificationRules'].includes(key)?10000:600);if(key==='autoPublish'&&!['0','1'].includes(value))fail('Publicación automática inválida');if(key==='classificationEnabled'&&!['0','1'].includes(value))fail('Activación inválida');if(key==='classificationThreshold'&&(!Number.isFinite(Number(value))||Number(value)<0||Number(value)>1))fail('El umbral debe estar entre 0 y 1');if(key==='accent'&&!/^#[0-9a-f]{6}$/i.test(value))fail('Color inválido');if(['donationGoal','welcomePoints','referralPoints'].includes(key)&&(!/^\d+$/.test(value)||Number(value)>1000000000))fail('Introduce un número válido');if(key==='donationUrl'&&value){let url;try{url=new URL(value)}catch{fail('Enlace de donación inválido')};if(url.protocol!=='https:'||url.username||url.password)fail('El enlace de donación debe ser HTTPS');}await query('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,value]);}await audit(me.id,'Configuración actualizada');return send(res,{ok:true});
      }
      if(path==='admin/donation'&&method==='POST'){const amount=Number(b.amount);if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)fail('Introduce un aporte válido en USD');await query('INSERT INTO donations(id,amount,note) VALUES(?,?,?)',[id(),amount,text(b.note,300)]);await audit(me.id,'Aporte registrado: '+amount+' USD');return send(res,{ok:true});}
      if(path==='admin/donation'&&method==='DELETE'){await query('DELETE FROM donations WHERE id=?',[b.id]);await audit(me.id,'Aporte eliminado: '+text(b.id,64));return send(res,{ok:true});}
      if(path==='admin/points'&&method==='POST'){const amount=Number(b.amount);if(!Number.isSafeInteger(amount)||Math.abs(amount)>10000||!text(b.reason,200))fail('Indica los puntos y una razón');if(!(await query('SELECT id FROM users WHERE id=?',[b.user_id])).length)fail('Miembro no encontrado');await query('INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,?)',[id(),b.user_id,amount,text(b.reason,200),'manual:'+id()]);await audit(me.id,'Ajuste de puntos a '+b.user_id+': '+amount);return send(res,{ok:true});}
    }
    fail('No encontrado',404);
  }catch(e){const known=Number.isInteger(e.status);send(res,{error:known?e.message:(e.message.includes('UNIQUE constraint')?'Ese registro ya existe.':e.message.startsWith('Falta configurar')?e.message:(e.message||'No pudimos completar la operación. Revisa la configuración o vuelve a intentarlo.'))},known?e.status:500);if(!known)console.error(e.message);}
}
