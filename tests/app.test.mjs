import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
process.env.LOCAL_DATABASE_PATH=':memory:';process.env.DEV_AUTH='1';process.env.ADMIN_EMAIL='admin@example.test';delete process.env.TURSO_DATABASE_URL;delete process.env.VERCEL;
const {initialize}=await import('../scripts/init.mjs');await initialize();
const {default:handler}=await import('../api/index.js');const {query}=await import('../lib/db.mjs');const {youtubeKind,odyseeKind,mediaURL}=await import('../lib/media.mjs');const {formatEvidence}=await import('../lib/format-rules.mjs');const {classify,decision,classificationDefaults}=await import('../lib/classifier.mjs');
const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.APP_ORIGIN='http://127.0.0.1:'+server.address().port;const base=process.env.APP_ORIGIN;
after(()=>server.close());
async function call(path,b,cookie='',origin=base){return fetch(base+'/api/'+path,{method:b?'POST':'GET',redirect:'manual',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(b?{body:JSON.stringify(b)}:{})})}
async function login(email,ref){const r=await call('auth/request',{email,name:'Prueba',consent:true,ref});assert.equal(r.status,200);const link=(await r.json()).devLink;const verified=await fetch(link,{redirect:'manual'});assert.equal(verified.status,302);return {cookie:verified.headers.get('set-cookie').split(';')[0],link};}
test('Auth, curación, separación de directos y puntos verificados',async()=>{
 assert.equal((await call('admin')).status,401);
 assert.equal((await call('auth/request',{email:'x@test.com',consent:true},'','https://attacker.invalid')).status,403);
 const owner=await login('admin@example.test');assert.match(owner.cookie,/^session=/);
 assert.equal((await fetch(owner.link,{redirect:'manual'})).status,400,'magic link is single-use');
 const member=await login('member@example.test');assert.equal((await call('admin',null,member.cookie)).status,403);
 const pub=await (await call('public')).json();assert.ok(pub.videos.length>0);assert.ok(pub.videos.every(v=>['video','live'].includes(v.kind)));const initialVideos=pub.videos.filter(v=>v.kind==='video').length;
 const vid=pub.videos.find(v=>v.kind==='video');
 const share=await (await call('share',{videoId:vid.id},owner.cookie)).json();const share2=await (await call('share',{videoId:vid.id},owner.cookie)).json();assert.equal(share.url,share2.url);
 let c=await (await call('community',null,owner.cookie)).json();assert.equal(c.total,10,'sharing alone grants no points');
 const ref=new URL(share.url).searchParams.get('ref');await login('newperson@example.test',ref);c=await (await call('community',null,owner.cookie)).json();assert.equal(c.total,30);
 await login('newperson@example.test',ref);c=await (await call('community',null,owner.cookie)).json();assert.equal(c.total,30,'repeat login cannot farm points');
 assert.equal((await call('admin/video',{...vid,kind:'live'},member.cookie)).status,403);
 assert.equal((await call('admin/video',{...vid,kind:'review'},owner.cookie)).status,400,'unclassified content cannot be published');
 assert.equal((await call('admin/video',{...vid,kind:'live'},owner.cookie)).status,200);
 const changed=await (await call('public')).json();assert.equal(changed.videos.find(v=>v.id===vid.id).kind,'live');assert.equal(changed.videos.filter(v=>v.kind==='video').length,initialVideos-1);
 assert.equal((await call('admin/source',{name:'Attack',platform:'odysee',url:'https://169.254.169.254/latest/meta-data'},owner.cookie)).status,500);
  const postRes=await call('admin/post',{title:'Artículo con imagen y pdf',slug:'articulo-con-pdf',excerpt:'Un resumen',body:'## Título\n\n![Foto](https://images.unsplash.com/photo-1)\n\nTexto.',category:'Comunidad',status:'published',image:'https://images.unsplash.com/photo-featured',download_url:'https://drive.google.com/file/d/123/view',download_title:'Compendio PDF'},owner.cookie);assert.equal(postRes.status,200);
  const pubWithPost=await (await call('public')).json();const createdPost=pubWithPost.posts.find(p=>p.slug==='articulo-con-pdf');assert.ok(createdPost);assert.equal(createdPost.image,'https://images.unsplash.com/photo-featured');assert.equal(createdPost.download_url,'https://drive.google.com/file/d/123/view');assert.equal(createdPost.download_title,'Compendio PDF');
  const unlockRes=await call('post/unlock',{slug:'articulo-con-pdf'},owner.cookie);assert.equal(unlockRes.status,200);const unlockJson=await unlockRes.json();assert.ok(unlockJson.ok);
  await call('auth/logout',{},member.cookie);assert.equal((await call('community',null,member.cookie)).status,401);
});
test('Metadatos de directos terminados y URLs',()=>{
 assert.equal(youtubeKind({snippet:{liveBroadcastContent:'none'},liveStreamingDetails:{actualEndTime:'2026-01-01'}}),'live');
 assert.equal(youtubeKind({snippet:{liveBroadcastContent:'upcoming'}}),'live');
 assert.equal(youtubeKind({snippet:{liveBroadcastContent:'none'}}),'review');
 for(const url of ['http://youtube.com/watch?v=1','https://youtube.com.evil.test/','https://youtube.com@evil.test/'])assert.throws(()=>mediaURL(url,'youtube'));
 assert.equal(odyseeKind({title:'Música',duration:15}),'review');
 assert.equal(formatEvidence({title:'Episodio',duration:1801}).duration_over_30_minutes,true);
 assert.equal(formatEvidence({title:'Música terapéutica',duration:15}).musical_title,true);
 assert.equal(formatEvidence({title:'Episodio',duration:1801}).owner_confirmed_format,null);
});
test('Jev: contrato oficial, umbral, caché y falla segura',async()=>{
 process.env.TYPESAFE_API_KEY='mock-test-not-a-real-secret';const config={...classificationDefaults,classificationEnabled:'1'};let calls=0;
 const fetcher=async(url,opts)=>{calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');const p=JSON.parse(opts.body);assert.equal(p.questions.kind.type,'choice');assert.equal(p.model,'jev-1.13.0');if(p.state.platform==='odysee')assert.equal(p.state.format_evidence.duration_over_30_minutes,true);return {ok:true,json:async()=>({model:'jev-1.13.0',answers:{kind:{type:'choice',choice:'live',confidence:.98,probabilities:{live:.99,video:.005,review:.005}}},usage:{input_tokens:1000}})}};
 const video={id:'test-jev',platform:'youtube',title:'Programa grabado',description:'Contenido de prueba',duration:2000};
 assert.equal((await classify(video,config,fetcher)).kind,'live');assert.equal((await classify(video,config,fetcher)).cached,true);assert.equal(calls,1);
 assert.equal((await classify({...video,id:'test-jev-hint',platform:'odysee',duration:1801},config,fetcher)).kind,'live');assert.equal(calls,2);
 assert.equal(decision({type:'choice',choice:'video',confidence:.5,probabilities:{video:.6,live:.3,review:.1}},.9),'review');
 assert.throws(()=>decision({type:'choice',choice:'made-up',confidence:1}));
 await assert.rejects(()=>classify({...video,title:'Another'},config,async()=>({ok:false,status:429})),/429/);
 assert.equal((await query('SELECT SUM(input_tokens) total FROM classifications WHERE video_id=?',['test-jev']))[0].total,1000);
});
test('Etiquetado editorial respeta categorías manuales y separa temas ajenos',async()=>{
 const {storeLabels,validateLabel}=await import('../lib/editorial.mjs');
 assert.throws(()=>validateLabel({type:'choice',choice:'inventada',confidence:1},['music','care']));
 const [v]=await query("SELECT * FROM videos WHERE platform='odysee' LIMIT 1");
 const result={model:'jev-test',answers:{category:{type:'choice',choice:'music',confidence:.9},relevance:{type:'choice',choice:'relevant',confidence:.9}}};
 await storeLabels(v,result,100);assert.equal((await query('SELECT category FROM videos WHERE id=?',[v.id]))[0].category,'Música y relajación');
 await query('INSERT INTO editorial_overrides(video_id) VALUES(?)',[v.id]);await query('UPDATE videos SET category=? WHERE id=?',['Mi categoría',v.id]);await storeLabels(v,result,100);assert.equal((await query('SELECT category FROM videos WHERE id=?',[v.id]))[0].category,'Mi categoría');
 await query("INSERT INTO sources(id,name,platform,url,own) VALUES('curated-test','Prueba','youtube','https://youtube.com/@prueba',0)");
 await query("INSERT INTO videos(id,source_id,platform,external_id,title,url,kind,status) VALUES('external-test','curated-test','youtube','external-test','Contenido ajeno','https://youtube.com/watch?v=12345678901','video','published')");
 const [external]=await query("SELECT * FROM videos WHERE id='external-test'");await storeLabels(external,{...result,answers:{...result.answers,relevance:{type:'choice',choice:'off_topic',confidence:.9}}});assert.equal((await query("SELECT status FROM videos WHERE id='external-test'"))[0].status,'pending');
});

test('Jev decides short musical broadcasts and may reject duration evidence',async()=>{
 const config={...classificationDefaults,classificationEnabled:'1'};
 let called=0;
 const v={id:'short-test',source_id:'podcast-odysee',platform:'odysee',title:'Música para la paz interior',duration:15};
 const result=await classify(v,config,async(_,opts)=>{
   called++;const state=JSON.parse(opts.body).state;
   assert.equal(state.format_evidence.musical_title,true);
   assert.match(state.format_evidence.source_context,/stop after seconds/);
   return {ok:true,json:async()=>({answers:{kind:{type:'choice',choice:'review',confidence:.9,probabilities:{live:.05,video:.05,review:.9}}}})};
 });
 assert.equal(called,1);assert.equal(result.kind,'review');
});

test('Interrupted musical streams never qualify for publication; one hour qualifies',async()=>{
 const {exclusionReason}=await import('../lib/publication.mjs');
 const base={kind:'live',category:'Música y relajación'};
 for(const duration of [15,447,1771,3599])assert.ok(exclusionReason({...base,duration}));
 for(const duration of [3600,3601])assert.equal(exclusionReason({...base,duration}),null);
 assert.equal(exclusionReason({...base,kind:'video',duration:15}),null);
 assert.equal(exclusionReason({kind:'live',category:'Entrevistas',title:'Entrevista',duration:1500}),null);
});

test('Gamificación: donación otorga puntos Mecenas, insignias y posición en ranking público',async()=>{
 const owner=await login('admin@example.test');
 const donor=await login('donante@example.test');
 const [donorUser]=await query("SELECT id FROM users WHERE email='donante@example.test'");
 assert.ok(donorUser);

 // Owner registers a $25 USD donation assigned to donorUser
 const donRes=await call('admin/donation',{amount:25,note:'Aporte por PayPal',user_id:donorUser.id},owner.cookie);
 assert.equal(donRes.status,200);

 // Donor queries their community profile
 const cRes=await call('community',null,donor.cookie);
 assert.equal(cRes.status,200);
 const cJson=await cRes.json();
 assert.equal(cJson.total,260); // 10 welcome + 250 donation
 assert.equal(cJson.level,'Compañero de camino');
 assert.ok(cJson.badges.some(b=>b.id==='mecenas'));

 // Public ranking reflects the donor
 const pub=await (await call('public')).json();
 assert.ok(pub.ranking&&pub.ranking.length>0);
 const ranked=pub.ranking.find(r=>r.id===donorUser.id);
 assert.ok(ranked);
 assert.equal(ranked.total,260);
 assert.equal(ranked.level,'Compañero de camino');
 assert.ok(ranked.badges.some(b=>b.id==='mecenas'));
});

test('Vistas previas de redes sociales (/v/:id y /b/:slug) con OpenGraph y redirección',async()=>{
  const pub=await (await call('public')).json();
  const vid=pub.videos[0];
  const post=pub.posts[0];

  // Video preview endpoint
  const vRes=await fetch(base+'/api/v/'+vid.id+'?ref=test-ref');
  assert.equal(vRes.status,200);
  assert.match(vRes.headers.get('content-type'),/text\/html/);
  const vHtml=await vRes.text();
  assert.ok(vHtml.includes('<meta property="og:image" content="'+vid.thumbnail+'">'));
  assert.ok(vHtml.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(vHtml.includes('#video/'+vid.id));
  assert.ok(vHtml.includes('ref=test-ref'));

  // Blog preview endpoint
  const bRes=await fetch(base+'/api/b/'+post.slug);
  assert.equal(bRes.status,200);
  const bHtml=await bRes.text();
  assert.ok(bHtml.includes('<meta property="og:image" content="'+post.image+'">'));
  assert.ok(bHtml.includes('#blog/'+post.slug));
});
