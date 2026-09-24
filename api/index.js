import {exclusionReason,excludeInterrupted} from '../lib/publication.mjs';
import {query} from '../lib/db.mjs';
import {token,hash,now,fail,origin,cookie,setSession,user,requireUser,rate,secretEqual,text,devAuth,hashPassword,verifyPassword} from '../lib/auth.mjs';
import {fetchSource,identify,mediaURL,platforms,safeImage} from '../lib/media.mjs';
import {organizePending} from '../lib/editorial.mjs';
import {randomUUID} from 'node:crypto';
import {classificationDefaults,classifierSettings,classify,classifyPending} from '../lib/classifier.mjs';
const id=()=>randomUUID();
const safeFileUrl=raw=>{if(typeof raw!=='string'||!raw)return '';if(raw.startsWith('data:application/pdf;')&&raw.length<=4500000)return raw;try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return ''}};
const defaults={title:'Comunidad Sanantes',subtitle:'El Podcast del Cáncer',intro:'Un espacio para aprender, escuchar y acompañarnos.',accent:'#d65337',donationGoal:'500',donationUrl:'https://paypal.me/podcastcancer',donationTitle:'Hagamos posible el próximo episodio',welcomePoints:'10',referralPoints:'20',privacyContact:'',privacyText:'',autoPublish:'1',googleClientId:process.env.GOOGLE_CLIENT_ID||''};
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
async function getRanking(){
  const rankingRaw=await query(`SELECT users.id,users.name,users.created_at,COALESCE(SUM(points.amount),0) total,(SELECT COUNT(*) FROM points p WHERE p.user_id=users.id AND p.reason='Nuevo miembro invitado') invites_count,(SELECT COUNT(*) FROM points p WHERE p.user_id=users.id AND p.event_key LIKE 'download_share:%') downloads_count,(SELECT COUNT(*) FROM donations d WHERE d.user_id=users.id) donations_count FROM users JOIN points ON users.id=points.user_id GROUP BY users.id HAVING total>0 ORDER BY total DESC,users.created_at ASC LIMIT 15`);
  const getBadges=u=>{const b=[];if(u.donations_count>0)b.push({id:'mecenas',label:'Mecenas',icon:'💛',title:'Aporte confirmado en PayPal'});if(u.invites_count>=3)b.push({id:'embajador',label:'Embajador',icon:'📢',title:'Invitó a 3 o más personas'});if(u.downloads_count>=2)b.push({id:'lector',label:'Lector',icon:'📖',title:'Difundió investigaciones y lecturas'});b.push({id:'pionero',label:'Pionero',icon:'🌱',title:'Miembro fundador'});return b;};
  const getLevel=t=>t>=500?'Guardián de la comunidad':t>=200?'Compañero de camino':t>=50?'Voz que acompaña':'Semilla de comunidad';
  return rankingRaw.map((u,idx)=>{const parts=u.name.trim().split(/\s+/);const maskedName=parts.length>1?`${parts[0]} ${parts[1][0]}.`:(parts[0]||'Miembro');return {rank:idx+1,id:u.id,name:maskedName,total:u.total,level:getLevel(u.total),badges:getBadges(u)};});
}
async function establishSession(res,member,ref=null){
  const s=await settings();
  const welcomed=await query('INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING RETURNING id',[id(),member.id,Number(s.welcomePoints),'Bienvenida a la comunidad','welcome:'+member.id]);
  if(welcomed.length&&ref){
    await query("INSERT INTO points(id,user_id,amount,reason,event_key) SELECT ?,shares.user_id,?,'Nuevo miembro invitado',? FROM shares JOIN videos ON videos.id=shares.video_id WHERE shares.id=? AND shares.user_id<>? AND videos.status='published' AND (SELECT COUNT(*) FROM points p WHERE p.user_id=shares.user_id AND p.reason='Nuevo miembro invitado' AND p.created_at>=date('now'))<5 ON CONFLICT(event_key) DO NOTHING",[id(),Number(s.referralPoints),'referral:'+member.id,ref,member.id]);
  }
  const session=token();
  await query('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)',[hash(session),member.id,now()+604800]);
  setSession(res,session);
  return {session,member:{id:member.id,email:member.email,name:member.name,role:member.role}};
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
    const u=new URL(req.url,'http://localhost');const path=u.searchParams.get('route')||u.pathname.replace(/^\/api\/?/,'');const method=req.method;
    if(!['GET','POST','DELETE','HEAD'].includes(method))fail('Método no permitido',405);
    if(method!=='GET' && method!=='HEAD' && req.headers.origin!==origin())fail('Origen de solicitud no permitido',403);
    if(path==='health')return send(res,{ok:true});
    if((path==='post/image'||path.endsWith('/image'))&&(method==='GET'||method==='HEAD')){
      const slugOrId=u.searchParams.get('slug')||u.searchParams.get('id')||path.replace(/^b\//,'').replace(/^blog\//,'').replace(/\/image$/,'');
      const [p]=(await query("SELECT image FROM posts WHERE slug=? OR id=?",[slugOrId,slugOrId]))||[];
      if(!p||!p.image)fail('Imagen no disponible',404);
      if(p.image.startsWith('https://')){
        res.statusCode=302;
        res.setHeader('Location',p.image);
        return res.end();
      }
      const match=p.image.match(/^data:([^;]+);base64,(.+)$/);
      if(!match)fail('Formato de imagen inválido',404);
      const mime=match[1];
      const buffer=Buffer.from(match[2],'base64');
      res.statusCode=200;
      res.setHeader('Content-Type',mime);
      res.setHeader('Content-Length',buffer.length);
      res.setHeader('Cache-Control','public, max-age=86400, s-maxage=604800');
      if(method==='HEAD') return res.end();
      return res.end(buffer);
    }
    if((path==='preview'||path.startsWith('v/')||path.startsWith('b/')||path.startsWith('video/')||path.startsWith('blog/'))&&(method==='GET'||method==='HEAD')){
      let type=u.searchParams.get('type')||'';
      let targetId=u.searchParams.get('id')||'';
      const ref=u.searchParams.get('ref')||'';
      if(!type&&(path.startsWith('v/')||path.startsWith('video/'))){type='video';targetId=path.replace(/^video\//,'').replace(/^v\//,'');}
      if(!type&&(path.startsWith('b/')||path.startsWith('blog/'))){type='blog';targetId=path.replace(/^blog\//,'').replace(/^b\//,'');}
      let title='Comunidad Sanantes · El Podcast del Cáncer';
      let desc='Videos, conversaciones y contenidos seleccionados por El Podcast del Cáncer. Un espacio para aprender y acompañarnos.';
      let image='https://i.ytimg.com/vi/008JfHS61Ww/hqdefault.jpg';
      let targetUrl=origin()+(ref?'/?ref='+encodeURIComponent(ref):'');
      let canonicalUrl=origin()+'/';
      if(type==='video'&&targetId){
        const [v]=(await query("SELECT id,title,description,thumbnail,external_id,platform FROM videos WHERE id=? OR external_id=?",[targetId,targetId]))||[];
        if(v){
          title=v.title+' · Sanantes';
          if(v.description)desc=v.description.slice(0,220).replace(/\s+/g,' ').trim();
          if(v.platform==='youtube'&&v.external_id){
            image=`https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg`;
          }else if(v.thumbnail){
            image=v.thumbnail;
          }
          targetUrl=origin()+(ref?'/?ref='+encodeURIComponent(ref):'/')+'#video/'+v.id;
          canonicalUrl=origin()+'/v/'+v.id;
        }
      }else if(type==='blog'&&targetId){
        const [p]=(await query("SELECT id,slug,title,excerpt,image FROM posts WHERE slug=? OR id=?",[targetId,targetId]))||[];
        if(p){
          title=p.title+' · Sanantes';
          if(p.excerpt)desc=p.excerpt.slice(0,220).replace(/\s+/g,' ').trim();
          if(p.image){
            if(p.image.startsWith('https://'))image=p.image;
            else if(p.image.startsWith('data:'))image=origin()+'/b/'+p.slug+'/image';
          }
          targetUrl=origin()+'/#blog/'+p.slug;
          canonicalUrl=origin()+'/b/'+p.slug;
        }
      }
      const escHtml=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const sTitle=escHtml(title),sDesc=escHtml(desc),sImg=escHtml(image),sUrl=escHtml(targetUrl),sCanon=escHtml(canonicalUrl);
      res.statusCode=200;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Cache-Control','public, max-age=60, s-maxage=300');
      if(method==='HEAD') return res.end();
      return res.end(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sTitle}</title><meta name="description" content="${sDesc}"><link rel="canonical" href="${sCanon}"><meta property="og:type" content="article"><meta property="og:site_name" content="Comunidad Sanantes"><meta property="og:title" content="${sTitle}"><meta property="og:description" content="${sDesc}"><meta property="og:image" content="${sImg}"><meta property="og:image:secure_url" content="${sImg}"><meta property="og:url" content="${sCanon}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${sTitle}"><meta name="twitter:description" content="${sDesc}"><meta name="twitter:image" content="${sImg}"><script>location.replace(${JSON.stringify(targetUrl)});</script></head><body style="font-family:system-ui,sans-serif;padding:24px;text-align:center;background:#f3f6f4;color:#18322d"><p>Cargando contenido en Sanantes… <a href="${sUrl}">Haz clic aquí para ver el contenido</a></p></body></html>`);
    }
    if(path==='public'&&method==='GET'){
      const s=await settings();const [total]=await query('SELECT COALESCE(SUM(amount),0) total FROM donations');
      return send(res,{settings:s,donated:total.total,sources:await query('SELECT id,name,platform,url,own,last_sync FROM sources WHERE enabled=1'),videos:(await query("SELECT videos.*,sources.name source_name,sources.own FROM videos LEFT JOIN sources ON sources.id=videos.source_id WHERE videos.status='published' AND videos.kind IN ('video','live') ORDER BY featured DESC,published_at DESC LIMIT 300")).filter(v=>!exclusionReason(v)),posts:await query("SELECT * FROM posts WHERE status='published' ORDER BY updated_at DESC"),me:await user(req),ranking:await getRanking()});
    }
    if(path==='auth/register'&&method==='POST'){
      const b=await body(req);const email=text(b.email,254).toLowerCase();const name=text(b.name,80)||email.split('@')[0];const password=typeof b.password==='string'?b.password:'';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Revisa tu correo electrónico');
      if(!b.consent)fail('Acepta la política de privacidad para continuar');
      if(password.length<6)fail('La contraseña debe tener al menos 6 caracteres');
      await rate('auth-reg-ip:'+(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown'),20);
      const [existing]=await query('SELECT id,email,password_hash FROM users WHERE email=?',[email]);
      if(existing&&existing.password_hash)fail('Este correo ya está registrado. Inicia sesión con tu contraseña.');
      const {hash:pHash,salt:pSalt}=hashPassword(password);
      const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
      const role=email===adminEmail?'admin':'member';
      if(existing){
        await query('UPDATE users SET name=?,password_hash=?,password_salt=?,role=CASE WHEN email=? THEN ? ELSE role END WHERE id=?',[name,pHash,pSalt,adminEmail,role,existing.id]);
      }else{
        await query('INSERT INTO users(id,email,name,role,password_hash,password_salt) VALUES(?,?,?,?,?,?)',[id(),email,name,role,pHash,pSalt]);
      }
      const [member]=await query('SELECT * FROM users WHERE email=?',[email]);
      const s=await establishSession(res,member,text(b.ref,64)||null);
      return send(res,{ok:true,me:s.member});
    }
    if(path==='auth/login'&&method==='POST'){
      const b=await body(req);const email=text(b.email,254).toLowerCase();const password=typeof b.password==='string'?b.password:'';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Revisa tu correo electrónico');
      if(!password)fail('Ingresa tu contraseña');
      await rate('auth-log-ip:'+(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown'),25);
      await rate('auth-log-email:'+email,6);
      const [u]=await query('SELECT id,email,name,role,password_hash,password_salt FROM users WHERE email=?',[email]);
      const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
      if(!u)fail('Correo o contraseña incorrectos',401);
      if(!u.password_hash){
        if(email===adminEmail){
          if(password.length<6)fail('La contraseña del administrador debe tener al menos 6 caracteres');
          const {hash:pHash,salt:pSalt}=hashPassword(password);
          await query('UPDATE users SET password_hash=?,password_salt=?,role=? WHERE id=?',[pHash,pSalt,'admin',u.id]);
        }else{
          fail('Tu cuenta no tiene contraseña asignada aún. Puedes crear una registrándote con este correo.',401);
        }
      }else{
        if(!verifyPassword(password,u.password_hash,u.password_salt))fail('Correo o contraseña incorrectos',401);
      }
      const [member]=await query('SELECT * FROM users WHERE email=?',[email]);
      const s=await establishSession(res,member,null);
      return send(res,{ok:true,me:s.member});
    }
    if(path==='auth/google'&&method==='POST'){
      const b=await body(req);const credential=text(b.credential,4000);
      if(!credential)fail('Falta la credencial de acceso de Google');
      await rate('auth-goog-ip:'+(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown'),30);
      let payload;
      try{
        const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(credential),{signal:AbortSignal.timeout(10000)});
        if(!r.ok)fail('Credencial de Google no válida',401);
        payload=await r.json();
      }catch(e){
        if(e.status)throw e;
        fail('No se pudo verificar la credencial con Google',502);
      }
      if(!payload.email||(payload.email_verified!=='true'&&payload.email_verified!==true))fail('El correo de Google no está verificado',401);
      const googleId=String(payload.sub);
      const email=String(payload.email).trim().toLowerCase();
      const name=text(payload.name||payload.given_name,80)||email.split('@')[0];
      const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
      const role=email===adminEmail?'admin':'member';
      const [existing]=await query('SELECT id,email,name,role,google_id FROM users WHERE google_id=? OR email=?',[googleId,email]);
      if(existing){
        await query('UPDATE users SET google_id=COALESCE(?,google_id),role=CASE WHEN email=? THEN ? ELSE role END WHERE id=?',[googleId,adminEmail,role,existing.id]);
      }else{
        await query('INSERT INTO users(id,email,name,role,google_id) VALUES(?,?,?,?,?)',[id(),email,name,role,googleId]);
      }
      const [member]=await query('SELECT * FROM users WHERE email=?',[email]);
      const s=await establishSession(res,member,text(b.ref,64)||null);
      return send(res,{ok:true,me:s.member});
    }
    if(path==='auth/request'&&method==='POST'){
      const b=await body(req);const email=text(b.email,254).toLowerCase();const name=text(b.name,80)||email.split('@')[0];if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Revisa tu correo electrónico');if(!b.consent)fail('Acepta la política de privacidad para continuar');
      await rate('auth-ip:'+(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown'),15);await rate('auth-email:'+email,3);
      if(!devAuth()&&(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM))fail('El correo de acceso aún no está conectado. Contacta al administrador.',503);
      const t=token();await query('INSERT INTO login_tokens(token,email,name,ref,expires) VALUES(?,?,?,?,?)',[hash(t),email,name,text(b.ref,64)||null,now()+900]);
      const link=origin()+'/api/auth/verify?token='+t;
      if(devAuth()||process.env.ALLOW_DEV_LINK==='1')return send(res,{ok:true,devLink:link});
      const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[email],subject:'Tu acceso a Comunidad Sanantes',text:`Abre este enlace para entrar a Comunidad Sanantes. Caduca en 15 minutos y solo funciona una vez.\n\n${link}\n\nSi no solicitaste este acceso, ignora este mensaje.`}),signal:AbortSignal.timeout(15000)});
      if(!r.ok){const err=await r.json().catch(()=>({}));await query('DELETE FROM login_tokens WHERE token=?',[hash(t)]);fail('No pudimos enviar el correo'+(err.message?': '+err.message:'')+'. Inténtalo más tarde.',502)}return send(res,{ok:true});
    }
    if(path==='auth/verify'&&method==='GET'){
      const raw=u.searchParams.get('token')||'';const [t]=await query('DELETE FROM login_tokens WHERE token=? AND expires>? RETURNING *',[hash(raw),now()]);if(!t)fail('El enlace ha caducado o ya fue utilizado. Solicita uno nuevo.');
      const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
      const role=t.email===adminEmail?'admin':'member';
      await query('INSERT INTO users(id,email,name,role) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role',[id(),t.email,t.name,role]);const [member]=await query('SELECT * FROM users WHERE email=?',[t.email]);
      await establishSession(res,member,t.ref);
      res.statusCode=302;res.setHeader('Location',origin()+(role==='admin'?'/#admin':'/#comunidad'));return res.end();
    }
    if(path==='auth/logout'&&method==='POST'){await query('DELETE FROM sessions WHERE token=?',[hash(cookie(req,'session'))]);setSession(res,'');return send(res,{ok:true});}
    if(path==='community'&&method==='GET'){
      const me=await requireUser(req);
      const ledger=await query('SELECT amount,reason,created_at FROM points WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[me.id]);
      const total=(await query('SELECT COALESCE(SUM(amount),0) total FROM points WHERE user_id=?',[me.id]))[0]?.total||0;
      const stats=(await query(`SELECT (SELECT COUNT(*) FROM points p WHERE p.user_id=? AND p.reason='Nuevo miembro invitado') invites_count,(SELECT COUNT(*) FROM points p WHERE p.user_id=? AND p.event_key LIKE 'download_share:%') downloads_count,(SELECT COUNT(*) FROM donations d WHERE d.user_id=?) donations_count`,[me.id,me.id,me.id]))[0]||{};
      const b=[];if(stats.donations_count>0)b.push({id:'mecenas',label:'Mecenas',icon:'💛',title:'Aporte confirmado en PayPal'});if(stats.invites_count>=3)b.push({id:'embajador',label:'Embajador',icon:'📢',title:'Invitó a 3 o más personas'});if(stats.downloads_count>=2)b.push({id:'lector',label:'Lector',icon:'📖',title:'Difundió investigaciones y lecturas'});b.push({id:'pionero',label:'Pionero',icon:'🌱',title:'Miembro fundador'});
      const getLevel=t=>t>=500?'Guardián de la comunidad':t>=200?'Compañero de camino':t>=50?'Voz que acompaña':'Semilla de comunidad';
      return send(res,{me,ledger,total,level:getLevel(total),badges:b,ranking:await getRanking()});
    }
    if(path==='share'&&method==='POST'){const me=await requireUser(req);const b=await body(req);if(!(await query("SELECT id FROM videos WHERE id=? AND status='published'",[text(b.videoId,64)])).length)fail('Video no disponible',404);await rate('share:'+me.id,50);await query('INSERT INTO shares(id,user_id,video_id) VALUES(?,?,?) ON CONFLICT(user_id,video_id) DO NOTHING',[id(),me.id,b.videoId]);const [s]=await query('SELECT id FROM shares WHERE user_id=? AND video_id=?',[me.id,b.videoId]);return send(res,{url:origin()+'/v/'+b.videoId+'?ref='+s.id});}
    if(path==='post/unlock'&&method==='POST'){const me=await user(req);const b=await body(req);const slug=text(b.slug,100);const [p]=(await query("SELECT id,title FROM posts WHERE slug=? AND status='published'",[slug]))||[];if(!p)fail('Artículo no disponible',404);let awarded=0;if(me){const s=await settings();const pts=Number(s.referralPoints||10);const r=await query("INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,'download_share:'||?||':'||?) ON CONFLICT(event_key) DO NOTHING RETURNING id",[id(),me.id,pts,'Compartir lectura: '+text(p.title,60),me.id,p.id]);if(r.length)awarded=pts;}return send(res,{ok:true,awarded});}
    if(path==='cron'&&method==='GET'){
      if(!secretEqual(req.headers.authorization||'', 'Bearer '+(process.env.CRON_SECRET||''))||!process.env.CRON_SECRET)fail('No autorizado',401);
      const sources=await query("SELECT * FROM sources WHERE enabled=1 AND platform!='rumble' ORDER BY COALESCE(last_sync,'') ASC LIMIT 1");const results=[];for(const s of sources){try{results.push({source:s.id,...await sync(s)})}catch(e){await query('UPDATE sources SET last_error=?,last_sync=CURRENT_TIMESTAMP WHERE id=?',[e.message,s.id]);results.push({source:s.id,error:e.message})}}
      await query('DELETE FROM rate_limits WHERE expires<?',[now()]);await query('DELETE FROM login_tokens WHERE expires<?',[now()]);await query('DELETE FROM sessions WHERE expires<?',[now()]);return send(res,{results});
    }
    if(path.startsWith('admin')){
      const me=await requireUser(req,true);
      if(path==='admin'&&method==='GET')return send(res,{classifierReady:!!process.env.TYPESAFE_API_KEY,classifications:await query('SELECT * FROM classifications ORDER BY created_at DESC LIMIT 100'),sources:await query('SELECT * FROM sources ORDER BY own DESC,name'),videos:await query('SELECT videos.*,media_labels.relevance,media_labels.response editorial_response FROM videos LEFT JOIN media_labels ON videos.id=media_labels.video_id ORDER BY videos.published_at DESC LIMIT 1000'),posts:await query('SELECT * FROM posts ORDER BY updated_at DESC'),users:await query('SELECT users.id,users.email,users.name,users.role,users.created_at,COALESCE(SUM(points.amount),0) points FROM users LEFT JOIN points ON users.id=points.user_id GROUP BY users.id'),settings:await settings(),        donations:await query('SELECT donations.*,users.name user_name,users.email user_email FROM donations LEFT JOIN users ON donations.user_id=users.id ORDER BY donations.created_at DESC'),audit:await query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 50')});
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
      if(path==='admin/donation'&&method==='POST'){
        const amount=Number(b.amount);
        if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)fail('Introduce un aporte válido en USD');
        const donorId=text(b.user_id,64)||null;
        if(donorId&&!(await query('SELECT id FROM users WHERE id=?',[donorId])).length)fail('Miembro seleccionado no encontrado');
        const donationId=id();
        await query('INSERT INTO donations(id,amount,note,user_id) VALUES(?,?,?,?)',[donationId,amount,text(b.note,300),donorId]);
        if(donorId){
          const pts=amount*10;
          await query('INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,?)',[id(),donorId,pts,'Mecenas Sanantes: Aporte voluntario ($'+amount+' USD)','donation:'+donationId]);
        }
        await audit(me.id,'Aporte registrado: '+amount+' USD'+(donorId?' (Mecenas: '+donorId+')':''));
        return send(res,{ok:true});
      }
      if(path==='admin/donation'&&method==='DELETE'){
        await query('DELETE FROM points WHERE event_key=?',['donation:'+text(b.id,64)]);
        await query('DELETE FROM donations WHERE id=?',[b.id]);
        await audit(me.id,'Aporte eliminado: '+text(b.id,64));
        return send(res,{ok:true});
      }
      if(path==='admin/points'&&method==='POST'){const amount=Number(b.amount);if(!Number.isSafeInteger(amount)||Math.abs(amount)>10000||!text(b.reason,200))fail('Indica los puntos y una razón');if(!(await query('SELECT id FROM users WHERE id=?',[b.user_id])).length)fail('Miembro no encontrado');await query('INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,?)',[id(),b.user_id,amount,text(b.reason,200),'manual:'+id()]);await audit(me.id,'Ajuste de puntos a '+b.user_id+': '+amount);return send(res,{ok:true});}
    }
    fail('No encontrado',404);
  }catch(e){const known=Number.isInteger(e.status);send(res,{error:known?e.message:(e.message.includes('UNIQUE constraint')?'Ese registro ya existe.':e.message.startsWith('Falta configurar')?e.message:(e.message||'No pudimos completar la operación. Revisa la configuración o vuelve a intentarlo.'))},known?e.status:500);if(!known)console.error(e.message);}
}
