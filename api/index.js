import {exclusionReason,excludeInterrupted} from '../lib/publication.mjs';
import {query} from '../lib/db.mjs';
import {token,hash,now,fail,origin,cookie,setSession,user,requireUser,requireEditor,rate,secretEqual,text,devAuth,hashPassword,verifyPassword} from '../lib/auth.mjs';
import {fetchSource,identify,mediaURL,platforms,safeImage} from '../lib/media.mjs';
import {organizePending} from '../lib/editorial.mjs';
import {randomUUID} from 'node:crypto';
import {getGeoEnrichment, renderGeoHtml} from '../lib/geo-enrichment.mjs';
import {classificationDefaults,classifierSettings,classify,classifyPending} from '../lib/classifier.mjs';
const id=()=>randomUUID();
const safeFileUrl=raw=>{if(typeof raw!=='string'||!raw)return '';if(raw.startsWith('data:application/pdf;')&&raw.length<=4500000)return raw;try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return ''}};
const defaults={title:'Comunidad Sanantes',subtitle:'El Podcast del Cáncer',intro:'Un espacio para aprender, escuchar y acompañarnos.',accent:'#d65337',donationGoal:'500',donationUrl:'https://paypal.me/podcastcancer',donationTitle:'Hagamos posible el próximo episodio',welcomePoints:'10',referralPoints:'20',privacyContact:'',privacyText:'',autoPublish:'1',googleClientId:process.env.GOOGLE_CLIENT_ID||'556094809768-t183rn0i6c4k3mkrnj0et9irjphmfd3a.apps.googleusercontent.com',homeFeaturedVideo1:'',homeFeaturedVideo2:'',homeFeaturedVideo3:'',homeFeaturedVideo4:'',homeFeaturedLive:'',homeFeaturedPost:'',homeFeaturedWiki:''};
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
let authSchemaChecked=false;
async function ensureAuthSchema(){
  if(authSchemaChecked)return;
  try{
    const cols=(await query('PRAGMA table_info(users)')).map(c=>c.name);
    if(!cols.includes('password_hash'))await query('ALTER TABLE users ADD COLUMN password_hash TEXT');
    if(!cols.includes('password_salt'))await query('ALTER TABLE users ADD COLUMN password_salt TEXT');
    if(!cols.includes('google_id'))await query('ALTER TABLE users ADD COLUMN google_id TEXT');
    await query('CREATE INDEX IF NOT EXISTS users_google ON users(google_id)');
    authSchemaChecked=true;
  }catch(e){console.warn('Auto-migración auth:',e.message);}
}
let wikiSchemaChecked=false;
async function ensureWikiSchema(){
  if(wikiSchemaChecked)return;
  try{
    await query(`CREATE TABLE IF NOT EXISTS wiki_categories(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,icon TEXT DEFAULT '📚',description TEXT DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await query(`CREATE TABLE IF NOT EXISTS wiki_articles(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,category_id TEXT REFERENCES wiki_categories(id),category TEXT NOT NULL DEFAULT 'Medicamentos Reposicionados',title TEXT NOT NULL,subtitle TEXT DEFAULT '',evidence_level TEXT DEFAULT 'Preclínica / In vitro',excerpt TEXT DEFAULT '',body TEXT NOT NULL,mechanisms TEXT DEFAULT '',clinical_status TEXT DEFAULT '',pubmed_citations TEXT DEFAULT '[]',related_video_ids TEXT DEFAULT '[]',status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),author_id TEXT REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await query('CREATE INDEX IF NOT EXISTS wiki_slug ON wiki_articles(slug)');
    await query('CREATE INDEX IF NOT EXISTS wiki_status ON wiki_articles(status)');
    const cats=await query('SELECT COUNT(*) count FROM wiki_categories');
    if(!cats[0]?.count){
      const defaultPillars=[
        ['cat-meds','medicamentos-reposicionados','Medicamentos Reposicionados','💊','Fármacos con perfil de seguridad aprobado y estudios en oncología complementaria.',1],
        ['cat-meta','estrategia-metabolica','Estrategia Metabólica y Biología Celular','🧬','Teoría metabólica, Efecto Warburg, cetosis terapéutica, autofagia y ratio GKI.',2],
        ['cat-refs','investigadores-referentes','Investigadores y Referentes','👨‍⚕️','Científicos, médicos y autores que lideran la investigación en salud integrativa.',3],
        ['cat-supp','suplementos-nutraceuticos','Suplementos y Nutracéuticos','🌿','Compuestos naturales, antioxidantes, micronutrientes y fitoterapéuticos con evidencia.',4],
        ['cat-ther','terapias-complementarias','Enfoques y Terapias Complementarias','🥗','Ayuno terapéutico, cámara hiperbárica, termoterapia, ejercicio y apoyo integral.',5]
      ];
      for(const p of defaultPillars){
        await query('INSERT INTO wiki_categories(id,slug,name,icon,description,sort_order) VALUES(?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING',p);
      }
    }
    const catRows = (await query('SELECT id, slug FROM wiki_categories')) || [];
    const catMap = {};
    for(const c of catRows) catMap[c.slug] = c.id;
    const catMedsId = catMap['medicamentos-reposicionados'] || 'cat-meds';
    const catMetaId = catMap['estrategia-metabolica'] || 'cat-meta';
    const catRefsId = catMap['investigadores-referentes'] || 'cat-refs';
    const catSuppId = catMap['suplementos-nutraceuticos'] || 'cat-supp';
    const catTherId = catMap['terapias-complementarias'] || 'cat-ther';

    const seedArticles=[
      {
        id:'wiki-ivermectina',slug:'ivermectina',category:'Medicamentos Reposicionados',category_id:catMedsId,
        title:'Ivermectina en Oncología: Mecanismos Celulares, Evidencia y Estudios',
        subtitle:'Antiparasitario macrocíclico con propiedades moduladoras del microambiente tumoral y mitofagia',
        evidence_level:'Preclínica / In vitro y Ensayos Fase I/II',
        excerpt:'Compendio científico sobre la ivermectina en oncología: modulación del transporte nuclear por importinas α/β, mitofagia tumoral, inhibición de la quinasa PAK1 y reversión de resistencia multidroga (MDR).',
        body:`## ¿Qué es la Ivermectina?\nLa ivermectina es un derivado semisintético de las avermectinas, una clase de lactonas macrocíclicas descubiertas por Satoshi Ōmura y William C. Campbell (Premio Nobel de Medicina 2015). Aprobada originalmente para uso antiparasitario humano, ha suscitado interés biomédico mundial por sus propiedades pleiotrópicas antitumorales.\n\n## Mecanismos de Acción Oncológica Investigados\n1. **Inhibición de Importinas α/β:** Bloqueo del transporte de proteínas diana hacia el núcleo neoplásico.\n2. **Mitofagia e Inducción de Apoptosis:** Alteración selectiva del potencial de membrana mitocondrial en células cancerígenas con incremento de ROS.\n3. **Bloqueo de la Proteína Quinasa PAK1:** Disminución de la proliferación y metástasis dependientes de PAK1.\n4. **Modulación de Glicoproteína P (P-gp):** Reversión de la resistencia a quimioterapia convencional.\n\n## Estado Clínico y Uso Regulatorio\nClasificada en fase de investigación preclínica y ensayos observacionales como fármaco reposicionado (drug repurposing). Requiere supervisión médica informada dentro de un marco de salud integrativa.`,
        mechanisms:'Inhibición importinas α/β, bloqueo PAK1, mitofagia tumoral, alteración ATP mitocondrial, modulación P-gp.',
        clinical_status:'Aprobado FDA/EMA como antiparasitario. Ensayos clínicos Fase I/II y estudios observacionales en oncología.',
        pubmed_citations:JSON.stringify(['29054452','33633575','32419409']),status:'published'
      },
      {
        id:'wiki-fenbendazol',slug:'fenbendazol',category:'Medicamentos Reposicionados',category_id:catMedsId,
        title:'Fenbendazol: Desestabilización de Microtúbulos, Captación de Glucosa y Evidencia Preclínica',
        subtitle:'Compuesto benzimidazol con actividad antimicrotubular y bloqueo metabólico en células tumorales',
        evidence_level:'Preclínica / Modelos Animales',
        excerpt:'Análisis farmacológico del fenbendazol: disrupción de la polimerización de tubulina, bloqueo del transportador GLUT de glucosa, inducción de estrés celular y sinergia terapéutica investigada.',
        body:`## ¿Qué es el Fenbendazol?\nEl fenbendazol es un carbamato de benzimidazol de amplio espectro, utilizado tradicionalmente en medicina veterinaria contra helmintos intestinales. Ha ganado notoriedad mundial a raíz de protocolos divulgativos y estudios preclínicos universitarios sobre reposicionamiento farmacológico.\n\n## Mecanismos Biológicos Observados\n1. **Inhibición de Microtúbulos:** Actúa de forma análoga a fármacos quimioterapéuticos convencionales como los taxanos, impidiendo el ensamblaje de la tubulina y provocando la detención del ciclo celular en la fase G2/M.\n2. **Bloqueo del Transporte de Glucosa:** Suprime los transportadores GLUT y la absorción de hexosa por parte de las células tumorales dependientes de glucólisis.\n3. **Restauración de p53:** Inducción de apoptosis mediada por la vía del gen supresor tumoral p53.`,
        mechanisms:'Detención ciclo celular G2/M, disrupción microtúbulos, inhibición transportador GLUT glucosa, reactivación p53.',
        clinical_status:'Uso veterinario estándar. Investigación off-label y preclínica en oncología; protocolos complementarios observacionales.',
        pubmed_citations:JSON.stringify(['30154681','12154388']),status:'published'
      },
      {
        id:'wiki-william-makis',slug:'william-makis',category:'Investigadores y Referentes',category_id:catRefsId,
        title:'Dr. William Makis, MD: Trayectoria, Investigaciones en Cáncer y Protocolos Reposicionados',
        subtitle:'Médico especialista en oncología, radiología y medicina nuclear (McGill University)',
        evidence_level:'Revisión Clínica / Casos Observacionales',
        excerpt:'Monografía biográfica y técnica del Dr. William Makis MD: educación médica, experiencia en medicina nuclear oncológica, divulgación en español sobre fármacos reposicionados y análisis de literatura científica indexada.',
        body:`## Trayectoria Profesional y Académica\nEl Dr. William Makis es un médico canadiense especializado en Oncología General, Radiología y Medicina Nuclear, graduado de la Facultad de Medicina de la Universidad McGill en Montreal. Ha diagnosticado y tratado a más de 10.000 pacientes oncológicos utilizando terapia de radionúclidos dirigidos y tomografía por emisión de positrones (PET).\n\n## Aportes a la Divulgación en Español\nEl Dr. Makis se ha convertido en una de las fuentes de mayor consulta internacional respecto a protocolos combinados de ivermectina, mebendazol y fenbendazol, contrastando la evidencia farmacológica con las necesidades de pacientes que buscan alternativas ante casos refractarios.`,
        mechanisms:'Terapia de radionúclidos dirigida, medicina nuclear, sinergia antiparasitaria, modulación inmunológica.',
        clinical_status:'Médico especialista certificado (Royal College of Physicians and Surgeons of Canada). Divulgador e investigador clínico.',
        pubmed_citations:JSON.stringify(['29054452','31080350','33633575']),status:'published'
      },
      {
        id:'wiki-berberina',slug:'berberina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Berberina: Activación de AMPK, Disrupción Metabólica y Control Glucémico Tumoral',
        subtitle:'Alcaloide vegetal isoquinolínico con efectos moduladores análogos a la metformina en oncología metabólica',
        evidence_level:'Ensayos Clínicos y Preclínica en Oncología',
        excerpt:'Compendio científico sobre la berberina: activación de la quinasa AMPK, inhibición de la vía mTOR, privación energética de glucosa (efecto Warburg), modulación de microbiota y pautas del protocolo del Dr. Pete Sulack.',
        body:`## ¿Qué es la Berberina?\nLa berberina es un alcaloide de amonio cuaternario extraído de plantas medicinales como *Berberis vulgaris* (agracejo) y *Coptis chinensis*. En medicina integrativa y oncología metabólica se considera uno de los miméticos naturales de la restricción calórica y de la metformina más potentes.\n\n## Mecanismos de Acción Oncológica y Metabólica\n1. **Activación de AMPK (AMP-activated protein kinase):** Actúa como sensor energético celular. Al encender AMPK, frena la vía anabólica mTOR, bloqueando la síntesis proteica de células tumorales.\n2. **Privación Glucémica e Insulínica (Efecto Warburg):** Disminuye la captación celular de glucosa e incrementa la sensibilidad insulínica periférica, quitando sustrato fermentable a los tumores.\n3. **Disrupción Mitocondrial Tumoral:** Inhibe parcialmente el complejo I de la cadena respiratoria mitocondrial neoplásica, elevando selectivamente el estrés oxidativo en células malignas.\n4. **Regulación de la Microbiota Intestinal:** Modula bacterias productoras de butirato y reduce endotoxinas proinflamatorias como el lipopolisacárido (LPS).\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 500 mg administrados de 2 a 3 veces al día, siempre junto con las comidas principales.\n* **Sinergia:** Suele combinarse con extracto de té verde (EGCG) o artemisinina para amplificar la disrupción metabólica tumoral.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nSi deseas incorporar este nutracéutico con estándares de pureza y biodisponibilidad verificados, puedes adquirirlo con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Berberina en iHerb →](https://www.iherb.com/search?kw=berberine&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación AMPK, inhibición mTOR, disminución glucemia e insulina, disrupción complejo I mitocondrial, modulación microbiota.',
        clinical_status:'Ampliamente utilizado en fitoterapia clínica y síndrome metabólico. Ensayos clínicos en curso en oncología integrativa.',
        pubmed_citations:JSON.stringify(['34226532','31582977','31908277']),status:'published'
      },
      {
        id:'wiki-curcumina',slug:'curcumina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Cúrcuma y Curcumina: Inhibición de NF-kB, Apagado Inflamatorio y Sinergia Terapéutica',
        subtitle:'Polifenol bioactivo de Curcuma longa con propiedades pleiotrópicas antitumorales y pro-apoptóticas',
        evidence_level:'Ensayos Clínicos Fase I/II y Metaanálisis',
        excerpt:'Monografía científica sobre la curcumina: inhibición del factor de transcripción maestro NF-kB, reducción de IL-6 y TNF-α, sinergia con fármacos reposicionados y pautas de absorción con lípidos del protocolo Dr. Sulack.',
        body:`## ¿Qué es la Curcumina?\nLa curcumina (diferuloilmetano) es el principal curcuminoide bioactivo del rizoma de *Curcuma longa*. Es una de las moléculas naturales más exhaustivamente estudiadas en la biomedicina moderna por su capacidad de modular múltiples vías de señalización oncogénica simultáneamente.\n\n## Mecanismos de Acción Oncológica\n1. **Inhibición Maestra de NF-kB:** Bloquea la translocación nuclear del factor kappa B, reduciendo la expresión de genes de proliferación celular, ciclooxigenasa-2 (COX-2) e interleucina 6 (IL-6).\n2. **Inducción de Apoptosis y Detención de Ciclo:** Activa caspasas pro-apoptóticas (caspasa-3 y caspasa-9) y promueve la detención celular en la fase G2/M.\n3. **Bloqueo de la Angiogénesis:** Suprime el factor de crecimiento endotelial vascular (VEGF), impidiendo la formación de nuevos vasos nutricios que alimentan el lecho tumoral.\n4. **Sinergia con Reposicionados:** Trabaja sinérgicamente con fenbendazol y mebendazol para potenciar la desestabilización de microtúbulos.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica recomendada:** 1.000 a 2.000 mg diarios divididos en dos tomas.\n* **Requisito de biodisponibilidad:** Debe consumirse siempre con grasas saludables (como aceite de coco, aguacate o aceite de oliva) o fórmulas que incluyan piperina/fitosomas para asegurar su absorción sistémica.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir fórmulas de curcumina estandarizada de alta absorción con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Curcumina en iHerb →](https://www.iherb.com/search?kw=curcumin%20turmeric&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición NF-kB, supresión COX-2 y VEGF, activación caspasas 3 y 9, reducción citoquinas proinflamatorias, sinergia antimicrotubular.',
        clinical_status:'Nutracéutico de grado alimentario y farmacéutico. Numerosos ensayos clínicos Fase I y II en oncología integrativa.',
        pubmed_citations:JSON.stringify(['30768910','31464319','28935748']),status:'published'
      },
      {
        id:'wiki-pectina-citrica-modificada',slug:'pectina-citrica-modificada',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Pectina Cítrica Modificada (MCP): Inhibición de Galectina-3 y Bloqueo de Metástasis',
        subtitle:'Polisacárido de bajo peso molecular diseñado para neutralizar vías de adhesión e invasión vascular tumoral',
        evidence_level:'Estudios Clínicos Observacionales y Preclínica',
        excerpt:'Revisión técnica de la Pectina Cítrica Modificada (MCP): afinidad selectiva por la Galectina-3, prevención de la migración metastásica, quelación de metales pesados y pautas de administración en ayunas del protocolo Dr. Sulack.',
        body:`## ¿Qué es la Pectina Cítrica Modificada (MCP)?\nLa Pectina Cítrica Modificada (como la fórmula estandarizada PectaSol) es una forma tratada enzimáticamente de la pectina de corteza de cítricos, cuyo peso molecular se reduce por debajo de 15 kiloDaltons. Esto le permite ser absorbida por el tracto digestivo e ingresar al torrente sanguíneo.\n\n## Mecanismos de Acción Oncológica y Antitóxica\n1. **Inhibición de la Galectina-3:** La Galectina-3 es una lectina promotora de metástasis sobreexpresada en células tumorales. La MCP se une competitivamente a sus dominios de reconocimiento de carbohidratos, impidiendo que el tumor se adhiera a las paredes vasculares o forme colonias secundarias.\n2. **Reversión del Escape Inmunológico:** Al bloquear la Galectina-3, se elimina el camuflaje que impide que las células Natural Killer (NK) y linfocitos T reconozcan y destruyan al tumor.\n3. **Quelación Suave de Metales Pesados:** Se une al plomo, mercurio y cadmio para su eliminación renal sin arrastrar minerales benéficos esenciales como calcio, magnesio o zinc.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica recomendada:** 5 a 15 gramos diarios, disueltos en agua templada o zumo bajo en azúcar.\n* **Modo de toma:** Obligatoriamente con el estómago vacío (al menos 30 minutos antes de alimentos o 2 horas después) para garantizar absorción completa.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir Pectina Cítrica Modificada certificada con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Pectina Cítrica Modificada en iHerb →](https://www.iherb.com/search?kw=modified%20citrus%20pectin&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Bloqueo competitivo Galectina-3, inhibición adhesión metastásica, reactivación vigilancia células NK, quelación selectiva metales pesados.',
        clinical_status:'Nutracéutico patentado con ensayos clínicos evaluando duplicación de antígeno prostático específico (PSA) y tiempo libre de progresión.',
        pubmed_citations:JSON.stringify(['31604462','29871788','18641477']),status:'published'
      },
      {
        id:'wiki-hongos-medicinales',slug:'hongos-medicinales',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Hongos Medicinales (Reishi, Melena de León, Cola de Pavo): Inmunomodulación y Neuroprotección',
        subtitle:'Complejo macromiceto rico en beta-glucanos 1,3/1,6 para activación de células NK y regeneración neuronal',
        evidence_level:'Ensayos Clínicos Aleatorizados y Revisiones Sistemáticas',
        excerpt:'Análisis integral de los hongos medicinales: Coriolus versicolor (Cola de Pavo), Ganoderma lucidum (Reishi) y Hericium erinaceus (Melena de León). Potenciación de linfocitos T, células NK, estimulación de NGF y soporte cognitivo.',
        body:`## El Rol de la Micología Médica en Oncología\nLos hongos medicinales representan una de las terapias coadyuvantes más aceptadas a nivel mundial. Especies como *Trametes versicolor* (Cola de Pavo), *Ganoderma lucidum* (Reishi) y *Hericium erinaceus* (Melena de León) concentran polisacáridos complejos y triterpenos con alta bioactividad inmunológica.\n\n## Mecanismos Biológicos Observados\n1. **Reconocimiento por Receptores Dectina-1:** Los beta-1,3/1,6-D-glucanos se acoplan a receptores de la inmunidad innata en macrófagos y células dendríticas, desencadenando una respuesta coordinada citotóxica contra células anormales.\n2. **Incremento de Células Natural Killer (NK):** Numerosos ensayos demuestran que fracciones como el polisacárido-K (PSK) y polisacárido-péptido (PSP) duplican la actividad lítica de células NK.\n3. **Estimulación de NGF (Nerve Growth Factor):** Las erinacinas y hericenonas de la Melena de León cruzan la barrera hematoencefálica estimulando la neurogénesis, clave en tumores del sistema nervioso y neurotoxicidad por quimioterapia.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 2 cápsulas al día de extracto estandarizado de cuerpo fructífero con alimentos.\n* **Recomendación de calidad:** Elegir siempre extractos certificados en beta-glucanos (evitar productos basados únicamente en biomasa de grano/almidón).\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir complejos de hongos medicinales de espectro completo con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones de Hongos Medicinales (Reishi, Melena de León, Cola de Pavo) en iHerb →](https://www.iherb.com/search?kw=mushroom%20reishi%20lions%20mane%20turkey%20tail&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación receptores dectina-1, estimulación células Natural Killer y linfocitos T citotóxicos, secreción de NGF cerebral, modulación microbioma.',
        clinical_status:'Extractos PSK y PSP aprobados como coadyuvantes oncológicos oficiales en hospitales de Japón y China desde la década de 1980.',
        pubmed_citations:JSON.stringify(['33574805','30806254','28574925']),status:'published'
      },
      {
        id:'wiki-te-verde-egcg',slug:'te-verde-egcg',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Epigalocatequina Galato (EGCG / Té Verde): Modulación Epigenética y Bloqueo de la Angiogénesis',
        subtitle:'Catequina polifenólica de alta potencia con capacidad de alterar el metabolismo energético tumoral',
        evidence_level:'Ensayos Clínicos y Evidencia Mecanicista',
        excerpt:'Investigación técnica sobre el EGCG del té verde: inhibición de receptores VEGF y angiogénesis, alteración del metabolismo de la glutamina, protección antioxidante del ADN y dosificación del extracto en el protocolo de resiliencia.',
        body:`## ¿Qué es el EGCG?\nEl galato de epigalocatequina (EGCG) es la catequina polifenólica más abundante y biológicamente activa de las hojas de *Camellia sinensis* (té verde). Posee propiedades quimiopreventivas y quimiosensibilizantes reconocidas por institutos oncológicos internacionales.\n\n## Mecanismos de Acción Oncológica\n1. **Inhibición del Factor de Crecimiento Endotelial (VEGF):** Bloquea la señalización de tirosina quinasa de los receptores VEGFR-1 y VEGFR-2, impidiendo la neovascularización tumoral.\n2. **Disrupción del Metabolismo de Glutamina:** Interfiere con la enzima glutaminasa en tumores adictos a la glutamina, cerrando una de las vías de escape metabólico descritas por Jane McLelland.\n3. **Modulación Epigenética:** Inhibe las ADN metiltransferasas (DNMT), reactivando la expresión de genes supresores de tumores que habían sido silenciados por hipermetilación.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica:** 1 a 2 cápsulas al día de extracto estandarizado (MetaboLeaf) repartidas con las comidas.\n* **Precaución:** Preferir cápsulas descafeinadas y tomarlas con alimentos para evitar irritación gástrica o sobrecarga hepática con dosis excesivas en ayunas.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir extractos de té verde estandarizados en EGCG con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de EGCG y Té Verde en iHerb →](https://www.iherb.com/search?kw=egcg%20green%20tea&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición tirosina quinasa VEGFR, modulación DNMT epigenética, interferencia glutaminólisis tumoral, neutralización radicales hidroxilo.',
        clinical_status:'Suplemento dietético estandarizado. Investigado en ensayos clínicos Fase II para prevención de recurrencias en tumores sólidos.',
        pubmed_citations:JSON.stringify(['33435478','31096590','29452285']),status:'published'
      },
      {
        id:'wiki-aceite-semilla-negra',slug:'aceite-semilla-negra-timoquinona',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Aceite de Semilla Negra (Nigella Sativa): Timoquinona, Apoptosis y Modulación Inmune',
        subtitle:'Fitocompuesto bioactivo con propiedades anticancerígenas, hepatoprotectoras y antiinflamatorias comprobadas',
        evidence_level:'Preclínica Avanzada y Estudios Clínicos Observacionales',
        excerpt:'Monografía científica sobre el aceite de comino negro (Nigella sativa): concentración de timoquinona, inducción de apoptosis mediada por caspasas, modulación de autofagia tumoral y protección hepática durante tratamientos.',
        body:`## ¿Qué es el Aceite de Nigella Sativa?\nEl aceite prensado en frío de las semillas de *Nigella sativa* (comino negro) ha sido utilizado durante milenios en las medicinas tradicionales de Oriente Medio y el Mediterráneo. Su componente fitoquímico estelar es la **timoquinona**, una quinona monoterpénica con un perfil farmacológico sobresaliente.\n\n## Mecanismos Antitumorales de la Timoquinona\n1. **Inducción Selectiva de Apoptosis:** Incrementa la proporción de proteínas pro-apoptóticas Bax frente a las anti-apoptóticas Bcl-2, liberando citocromo C mitocondrial y activando caspasas destructoras del tumor.\n2. **Modulación de la Autofagia:** Puede inducir autofagia celular citotóxica en líneas celulares tumorales resistentes a quimioterapia convencional.\n3. **Hepatoprotección de Fase I/II:** Protege el tejido hepático y renal frente a la nefrotoxicidad y hepatotoxicidad inducida por fármacos oncológicos.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 1 cápsula de aceite puro prensado en frío de 1 a 2 veces al día junto con las comidas (o 1 cucharadita de aceite líquido virgen).\n* **Criterio de pureza:** Asegurar que sea aceite virgen 100% puro, prensado en frío y libre de solventes químicos.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir aceite de semilla negra estandarizado en timoquinona con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Aceite de Semilla Negra en iHerb →](https://www.iherb.com/search?kw=black%20seed%20oil%20nigella%20sativa&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Aumento ratio Bax/Bcl-2, activación caspasas 3 y 9, modulación autofagia tumoral, inhibición NF-kB, citoprotección hepatorrenal.',
        clinical_status:'Complemento nutricional de uso tradicional extendido con creciente documentación en ensayos clínicos sobre marcadores inflamatorios.',
        pubmed_citations:JSON.stringify(['30138241','33668832','31163624']),status:'published'
      },
      {
        id:'wiki-melatonina',slug:'melatonina-oncologia',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Melatonina en Oncología: Sincronización Circadiana, Oncostasis y Protección Mitocondrial',
        subtitle:'Indolamina antioxidante de acción pleiotrópica como modulador inmune y agente pro-apoptótico en cáncer',
        evidence_level:'Múltiples Ensayos Clínicos Aleatorizados y Metaanálisis',
        excerpt:'Guía clínica de la melatonina en oncología integrativa: acción antioxidante mitocondrial, inhibición de la vía de la aromatasa y del metabolismo de la glucosa, mejora de la supervivencia en ensayos clínicos y dosificación nocturna (5-20 mg).',
        body:`## Más Allá del Sueño: La Melatonina como Oncostático\nAunque popularmente conocida como la hormona del sueño, la melatonina (*N-acetil-5-metoxitriptamina*) es producida de forma ubicua por las mitocondrias de casi todas las células del organismo. En oncología clínica se clasifica como una molécula con actividad oncostática de amplio espectro.\n\n## Mecanismos Celulares en Oncología\n1. **Captación Mitocondrial Directa:** A través de transportadores de oligopéptidos PEPT1 y PEPT2, la melatonina se acumula en la matriz mitocondrial protegiendo el ADN mitocondrial sano de mutaciones inducidas por radicales libres.\n2. **Inhibición del Efecto Warburg:** Desacopla la glucólisis aeróbica tumoral forzando a las células cancerosas a depender de la fosforilación oxidativa, lo que precipita apoptosis en células tumorales con mitocondrias defectuosas.\n3. **Antiaromatasa y Modulación Hormonal:** Reduce la actividad de la enzima aromatasa en tumores hormono-dependientes (mama y próstata), disminuyendo la síntesis local de estrógenos.\n4. **Inmunovigilancia Nocturna:** Promueve la proliferación de linfocitos T cooperadores y células NK durante las fases de sueño profundo.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 5 a 20 mg administrados entre 30 y 60 minutos antes de acostarse en habitación totalmente a oscuras.\n* **Rango oncológico:** A diferencia de las dosis de insomnio (0.5 a 3 mg), los protocolos oncológicos integrativos utilizan dosis elevadas toleradas de forma segura sin toxicidad conocida.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir melatonina pura en dosis clínicas con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Melatonina en iHerb →](https://www.iherb.com/search?kw=melatonin&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Captación mitocondrial PEPT1/2, reversión efecto Warburg, inhibición aromatasa, estimulación linfocitos T y células NK, captación radicales hidroxilo.',
        clinical_status:'Metaanálisis de más de 20 ensayos clínicos aleatorizados respaldan su uso como adyuvante oncológico con mejoras en supervivencia y calidad de vida.',
        pubmed_citations:JSON.stringify(['32070007','30248888','29235948']),status:'published'
      },
      {
        id:'wiki-cardo-mariano',slug:'cardo-mariano-silimarina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Cardo Mariano (Silimarina): Regeneración Hepática, Glutatión y Fase II de Detoxificación',
        subtitle:'Complejo de flavonolignanos para la protección hepatocelular ante sobrecargas farmacológicas y toxinas',
        evidence_level:'Ensayos Clínicos y Revisiones Sistemáticas Cochrane',
        excerpt:'Evaluación farmacodinámica de la silimarina del cardo mariano (Silybum marianum): incremento de la síntesis proteica hepática, regeneración de glutatión endógeno, estabilización de membranas celulares y detoxificación en protocolos oncológicos.',
        body:`## ¿Qué es el Cardo Mariano y la Silimarina?\nEl cardo mariano (*Silybum marianum*) es una planta mediterránea cuyo extracto purificado de semillas contiene **silimarina**, un complejo isomérico de flavonolignanos compuesto principalmente por silibinina A y B, silicristina y silidianina.\n\n## Mecanismos de Soporte Hepático y Celular\n1. **Estimulación de la Síntesis Proteica Ribosomal:** Activa la ARN polimerasa I ribosomal en los hepatocitos, acelerando la regeneración y reparación de las células hepáticas dañadas por tratamientos farmacológicos.\n2. **Mantenimiento y Síntesis de Glutatión:** Protege las reservas intracelulares de glutatión hepático frente a la depleción provocada por fármacos y xenobióticos.\n3. **Estabilización de Membranas Celulares:** Altera la estructura de la membrana externa del hepatocito, impidiendo la penetración de toxinas a nivel citoplasmático.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 1 a 2 cápsulas diarias estandarizadas (80% silimarina) con las comidas principales.\n* **Uso combinado:** Excelente complemento durante terapias con medicamentos reposicionados (como mebendazol, fenbendazol o ivermectina) para mantener transaminasas en rango óptimo.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir extracto de cardo mariano estandarizado con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Cardo Mariano (Milk Thistle) en iHerb →](https://www.iherb.com/search?kw=milk%20thistle%20silymarin&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación ARN polimerasa I, preservación glutatión hepático, estabilización de membrana celular contra xenobióticos, acción antioxidante directa.',
        clinical_status:'Monografía oficial de la Comisión E alemana y fitofármaco ampliamente prescrito en Europa para hepatoprotección.',
        pubmed_citations:JSON.stringify(['30568019','31238470','29534435']),status:'published'
      },
      {
        id:'wiki-omega-3',slug:'omega-3-epa-dha',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Ácidos Grasos Omega-3 (EPA / DHA): Resolución de Inflamación, Membrana Celular y Anticachexia',
        subtitle:'Lípidos bioactivos esenciales y mediadores pro-resolutivos especializados en el paciente oncológico',
        evidence_level:'Guías Clínicas ESPEN y Ensayos Clínicos Aleatorizados',
        excerpt:'Monografía científica sobre los ácidos grasos poliinsaturados omega-3: producción de resolvinas y protectinas (SPMs), alteración de las balsas lipídicas en células neoplásicas, preservación de masa muscular y dosis clínica de 2.000 mg.',
        body:`## Los Omega-3 en el Contexto Oncológico\nLos ácidos grasos poliinsaturados de cadena larga omega-3, específicamente el ácido eicosapentaenoico (**EPA**) y el ácido docosahexaenoico (**DHA**), son nutrientes estructurales fundamentales que compiten activamente con el ácido araquidónico proinflamatorio en las membranas celulares.\n\n## Mecanismos Celulares y Anti-Caquexia\n1. **Precursores de Mediadores Pro-Resolutivos (SPMs):** El EPA y el DHA generan resolvinas (series E y D), protectinas y maresinas, las cuales apagan la cascada inflamatoria sin causar inmunosupresión.\n2. **Alteración de Balsas Lipídicas (Lipid Rafts):** Su incorporación a las membranas de células malignas altera la conformación de receptores de factores de crecimiento, sensibilizando al tumor a la apoptosis.\n3. **Preservación de Masa Magra:** Inhiben la vía de la ubiquitina-proteasoma en el músculo esquelético inducida por citoquinas tumorales, contrarrestando la sarcopenia y la caquexia oncológica.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica recomendada:** 2.000 mg diarios combinados de EPA y DHA en forma de triglicéridos purificados.\n* **Control de calidad:** Deben ser aceites purificados molecularmente con certificación IFOS (International Fish Oil Standards) para garantizar ausencia total de metales pesados y oxidación.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir aceite de pescado Omega-3 purificado molecularmente con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Omega-3 EPA/DHA en iHerb →](https://www.iherb.com/search?kw=omega%203%20epa%20dha&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Síntesis de resolvinas y protectinas SPMs, alteración de balsas lipídicas de membrana, supresión vía ubiquitina-proteasoma muscular, reducción PGE2.',
        clinical_status:'Incluido en las Guías Europeas de Nutrición Clínica en Oncología (ESPEN) para pacientes con pérdida de peso o inflamación sistémica.',
        pubmed_citations:JSON.stringify(['30415309','32575416','31872166']),status:'published'
      },
      {
        id:'wiki-ashwagandha',slug:'ashwagandha-withania',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Ashwagandha (Withania somnifera): Regulación del Cortisol, Eje HPA y Propiedades Oncostáticas',
        subtitle:'Adaptógeno ayurvédico estandarizado en withanólidos para la resiliencia neuroinmune y antitumoral',
        evidence_level:'Ensayos Clínicos en Estrés/Fatiga y Preclínica Oncológica',
        excerpt:'Revisión exhaustiva de la Ashwagandha (Withania somnifera): modulación de los niveles de cortisol mediante regulación del eje hipotálamo-hipófisis-adrenal, actividad citotóxica de la withaferina A y reducción de fatiga en pacientes.',
        body:`## El Papel del Estrés y el Cortisol en el Microambiente Tumoral\nEl estrés crónico sostenido eleva de forma patológica el cortisol y las catecolaminas, desactivando la respuesta inmune mediada por células NK y linfocitos citotóxicos. La *Withania somnifera* (Ashwagandha) es el adaptógeno por excelencia para modular esta disfunción neuroendocrina.\n\n## Mecanismos Bioquímicos\n1. **Modulación del Eje Hipotálamo-Hipófisis-Adrenal (HPA):** Disminuye de forma medible el cortisol sérico matutino y la hormona adrenocorticotrópica (ACTH), restaurando la sensibilidad del sistema inmune.\n2. **Actividad de la Withaferina A:** Esta lactona esteroidal interactúa con la proteína de choque térmico Hsp90 e induce estrés proteotóxico selectivo en células cancerosas, favoreciendo su muerte programada.\n3. **Mitigación de la Fatiga y Neuroprotección:** Apoya la recuperación cognitiva (quimiocerebro) y mejora los niveles de energía mitocondrial.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 600 mg al día de extracto estandarizado de raíz completa (KSM-66 o Sensoril).\n* **Modo de empleo:** Puede tomarse por la mañana para energía adaptativa o por la tarde/noche para reducir el estrés y promover el descanso reparador.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir extracto de Ashwagandha KSM-66 con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Ashwagandha en iHerb →](https://www.iherb.com/search?kw=ashwagandha%20ksm-66&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Atenuación eje HPA, reducción cortisol sérico, inhibición chaperona Hsp90 por withaferina A, modulación receptores GABAérgicos cerebrales.',
        clinical_status:'Múltiples ensayos clínicos aleatorizados doble ciego controlados con placebo en reducción de cortisol, estrés y fatiga.',
        pubmed_citations:JSON.stringify(['31517876','32021735','30466985']),status:'published'
      },
      {
        id:'wiki-graviola',slug:'graviola-guanabana',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Graviola / Guanábana (Annona muricata): Acetogeninas y Disrupción Mitocondrial Tumoral',
        subtitle:'Extracto botánico rico en acetogeninas annonáceas con acción citotóxica selectiva en células malignas',
        evidence_level:'Preclínica In vitro / In vivo y Estudios Etnobotánicos',
        excerpt:'Compendio sobre la Annona muricata (Graviola): inhibición del complejo I de la cadena de transporte electrónico mitocondrial, privación de ATP en células malignas hipermetabólicas, precauciones de seguridad y pautas de uso integrativo.',
        body:`## ¿Qué es la Graviola y sus Acetogeninas?\nLa *Annona muricata* (conocida popularmente como guanábana, graviola o soursop) es un árbol frutal tropical perteneciente a la familia Annonaceae. Sus hojas y tallos albergan una familia única de derivados de ácidos grasos de cadena larga denominados **acetogeninas annonáceas** (como la annonacina y la bullatacina).\n\n## Mecanismos Celulares Investigados\n1. **Inhibición del Complejo I Mitocondrial:** Las acetogeninas actúan como potentes inhibidores de la enzima NADH:ubiquinona oxidorreductasa en la membrana interna mitocondrial, cortando el flujo de electrones necesario para sintetizar ATP.\n2. **Vulnerabilidad de Tumores Hipermetabólicos:** Dado que las células tumorales tienen una demanda metabólica de energía exponencialmente mayor a las células sanas, la caída abrupta de ATP induce detención del ciclo celular y apoptosis.\n3. **Bloqueo de Bombas de Eflujo:** Inhibe la actividad de bombas dependientes de ATP que las células tumorales utilizan para expulsar quimioterápicos (resistencia multidroga).\n\n## Pautas del Protocolo Dr. Pete Sulack y Seguridad\n* **Dosificación clínica sugerida:** 1 cápsula de 1 a 2 veces al día con las comidas (fórmula GraviVive).\n* **Precaución toxicológica:** No debe utilizarse de forma continua ininterrumpida por periodos superiores a 60-90 días sin descanso, debido a que dosis neurotóxicas excesivas de annonacina han sido asociadas a parkinsonismo atípico en modelos animales.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir extracto estandarizado de Graviola/Guanábana con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Graviola en iHerb →](https://www.iherb.com/search?kw=graviola%20soursop&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición NADH:ubiquinona oxidorreductasa (complejo I), depleción crítica de ATP tumoral, modulación bombas de resistencia MDR.',
        clinical_status:'Uso en medicina tradicional y suplementación herbal. Mayoritariamente preclínica; requiere uso ciclado y supervisión médica.',
        pubmed_citations:JSON.stringify(['30323380','29139589','28677610']),status:'published'
      },
      {
        id:'wiki-artemisinina',slug:'artemisinina-artemisia-annua',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Artemisinina (Artemisia annua): Reacción con Hierro Tumoral, Estrés Oxidativo Focal y Ciclado',
        subtitle:'Lactona sesquiterpénica endoperóxido con citotoxicidad selectiva en células tumorales ricas en ferritina',
        evidence_level:'Ensayos Clínicos Piloto y Preclínica Rigurosa',
        excerpt:'Monografía científica sobre la Artemisinina: ruptura del puente endoperóxido mediada por iones de hierro ferrosos intracelulares, formación de radicales libres letales para el tumor, sinergia con berberina y protocolo de ciclado (5 días activo, 2 descanso).',
        body:`## ¿Qué es la Artemisinina?\nLa artemisinina es una lactona sesquiterpénica aislada de la planta medicinal china *Artemisia annua* (ajenjo dulce o Qinghao). Su descubrimiento por la investigadora Tu Youyou (Premio Nobel de Medicina 2015) revolucionó el tratamiento mundial de la malaria, y en las últimas dos décadas se ha revelado como un agente oncológico de asombrosa precisión molecular.\n\n## Mecanismo de Activación por Hierro Tumoral\n1. **Reacción con Hierro Libre Intracelular (Fe2+):** Las células cancerosas sobreexpresan receptores de transferrina y acumulan niveles anormalmente altos de hierro ferroso para alimentar su rápida división celular.\n2. **Ruptura del Puente Endoperóxido:** Cuando la molécula de artemisinina entra en contacto con el hierro ferroso, su enlace endoperóxido se rompe catalíticamente, generando una ráfaga masiva de radicales libres centrados en carbono (ROS focalizados) que lisan a la célula tumoral desde su interior.\n3. **Bloqueo de la Angiogénesis:** Inhibe los factores de transcripción HIF-1α y VEGF, limitando el aporte de oxígeno y nutrientes al tejido neoplásico.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 200 a 500 mg diarios administrados con alimentos.\n* **Estrategia de ciclado obligatoria:** Se administra durante 5 días consecutivos seguidos de 2 días de descanso estricto (5 on / 2 off) para evitar la adaptación enzimática y preservar la función hepática.\n* **Sinergia:** Se complementa eficazmente con berberina para bloquear simultáneamente el metabolismo de glucosa.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir Artemisinina pura estandarizada con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Artemisinina en iHerb →](https://www.iherb.com/search?kw=artemisinin&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Ruptura puente endoperóxido por Fe2+, generación ROS de carbono intracelular, inhibición HIF-1α y VEGF, detención ciclo celular.',
        clinical_status:'Fármaco antiparasitario aprobado por la OMS/FDA. Ensayos clínicos piloto en oncología integrativa en cáncer colorrectal, mama y glioblastoma.',
        pubmed_citations:JSON.stringify(['31668482','29432098','29712711']),status:'published'
      },
      {
        id:'wiki-fotobiomodulacion',slug:'fotobiomodulacion-luz-roja',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Fotobiomodulación y Luz Roja / Infrarroja: Bioenergética Mitocondrial, ATP y Reparación Celular',
        subtitle:'Longitudes de onda de 660 nm y 850 nm para estimular la citocromo c oxidasa y abatir inflamación profunda',
        evidence_level:'Ensayos Clínicos y Revisiones en Photomedicine and Laser Surgery',
        excerpt:'Evaluación de la fotobiomodulación (PBM / Terapia de Luz Roja e Infrarroja Cercana): absorción de fotones por la enzima mitocondrial citocromo c oxidasa, síntesis acelerada de ATP celular, modulación de radicales libres y pautas de 10-20 min diarios del protocolo Dr. Pete Sulack.',
        body:`## ¿Qué es la Fotobiomodulación (Luz Roja e Infrarroja)?\nLa fotobiomodulación (PBM), comúnmente conocida como terapia de luz roja e infrarroja cercana (NIR), consiste en la aplicación de longitudes de onda lumínicas específicas (típicamente 660 nm en el espectro rojo visible y 850 nm en el espectro infrarrojo cercano invisible) capaces de penetrar tejidos biológicos hasta varios centímetros de profundidad.\n\n## Mecanismo Mitocondrial de Acción\n1. **Fotorreceptor Primario (Citocromo C Oxidasa):** El complejo IV de la cadena de transporte de electrones mitocondrial contiene centros de cobre y hierro que actúan como cromóforos selectivos para fotones de 600-900 nm.\n2. **Disociación de Óxido Nítrico Inhibitorio:** En células bajo estrés o inflamación, el óxido nítrico (NO) se une competitivamente al citocromo c oxidasa inhibiendo la respiración celular. La luz roja desplaza el NO, restaurando la afinidad por el oxígeno y elevando la producción de trifosfato de adenosina (**ATP**).\n3. **Señalización Retrógrada y Factores de Transcripción:** Induce pulsos transitorios de ROS fisiológicos benéficos que activan genes protectores dependientes de NF-kB y AP-1, estimulando la reparación de tejidos y reduciendo citoquinas proinflamatorias sistémicas.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia y duración:** Sesiones de 10 a 20 minutos diarios por zona diana.\n* **Distancia de aplicación:** Entre 15 y 30 cm del panel para maximizar la irradiancia terapéutica (generalmente >100 mW/cm²).\n* **Áreas prioritarias:** Zonas ganglionares, tórax, abdomen y sobre lechos tumorales o cicatrices quirúrgicas para acelerar la cicatrización y desinflamación tisular.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes adquirir paneles y dispositivos de fotobiomodulación certificados para uso doméstico o clínico a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Paneles de Luz Roja e Infrarroja Médica en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Estimulación complejo IV (citocromo c oxidasa), disociación de NO inhibitorio, incremento síntesis ATP, reducción estrés oxidativo mitocondrial.',
        clinical_status:'Aprobado por la FDA para alivio del dolor musculoesquelético y regeneración tisular. Guías MASCC/ISOO recomiendan PBM para prevención de mucositis en pacientes oncológicos.',
        pubmed_citations:JSON.stringify(['32832811','30589886','31904573']),status:'published'
      },
      {
        id:'wiki-pemf-bemer',slug:'pemf-campos-magneticos-pulsados-bemer',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia PEMF y BEMER: Regulación Bioelectromagnética, Potencial de Membrana y Microcirculación',
        subtitle:'Pulsos electromagnéticos de baja frecuencia para restaurar el voltaje celular (-70 mV) y el flujo vasomotriz capilar',
        evidence_level:'Ensayos Clínicos en Bioelectromagnetismo (Bioelectromagnetics 2022)',
        excerpt:'Monografía científica sobre los campos electromagnéticos pulsados (PEMF) y la tecnología vasomotriz BEMER: restauración del potencial transmembrana de células enfermas (de -15 mV a -70 mV), mejora de la perfusión tisular y pautas de uso del protocolo Dr. Pete Sulack.',
        body:`## El Voltaje Celular en la Salud y la Enfermedad\nTodas las células vivas operan como pequeñas baterías biológicas. Mientras que una célula sana mantiene una diferencia de potencial transmembrana óptima de entre -70 mV y -90 mV, las células crónicamente inflamadas o cancerosas experimentan una despolarización patológica que reduce su voltaje a rangos críticos de -15 mV a -30 mV, comprometiendo el intercambio de nutrientes, potasio y expulsión de toxinas.\n\n## Mecanismos Celulares de PEMF y BEMER\n1. **Apertura de Canales Iónicos y Bombas Na+/K+:** Las ondas PEMF inducen microcorrientes eléctricas fisiológicas en el líquido extracelular, reactivando las bombas sodio-potasio ATPasa y restaurando el potencial bioeléctrico de la membrana celular.\n2. **Estimulación de la Microcirculación (Vasomoción):** La señal de onda patentada BEMER estimula de forma rítmica el músculo liso de las microarteriolas precapilares, restaurando la vasomoción espontánea que a menudo se encuentra paralizada en tejidos lesionados o tumorales.\n3. **Oxigenación y Disminución de Agregación Plaquetaria:** Reduce el fenómeno de apilamiento eritrocitario ("rouleaux"), facilitando que los glóbulos rojos individuales fluyan por los capilares más estrechos para entregar oxígeno tisular.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Terapia PEMF general:** 30 minutos al día sobre esterilla corporal de cuerpo completo o aplicador focalizado.\n* **Protocolo BEMER:** Sesiones de 8 a 16 minutos dos veces al día (mañana y noche) para optimizar el ritmo circadiano de la microcirculación.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes explorar esterillas PEMF y dispositivos de modulación bioelectromagnética en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Dispositivos y Esterillas PEMF en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Repolarización del potencial transmembrana (-70 mV), estimulación vasomotriz precapilar, incremento de fosforilación oxidativa, desagregación de eritrocitos.',
        clinical_status:'Dispositivos médicos clase II aprobados por la FDA para seudoartrosis, dolor osteoarticular y edema. Ensayos clínicos en marcha en medicina integrativa.',
        pubmed_citations:JSON.stringify(['35384180','33887985','34900898']),status:'published'
      },
      {
        id:'wiki-oxigenoterapia-hiperbarica',slug:'oxigenoterapia-hiperbarica-hbot',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Oxigenoterapia Hiperbárica (HBOT): Reversión de la Hipoxia Tumoral, Angiogénesis y Sinergia Metabólica',
        subtitle:'Respiración de oxígeno al 100% a presiones de 1.5 a 2.0 ATA para disolver O2 en el plasma sanguíneo',
        evidence_level:'Ensayos Clínicos y Biología Tumoral (Cancer Cell 2016)',
        excerpt:'Análisis de la cámara de oxigenación hiperbárica (HBOT) en oncología: supresión de la vía angiogénica dependiente de HIF-1α, sensibilización de células tumorales a terapias metabólicas, modulación de radicales libres y protocolo clínico del Dr. Sulack.',
        body:`## ¿Qué es la Oxigenoterapia Hiperbárica (HBOT)?\nLa oxigenoterapia hiperbárica consiste en respirar oxígeno puro (o concentraciones superiores al 95%) dentro de una cámara presurizada a presiones atmosféricas elevadas, generalmente entre 1.5 y 2.0 atmósferas absolutas (ATA). Bajo estas leyes de física de gases (Ley de Henry), el oxígeno se disuelve físicamente en el plasma sanguíneo, linfa y líquido cefalorraquídeo, alcanzando tejidos hipóxicos donde los glóbulos rojos no logran penetrar.\n\n## Mecanismo de Disrupción en el Microambiente Tumoral\n1. **Reversión de la Hipoxia Tumoral (Eje HIF-1α):** La hipoxia es el motor maestro del fenotipo tumoral agresivo, mediado por el factor inducible por hipoxia 1-alfa (HIF-1α). La hiperoxigenación tisular degrada HIF-1α, suprimiendo la glucólisis y la angiogénesis patológica.\n2. **Estrés Oxidativo Selectivo en Células Neoplásicas:** Dado que las células tumorales poseen defensas antioxidantes enzimáticas deficientes (baja catalasa y superóxido dismutasa mitocondrial), la avalancha de oxígeno induce peroxidación lipídica letal selectiva en el tumor mientras protege al tejido sano.\n3. **Sinergia con Cetosis Terapéutica (Estrategia Seyfried):** La combinación de dieta cetogénica (que corta el flujo de glucosa) con HBOT (que revierte la hipoxia) crea una pinza metabólica devastadora para células cancerosas.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Duración y presión de sesión:** 60 a 90 minutos por inmersión en cámara hiperbárica.\n* **Frecuencia terapéutica:** 3 a 5 sesiones por semana en centros de medicina hiperbárica integrativa (como Progressive Medical Center).\n* **Hidratación y antioxidantes:** Buena hidratación con electrolitos antes de entrar a la cámara.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes explorar cámaras hiperbáricas suaves y concentradores de oxígeno portátiles en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Opciones de Cámaras Hiperbáricas y Accesorios en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Saturación de oxígeno plasmático disuelto, supresión transcripcional HIF-1α, generación selectiva de ROS en microambientes anaeróbicos, proliferación de células madre CD34+.',
        clinical_status:'Tratamiento médico aprobado internacionalmente por la UHMS y FDA para radionecrosis de tejidos blandos y lesiones refractarias. Extensamente investigado en oncología metabólica.',
        pubmed_citations:JSON.stringify(['27743477','31804968','33177658']),status:'published'
      },
      {
        id:'wiki-sauna-infrarrojo',slug:'sauna-infrarrojo-lejano-detox',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Sauna Infrarrojo Lejano: Hipertermia Suave, Excreción de Metales Pesados y Proteínas de Choque Térmico',
        subtitle:'Termoterapia profunda a 50-60°C para movilizar toxinas lipofílicas transdérmicas sin estrés cardiovascular extremo',
        evidence_level:'Estudios Clínicos en Toxicología (Integrative Cancer Therapies 2019)',
        excerpt:'Compendio científico sobre el sauna de infrarrojo lejano (FIR): movilización y excreción de contaminantes ambientales y metales pesados en el sudor, inducción de proteínas de choque térmico (HSP70), mejora endotelial y protocolo de 3 a 5 sesiones del Dr. Sulack.',
        body:`## Diferencias entre Sauna Tradicional y Sauna Infrarrojo\nA diferencia del sauna finlandés tradicional que calienta el aire circundante a temperaturas elevadas (80-90°C), los emisores de infrarrojo lejano (FIR) calientan directamente los tejidos corporales a frecuencias de absorción celular profunda a temperaturas más confortables y tolerables (48-60°C).\n\n## Mecanismos Fisiológicos de Detoxificación y Anticáncer\n1. **Eliminación Transdérmica de Xenobióticos:** Estudios toxicológicos han confirmado concentraciones significativamente mayores de metales pesados (plomo, cadmio, mercurio, arsénico) y pesticidas organoclorados en el sudor inducido por infrarrojo que en el plasma o la orina.\n2. **Inducción de Proteínas de Choque Térmico (HSPs):** La hipertermia controlada induce la síntesis de HSP70 en células sanas, mejorando el plegamiento de proteínas y activando la inmunovigilancia mediada por células NK hacia células mutadas.\n3. **Inhibición de la Angiogénesis Tumoral:** La termoterapia eleva el flujo microvascular y la oxigenación en áreas tumorales poco irrigadas, desestabilizando los vasos tumorales frágiles.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia semanal:** 3 a 5 sesiones por semana.\n* **Duración y temperatura:** 30 a 45 minutos a temperaturas entre 48°C y 60°C (120-140°F).\n* **Seguridad:** Utilizar equipos con baja emisión electromagnética (Ultra Low EMF) y reponer siempre electrolitos y minerales traza post-sesión.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes adquirir mantas térmicas infrarrojas portátiles y cabinas de sauna infrarrojo de bajo CEM en Amazon con nuestro enlace oficial:\n\n> 🛒 **[Ver Saunas y Mantas Infrarrojas de Bajo CEM en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Diaforesis transdérmica selectiva de toxinas lipófilas, estimulación de chaperonas moleculares Hsp70, vasodilatación periférica por óxido nítrico, reducción de tono simpático.',
        clinical_status:'Ampliamente prescrito en clínicas de medicina funcional e integrativa europea y estadounidense para desintoxicación ambiental y apoyo oncológico.',
        pubmed_citations:JSON.stringify(['31113271','22505876','29737482']),status:'published'
      },
      {
        id:'wiki-sauna-ozono-hocatt',slug:'sauna-ozono-tecnologia-hocatt',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Sauna de Ozono y Tecnología HOCATT: Ozonoterapia Transdérmica, Ácido Carbónico e Hipertermia',
        subtitle:'Combinación multi-modal de ozono médico (O3), CO2 transdérmico, luz pulsada e hipertermia para estrés oxidativo selectivo',
        evidence_level:'Ensayos Clínicos y Revisiones en Medical Gas Research & Annals of Oncology',
        excerpt:'Monografía sobre la cámara HOCATT y el sauna de ozono: absorción transdérmica de ozono médico, generación de productos lipoperoxidados (LOPs), efecto Bohr por ácido carbónico y pautas de 2 a 4 sesiones semanales del Dr. Pete Sulack.',
        body:`## ¿Qué es la Tecnología HOCATT y el Sauna de Ozono?\nHOCATT son las siglas de *Hyperthermic Ozone Carbonic Acid Transdermal Technology*. Es un sistema integral que sitúa al paciente en una cámara cerrada de cuello para afuera, combinando vapor caliente, ácido carbónico (CO2 transdérmico) y ozono medicinal (O3) en una secuencia terapéutica sincronizada.\n\n## Mecanismo de Sinergia Fisiológica\n1. **Apertura de Poros y Vasodilatación por Ácido Carbónico:** En los primeros minutos, el CO2 interactúa con el vapor formando ácido carbónico que dilata los capilares cutáneos e induce el **Efecto Bohr**, liberando oxígeno de la hemoglobina a los tejidos.\n2. **Absorción Transdérmica de Ozono Médico (O3):** A continuación se introduce ozono que reacciona con los lípidos del sudor produciendo peróxidos lipídicos (LOPs) y ozónidos. Estos mensajeros bioactivos entran a la circulación sistémica activando la enzima Nrf2 y la síntesis de enzimas antioxidantes endógenas (SOD, glutatión).\n3. **Vulnerabilidad Oncológica Selectiva:** Las células neoplásicas carecen de catalasa para descomponer el peróxido, sufriendo lisis por estrés oxidativo focalizado mientras las células sanas florecen.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia:** 2 a 4 sesiones por semana bajo indicación clínica.\n* **Combinación de soporte:** Se asocia a hidratación intensa con minerales traza (24 a 32 oz de agua filtrada) y quelantes suaves o enemas de café para apoyar las vías de eliminación hepato-biliar.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes explorar generadores de ozono para el hogar y equipos de sauna de vapor corporal en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Generadores de Ozono y Saunas de Vapor en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Formación de peróxidos lipídicos (LOPs), activación del eje Nrf2/ARE, incremento de 2,3-DPG eritrocitario, hipertermia con destrucción selectiva de células deficientes en catalasa.',
        clinical_status:'Reconocido en farmacopeas y sociedades médicas de ozonoterapia (ISCO3). Estudios clínicos demuestran modulación inmunitaria y mejora en la calidad de vida de pacientes oncológicos.',
        pubmed_citations:JSON.stringify(['21627798','22359495','30568019']),status:'published'
      },
      {
        id:'wiki-estimulacion-nervio-vago',slug:'estimulacion-nervio-vago-vns',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Estimulación del Nervio Vago (VNS): Vía Antiinflamatoria Colinérgica, Tono Vagal y Células NK',
        subtitle:'Bioestimulación auricular y cervical no invasiva para modular el eje cerebro-inmune y suprimir citoquinas',
        evidence_level:'Ensayos Clínicos en Neuroinmunología (Frontiers in Neuroscience 2018 & Brain Stimulation 2020)',
        excerpt:'Análisis médico de la estimulación transcutánea del nervio vago (tVNS): activación del receptor nicotínico alfa-7 en macrófagos, inhibición de TNF-alfa e IL-6, elevación de células Natural Killer y protocolo diario con Vagustim del Dr. Pete Sulack.',
        body:`## El Nervio Vago y el Sistema Inmunológico\nEl nervio vago (décimo par craneal) constituye el tronco principal del sistema nervioso parasimpático. Lejos de ser un simple modulador del ritmo cardíaco y la digestión, el neurocientífico Kevin Tracey descubrió que el vago alberga la **vía antiinflamatoria colinérgica**, el mecanismo por el cual el cerebro frena directamente la inflamación en los órganos linfoides periféricos.\n\n## Mecanismos Celulares de la Estimulación Vagal\n1. **Bloqueo de Citoquinas por Receptor α7nAChR:** La acetilcolina liberada por terminaciones vagales se une a los receptores nicotínicos alfa-7 en la superficie de los macrófagos del bazo y ganglios linfáticos, inhibiendo directamente la translocación de NF-kB y deteniendo la producción de TNF-α, IL-1β e IL-6.\n2. **Aumento de la Actividad de Células NK:** La regulación del tono parasimpático reduce el cortisol crónico y la norepinefrina circulante, desinhibiendo a los linfocitos citotóxicos y a las células Natural Killer encargadas de la vigilancia antitumoral.\n3. **Mejora del Drenaje Linfático y Glifático:** Estimula las contracciones peristálticas del sistema linfático corporal y del sistema glifático cerebral durante el sueño profundo.\n\n## Pautas del Protocolo Dr. Pete Sulack (Dispositivo Vagustim)\n* **Activación matutina:** 5 a 10 minutos al despertar para elevar la oxigenación celular y encender el eje parasimpático.\n* **Pre-comida:** 10 a 15 minutos antes del almuerzo para optimizar la secreción de enzimas digestivas y ácido gástrico.\n* **Reinicio de media tarde:** 5 a 10 minutos para combatir el pico de estrés vespertino.\n* **Desconexión nocturna:** 10 a 15 minutos antes de dormir para inducir sueño delta reparador.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes adquirir dispositivos de estimulación transcutánea vagal y electroestimuladores auriculares en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Dispositivos de Estimulación del Nervio Vago en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Señalización vagal colinérgica, activación receptor nicotínico α7nAChR, supresión transcripcional de TNF-α/IL-6, aumento de variabilidad cardíaca (HRV) y modulación de células NK.',
        clinical_status:'Dispositivos invasivos y transcutáneos aprobados por la FDA para cefaleas, depresión resistente y epilepsia. Investigación clínica activa en oncología por su correlación pronóstica con HRV.',
        pubmed_citations:JSON.stringify(['29662432','32371089','29387002']),status:'published'
      },
      {
        id:'wiki-maquina-rife-frecuencias',slug:'terapia-frecuencias-maquina-rife',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia de Frecuencias y Máquina RIFE: Bioresonancia Electromagnética y Evidencia Biofísica',
        subtitle:'Frecuencias de oscilación coordinada para modular la homeostasis eléctrica celular y disrumpir patógenos',
        evidence_level:'Biofísica y Estudios Experimentales (Journal of Alternative & Complementary Medicine)',
        excerpt:'Evaluación de la terapia electromagnética por frecuencias basada en los principios de Royal Raymond Rife: resonancia morfológica, modulación de microcorrientes celulares, hidratación celular con agua estructurada y recomendaciones de desintoxicación del Dr. Sulack.',
        body:`## Origen y Principio de Resonancia Bioeléctrica\nDesarrollada en la década de 1930 por Royal Raymond Rife, esta aproximación biofísica postula que cada estructura biológica, patógeno o tejido posee una frecuencia de oscilación resonante específica (Mortal Oscillatory Rate - MOR). Mediante la emisión de frecuencias de radio y campos electromagnéticos específicos de baja intensidad, se busca inducir estrés acústico-electromagnético selectivo en microorganismos oportunistas o células en disfunción energética.\n\n## Bases Biofísicas Investigadas\n1. **Modulación de Canales Iónicos de Membrana:** Determinadas frecuencias electromagnéticas alteran la conductancia de compuerta en canales de calcio y potasio voltaje-dependientes, impactando cascadas de transducción intracelular.\n2. **Disrupción de Biopelículas y Patógenos Oportunistas:** Ciertas frecuencias desestabilizan las matrices extracelulares de bacterias pleomórficas, micoplasmas o parásitos que frecuentemente colonizan a pacientes oncológicos inmunodeprimidos.\n3. **Neuromodulación y Alivio del Estrés:** Frecuencias en el rango de ondas Schumann (7.83 Hz) y ondas alfa cerebrales promueven relajación y modulación del dolor neuropático.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia:** 3 a 5 sesiones por semana de 30 a 60 minutos de duración.\n* **Entorno:** Realizar en habitación relajada con baja exposición a contaminación electromagnética ambiental (modo avión en teléfonos).\n* **Protocolo antes y después:** Beber 16 a 24 oz de agua filtrada de calidad y tomar quelantes/aglutinantes (arcilla bentonita, carbón activado o chlorella) para absorber los desechos celulares.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes explorar dispositivos de bioresonancia y generadores de frecuencias bioeléctricas en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Equipos de Frecuencias y Generadores Bioeléctricos en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Resonancia bioeléctrica, modulación de conductancia iónica transmembrana, perturbación electromagnética de biopelículas, estimulación de microcorrientes tisulares.',
        clinical_status:'Dispositivos de biofield experimental y bienestar complementario. Utilizados en clínicas de medicina alternativa internacional acompañados de seguimiento metabólico.',
        pubmed_citations:JSON.stringify(['12537682','21798363']),status:'published'
      },
      {
        id:'wiki-terapia-jugos-verdes',slug:'terapia-jugos-desintoxicacion-enzimas',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia de Jugos Verdes Terapéuticos: Clorofila, Enzimas Vivas y Fitoquímica de Detoxificación',
        subtitle:'Zumos vegetales en prensado en frío para inundar el organismo de micronutrientes alcalinizantes sin digestión pesada',
        evidence_level:'Ensayos Nutricionales y Fitoquímica (Nutrients 2021)',
        excerpt:'Monografía sobre la terapia de jugos vegetales crudos: aporte celular de clorofila quelante, glucosinolatos y sulforafano, alcalinización del medio extracelular, protección hepática y pautas diarias en ayunas del protocolo Dr. Pete Sulack.',
        body:`## ¿Por Qué Jugos Vegetales en Lugar de Vegetales Enteros en Terapia?\nAunque la fibra vegetal es indispensable en la nutrición regular, en pacientes oncológicos la energía metabólica suele encontrarse deprimida por la caquexia y el gasto digestivo. Al extraer el jugo puro de vegetales verdes mediante prensado en frío (*cold-press masticating*), los fitoquímicos, enzimas vivas y minerales se absorben de forma casi instantánea en el intestino delgado sin sobrecargar el sistema gastrointestinal.\n\n## Mecanismos Celulares de los Jugos Terapéuticos\n1. **Clorofila como Quelante y Oxigenador:** La molécula de clorofila es idéntica en estructura a la hemoglobina humana, excepto que contiene magnesio en lugar de hierro. Neutraliza toxinas lipofílicas, previene la absorción de mutágenos y apoya la salud de los glóbulos rojos.\n2. **Inducción de Enzimas de Fase II (Eje Nrf2/ARE):** Vegetales crucíferos y hojas verdes aportan sulforafano e indol-3-carbinol que inducen la síntesis de glutatión S-transferasa y quinona reductasa, enzimas hepáticas clave para neutralizar metabolitos tumorales.\n3. **Alcalinización del Espacio Extracelular:** El alto contenido de potasio, magnesio y citratos contrarresta el microambiente ácido circundante al tumor generado por el ácido láctico del efecto Warburg.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Ingredientes clave:** Apio, pepino, col rizada (kale), espinaca, cilantro, jengibre, cúrcuma y remolacha/zanahoria con moderación.\n* **Regla estricta:** Evitar frutas altas en azúcar (fructosa alimenta la glucólisis tumoral); usar únicamente limón, lima o media manzana verde como endulzante de bajo índice glucémico.\n* **Modo de toma:** 1 vaso recién exprimido por la mañana en ayunas para absorción enzimática máxima.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes adquirir extractores de jugo lentos de prensado en frío (Cold-Press Masticating Juicers) en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Extractores de Prensado en Frío (Cold-Press) en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Aporte masivo de magnesio quelado por clorofila, inducción Nrf2/ARE de enzimas hepáticas de fase II, modulación alcalina del fluido intersticial, neutralización de ROS.',
        clinical_status:'Intervención nutricional complementaria consolidada en clínicas de oncología integrativa a nivel mundial (Terapia Gerson, protocolo Sulack, Centro Hippocrates).',
        pubmed_citations:JSON.stringify(['33671239','28678034','31487843']),status:'published'
      },
      {
        id:'wiki-vitamina-c-intravenosa',slug:'vitamina-c-intravenosa-altas-dosis',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Vitamina C Intravenosa (IVC): Pro-Oxidante Selectivo, Producción de H2O2 y Apoptosis Tumoral',
        subtitle:'Infusiones de ascorbato en dosis milimolares (25 a 100 g) que actúan como quimioterapia redox natural',
        evidence_level:'Ensayos Clínicos Fase I/II y Revisiones en Frontiers in Oncology & Redox Biology',
        excerpt:'Compendio científico sobre la vitamina C endovenosa a altas dosis: concentraciones plasmáticas inalcanzables por vía oral, generación de peróxido de hidrógeno citotóxico selectivo contra células malignas, sinergia con quimioterapia y pautas del Dr. Sulack.',
        body:`## La Gran Dicotomía: Antioxidante Oral vs. Pro-Oxidante Intravenoso\nCuando la vitamina C se consume por vía oral, el intestino satura los transportadores SVCT-1, impidiendo que los niveles plasmáticos superen los 200 micromoles/L, actuando puramente como un antioxidante. Sin embargo, al administrarse por infusión intravenosa continua en dosis de 25 a 100 gramos, los niveles en sangre alcanzan concentraciones de 20 a 30 milimoles/L, donde su comportamiento bioquímico se transforma radicalmente en un potente **agente pro-oxidante selectivo**.\n\n## Mecanismo de Citotoxicidad Tumoral Selectiva\n1. **Generación Extracelular de Peróxido de Hidrógeno (H2O2):** El ascorbato a altas dosis reacciona con trazas de hierro libre lábil (reacción de Fenton) en el fluido intersticial tumoral, liberando peróxido de hidrógeno y radicales hidroxilo.\n2. **Deficiencia de Catalasa en Células Cancerosas:** Las células sanas poseen concentraciones abundantes de catalasa y glutatión peroxidasa que degradan inmediatamente el peróxido en agua y oxígeno inofensivos. En contraste, las células tumorales presentan un déficit crónico de catalasa (hasta 10 veces menor), provocando colapso de la membrana mitocondrial, roturas irreversibles del ADN y apoptosis inmediata.\n3. **Inhibición de la Angiogénesis Tumoral:** Modula cofactores de hierro para prolil-hidroxilasas, degradando HIF-1α y bloqueando la formación de vasos tumorales.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia:** Infusiones intravenosas de 1 a 3 veces por semana según estadio y respuesta clínica individual.\n* **Requisito analítico previo indispensable:** Descartar deficiencia de la enzima glucosa-6-fosfato deshidrogenasa (G6PD) mediante analítica sanguínea previa para evitar riesgo de hemólisis.\n* **Hidratación y dieta:** Mantener hidratación abundante antes y después de cada infusión con electrolitos para facilitar la excreción renal.\n\n## 🛒 Equipamiento y Monitoreo en Amazon\nPuedes encontrar suplementos de electrolitos clínicos y equipos de apoyo para hidratación intravenosa en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Electrolitos y Accesorios de Salud en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Reacción de Fenton en espacio extracelular, generación masiva de peróxido de hidrógeno (H2O2), colapso mitocondrial por déficit de catalasa tumoral, degradación de HIF-1α.',
        clinical_status:'Protocolo Riordan ampliamente estandarizado. Ensayos clínicos Fase I y II publicados en cáncer de páncreas, ovario y glioblastoma demostrando seguridad y sinergia.',
        pubmed_citations:JSON.stringify(['33936998','32050854','29432098']),status:'published'
      },
      {
        id:'wiki-cuidado-quiropractico-neuroinmune',slug:'cuidado-quiropractico-alineacion-neuroinmune',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Cuidado Quiropráctico y Eje Neuroespinal: Alineación Vertebral, Flujo de LCR e Inmunidad',
        subtitle:'Corrección de subluxaciones vertebrales para normalizar el flujo simpático, drenaje de LCR y función inmune',
        evidence_level:'Estudios en Neuroplasticidad y Journal of Manipulative and Physiological Therapeutics',
        excerpt:'Evaluación de la intervención quiropráctica en la salud integral y oncología: reducción de la sobreactivación simpática espinal, liberación del flujo de líquido cefalorraquídeo, reducción de mediadores inflamatorios y recomendaciones del Dr. Pete Sulack.',
        body:`## El Eje Columna Vertebral - Sistema Nervioso - Inmunidad\nLa médula espinal y las raíces nerviosas que emergen de entre cada vértebra controlan el flujo motor, sensitivo y vegetativo de todos los órganos internos, incluyendo el bazo, timo, médula ósea y ganglios linfáticos. Cuando se presentan subluxaciones o desalineaciones biomecánicas vertebrales, se genera una señal aberrante de nocicepción y estrés mecánico continuo que mantiene sobreactivado el sistema nervioso simpático.\n\n## Mecanismos Celulares y Fisiológicos\n1. **Reducción de Marcadores Inflamatorios Post-Ajuste:** Ensayos clínicos en el *Journal of Manipulative and Physiological Therapeutics* han demostrado que la corrección de fijaciones espinales disminuye de forma medible la concentración sérica de citoquinas proinflamatorias como TNF-α e IL-6 tras los ajustes.\n2. **Optimización del Flujo de Líquido Cefalorraquídeo (LCR):** La correcta movilidad de la columna cervical alta (complejo occipucio-atlas-axis) y del sacro actúa como bomba hidráulica para el LCR, facilitando el lavado de desechos neurotóxicos cerebrales.\n3. **Estimulación de Leucocitos y Respuesta Inmune Innata:** El restablecimiento del tono parasimpático reduce el impacto del cortisol supresor sobre los glóbulos blancos circulantes.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Frecuencia clínica:** Evaluaciones y ajustes periódicos por un quiropráctico profesional especializado para mantener la integridad biomecánica.\n* **Ejercicios posturales en casa:** Tracción cervical pasiva, descompresión postural y respiración diafragmática para oxigenar tejidos y sostener los ajustes.\n* **Sinergia:** Combinar con hidratación rica en minerales y descanso reparador para consolidar la neuroplasticidad.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes encontrar soportes de tracción cervical, rodillos de descompresión espinal y correctores posturales en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Soportes Cervicales y Dispositivos de Tracción en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Atenuación de aferencias nociceptivas espinales, reducción de tono simpático periférico, normalización del flujo pulsátil de LCR, modulación de citoquinas inflamatorias.',
        clinical_status:'Profesión sanitaria regulada en Estados Unidos, Canadá, Europa y América Latina. Empleada en oncología integrativa para alivio de dolor músculo-esquelético y fatiga.',
        pubmed_citations:JSON.stringify(['20609867','27429842']),status:'published'
      },
      {
        id:'wiki-dieta-cetogenica-oncologia',slug:'dieta-cetogenica-oncologia-metabolica',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Dieta Cetogénica Terapéutica en Cáncer: Deprivación Glucémica, Cuerpos Cetónicos y Ratio GKI',
        subtitle:'Macronutrientes 70% grasas saludables, 20% proteínas y 10% carbohidratos para sofocar la glucólisis anaeróbica',
        evidence_level:'Ensayos Clínicos, Nature Reviews Cancer y Cell Metabolism',
        excerpt:'Análisis de la dieta cetogénica en oncología metabólica: asfixia del efecto Warburg por reducción de glucosa sérica e insulina, síntesis de beta-hidroxibutirato protector para tejidos sanos, monitoreo con medidor Keto-Mojo y pautas del Dr. Pete Sulack.',
        body:`## La Vulnerabilidad Energética del Tumor (Efecto Warburg)\nEn 1924, el Premio Nobel Otto Warburg demostró que casi la totalidad de las células tumorales dependen de la fermentación acelerada de glucosa para sintetizar nucleótidos y generar ATP, aun en presencia de oxígeno abundante. Las mitocondrias de las células cancerosas presentan mutaciones ultraestructurales en las crestas y en la cardiolipina que les impiden quemar cuerpos cetónicos eficientemente. En contraste, las células sanas del cerebro, corazón y músculo prosperan utilizando cetonas como combustible limpio de alto rendimiento.\n\n## Mecanismos Moleculares de la Cetosis Terapéutica\n1. **Inhibición de la Vía Oncogénica PI3K/Akt/mTOR:** Al reducir drásticamente el consumo de hidratos de carbono refinados, la glucemia y la insulina sérica caen a niveles basales mínimos, privando al tumor de su señal mitógena más potente.\n2. **Estrés Oxidativo Mitocondrial Tumoral:** Forzadas a metabolizar trazas de ácidos grasos sin maquinaria mitocondrial apta, las células neoplásicas entran en una crisis bioenergética que culmina en apoptosis.\n3. **Beta-Hidroxibutirato (BHB) como Molécula Señalizadora:** El BHB actúa además como inhibidor natural de las desacetilasas de histonas (HDAC), reactivando genes supresores tumorales silenciados.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Distribución de macronutrientes:** ~70% grasas saludables (aguacate, aceite de oliva virgen extra, aceite de coco/MCT, frutos secos), 20% proteínas de pastoreo y 10% carbohidratos netos (vegetales de hoja verde sin almidón).\n* **Control del Ratio Glucosa-Cetonas (GKI):** Mantener un ratio GKI inferior a 2.0 (calculado como [Glucosa mg/dL ÷ 18] ÷ Cetonas mmol/L).\n* **Medición rigurosa:** Monitorear con precisión los niveles de beta-hidroxibutirato en sangre utilizando un kit de medición capilar como Keto-Mojo.\n\n## 🛒 Equipamiento Recomendado en Amazon\nPuedes adquirir el kit oficial de medición de glucosa y cetonas en sangre Keto-Mojo en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Kit de Medición Keto-Mojo en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Supresión vía PI3K/Akt/mTOR, privación de sustrato glucolítico tumoral, inhibición de HDAC por beta-hidroxibutirato, elevación selectiva de estrés oxidativo en células mutadas.',
        clinical_status:'Ensayos clínicos aleatorizados en gliomas, cáncer de mama, próstata y endometrio. Protocolo metabólico central impulsado por el Dr. Thomas Seyfried en Boston College.',
        pubmed_citations:JSON.stringify(['32832811','31804968','33177658']),status:'published'
      },
      {
        id:'wiki-ayuno-intermitente-oncologia',slug:'ayuno-intermitente-autofagia-sensibilizacion',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Ayuno Intermitente: Autofagia Celular, Flexibilidad Metabólica y Protección Diferencial',
        subtitle:'Ventanas 16:8 y 18:6 para activar SIRT1, reciclar mitocondrias disfuncionales y proteger al tejido sano',
        evidence_level:'Ensayos Clínicos en Humanos (Cell Metabolism 2021 & NEJM 2019)',
        excerpt:'Compendio científico sobre el ayuno intermitente en el paciente oncológico: el principio de Resistencia Diferencial al Estrés (DSR) descubierto por Valter Longo, caída de insulina e IGF-1, activación de mitofagia y protocolos prácticos del Dr. Pete Sulack.',
        body:`## ¿Qué es el Ayuno Intermitente?\nEl ayuno intermitente consiste en alternar de manera pautada periodos de ingesta calórica con periodos de abstinencia alimentaria donde solo se permiten líquidos sin calorías (agua filtrada, infusiones herbales, café negro y electrolitos). Los esquemas más estudiados son el protocolo 16:8 (16 horas de ayuno con ventana de ingesta de 8 horas) y el protocolo 18:6.\n\n## Mecanismo de Resistencia Diferencial al Estrés (DSR)\n1. **Protección del Tejido Sano:** Al entrar en ayunas, las células normales de todo el organismo entran en un estado de protección y mantenimiento celular, apagando vías de proliferación para conservar recursos.\n2. **Vulnerabilidad Invariable del Tumor:** Las células cancerosas, debido a sus mutaciones oncogénicas constitutivas, son incapaces de apagar su maquinaria de crecimiento. Al no encontrar nutrientes en el torrente sanguíneo, entran en catabolismo destructivo y se vuelven sumamente sensibles al estrés oxidativo.\n3. **Activación de Autofagia y Mitofagia:** Tras 14 a 16 horas de ayuno, la disminución de insulina estimula los complejos de autofagia (LC3 y ATG), reciclando orgánulos dañados y desechos proteicos acumulados.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Progresión gradual:** Comenzar con un esquema suave de 14:10 durante la primera semana, avanzando a 16:8 y posteriormente a 18:6 según tolerancia metabólica.\n* **Hidratación continua:** Consumir agua de calidad con sal marina sin refinar o electrolitos para prevenir calambres o fatiga.\n* **Ventana de ingesta de alta densidad nutricional:** Romper el ayuno con alimentos reales, ricos en grasas antiinflamatorias, micronutrientes y proteínas de fácil asimilación.\n\n## 🛒 Equipamiento y Electrolitos en Amazon\nPuedes adquirir electrolitos sin azúcar para ayuno y botellas de agua estructurada en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Electrolitos sin Azúcar para Ayuno en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Activación de AMPK y sirtuinas SIRT1/3, supresión mTOR, degradación lisosomal por autofagia/mitofagia, descenso de IGF-1 sérico, resistencia diferencial al estrés (DSR).',
        clinical_status:'Ensayos clínicos Fase II en humanos demuestran que el ayuno periquimioterapia reduce significativamente efectos adversos hematológicos y gastrointestinales.',
        pubmed_citations:JSON.stringify(['31881139','33887985','29387002']),status:'published'
      },
      {
        id:'wiki-ayuno-hidrico-prolongado',slug:'ayuno-hidrico-prolongado-regeneracion-celular',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Ayuno Hídrico Prolongado: Autofagia Profunda, Regeneración Inmune y Reseteo por Células Madre',
        subtitle:'Abstinencia calórica de 24 a 72 horas para reciclar leucocitos senescentes y despertar células madre hematopoyéticas',
        evidence_level:'Investigación Fundamental y Ensayos Clínicos (NEJM & Cell Stem Cell)',
        excerpt:'Monografía médica del ayuno de agua prolongado: reciclaje acelerado del sistema inmunitario envejecido, colapso de los niveles de IGF-1 y proteína quinasa A (PKA), regeneración de médula ósea y pautas de seguridad médica del Dr. Pete Sulack.',
        body:`## Las Fases Fisiológicas del Ayuno Prolongado\nA partir de las 24 horas continuas de ayuno hídrico, las reservas de glucógeno hepático se agotan por completo. El organismo inicia un cambio metabólico radical hacia la cetogénesis profunda. Entre las 48 y 72 horas ocurren fenómenos biológicos imposibles de emular mediante farmacología sintética.\n\n## Mecanismos Celulares de Regeneración Radical\n1. **Reciclaje Inmunológico y Células Madre Hematopoyéticas:** Investigaciones del Dr. Valter Longo publicadas en *Cell Stem Cell* demostraron que un ayuno prolongado de 48-72 horas fuerza al organismo a reciclar un porcentaje sustancial de glóbulos blancos senescentes y dañados. Al romper el ayuno, las células madre hematopoyéticas de la médula ósea se activan, regenerando un sistema inmunológico nuevo y rejuvenecido.\n2. **Depleción Radical de IGF-1 y PKA:** El factor de crecimiento similar a la insulina 1 (IGF-1) y la proteína quinasa A caen en picada, silenciando los principales circuitos de soporte tumoral.\n3. **Autofagia de Organelos y Proteostasis:** Las células descomponen mitocondrias defectuosas y agregados proteicos mutados para reutilizar sus aminoácidos en funciones vitales.\n\n## Pautas del Protocolo Dr. Pete Sulack y Seguridad\n* **Duración:** Iniciar con ayunos de 24 a 48 horas una vez al mes, avanzando hacia 72 horas únicamente bajo supervisión médica experimentada en oncología integrativa.\n* **Hidratación y descanso:** Beber abundante agua filtrada con electrolitos esenciales (sodio, potasio, magnesio) y guardar reposo físico y emocional.\n* **Ruptura cuidadosa del ayuno:** Jamás romper un ayuno prolongado con carbohidratos o comidas pesadas. Iniciar con caldos de huesos ricos en colágeno, vegetales al vapor y aguacate en porciones pequeñas.\n\n## 🛒 Equipamiento y Soporte en Amazon\nPuedes encontrar suplementos de electrolitos puros para ayunos prolongados y caldos de hueso orgánicos en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Caldos de Hueso y Electrolitos en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Agotamiento total de glucógeno hepático, silenciamiento del eje IGF-1/PKA, autofagia profunda mediada por chaperonas, activación de células madre hematopoyéticas pluripotenciales.',
        clinical_status:'Supervisado en centros clínicos de ayuno médico (TrueNorth Health Center). Respaldado por estudios clínicos de intervención metabólica y longevidad celular.',
        pubmed_citations:JSON.stringify(['24905167','31881139','29534435']),status:'published'
      },
      {
        id:'wiki-beta-glucanos-hongos',slug:'beta-glucanos-inmunologia-reishi-cola-pavo',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Beta-Glucanos Inmunológicos: Polisacáridos de Hongos Medicinales, Células NK y Macrófagos',
        subtitle:'Polímeros de glucosa con enlaces beta-1,3/1,6 procedentes de Reishi, Shiitake y Cola de Pavo (Coriolus versicolor)',
        evidence_level:'Ensayos Clínicos Aleatorizados (Cancer Immunology Research 2022)',
        excerpt:'Análisis farmacodinámico de los beta-glucanos fúngicos: acoplamiento al receptor dectina-1 de la inmunidad innata, reclutamiento de macrófagos y células NK, estimulación de vigilancia tumoral y dosificación de 500-1000 mg del Dr. Pete Sulack.',
        body:`## ¿Qué son los Beta-Glucanos Fúngicos?\nLos beta-glucanos son polisacáridos estructurales de alto peso molecular que forman parte de la pared celular de hongos macromicetos medicinales como *Ganoderma lucidum* (Reishi), *Lentinula edodes* (Shiitake) y *Trametes versicolor* (Cola de Pavo). Se diferencian de los beta-glucanos de cereales (avena) por su compleja ramificación molecular en enlaces específicos **beta-1,3/1,6-D-glucano**, responsables de su potente bioactividad inmunológica.\n\n## Mecanismo de Activación Inmunitaria Innata y Adaptativa\n1. **Reconocimiento por Receptores Dectina-1 y CR3:** Al ser ingeridos, los beta-glucanos interactúan con las células M de las placas de Peyer intestinales y son fagocitados por macrófagos, activando el receptor dectina-1 y el receptor de complemento 3 (CR3).\n2. **Cebado y Desgranulación de Células Natural Killer (NK):** Provocan la maduración de células NK y linfocitos T citotóxicos, multiplicando su capacidad de perforar y lisar membranas de células tumorales mediante perforinas y granzimas.\n3. **Secreción Coordinada de Citoquinas:** Inducen la liberación de interferón gamma (IFN-γ) e interleucina 12 (IL-12), orquestando una respuesta inmune de tipo Th1 con perfil antineoplásico.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica recomendada:** 500 a 1.000 mg diarios de beta-glucanos purificados o complejos fúngicos de espectro completo (Reishi, Shiitake y Cola de Pavo).\n* **Modo de toma:** Preferentemente con las comidas o en ayunas junto con vitamina C para optimizar el acoplamiento a receptores inmunitarios.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir fórmulas de Beta-Glucanos purificados y hongos medicinales orgánicos con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Beta-Glucanos en iHerb →](https://www.iherb.com/search?kw=beta%20glucans%20mushroom&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Ligando selectivo de receptor dectina-1 y CR3, activación tirosina quinasa Syk, degranulación de células Natural Killer (NK), polarización inmunológica Th1 antitumoral.',
        clinical_status:'Extractos de beta-glucanos como PSK (Krestin) y Lentinan han sido aprobados como fármacos adyuvantes oncológicos oficiales por el Ministerio de Salud de Japón desde hace cuatro décadas.',
        pubmed_citations:JSON.stringify(['35086884','33574805','30806254']),status:'published'
      },
      {
        id:'wiki-calostro-factores-transferencia',slug:'calostro-bovino-factores-transferencia-galt',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Calostro Bovino y Factores de Transferencia: Inmunoglobulinas, Reparación Intestinal y GALT',
        subtitle:'Primera leche biológica rica en inmunoglobulinas IgG, lactoferrina y prolina para restaurar la barrera mucosal',
        evidence_level:'Ensayos Clínicos en Nutrición Inmunológica (Nutrients 2021)',
        excerpt:'Evaluación técnica del calostro bovino y los factores de transferencia: reparación de la permeabilidad intestinal (leaky gut), modulación del tejido linfoide GALT, neutralización de endotoxinas LPS y protocolo de 1 a 2 g diarios del Dr. Pete Sulack.',
        body:`## ¿Qué es el Calostro Bovino?\nEl calostro es el líquido prediseñado biológicamente por las glándulas mamarias bovinas en las primeras 48 a 72 horas tras el parto. Contiene una densidad incomparable de inmunoglobulinas activas (principalmente IgG1 e IgG2, así como IgA y secreciones antimicrobianas), lactoferrina, lisozima y polipéptidos ricos en prolina (PRPs o factores de transferencia).\n\n## Mecanismos Inmunológicos y Entéricos\n1. **Sellado de Uniones Estrechas (Tight Junctions):** Los factores de crecimiento epitelial (EGF, IGF-1, TGF-β) estimulan la regeneración del enterocito y restauran la expresión de claudinas y ocludinas, sellando la hiperpermeabilidad intestinal que suele provocar endotoxemia crónica en pacientes oncológicos.\n2. **Modulación del Tejido Linfoide GALT:** Dado que más del 70% del sistema inmunológico humano reside en el intestino (GALT), las inmunoglobulinas del calostro neutralizan antígenos y bacterias patógenas directamente en el lumen intestinal sin desencadenar una cascada inflamatoria destructiva.\n3. **Acción de la Lactoferrina:** Esta glicoproteína secuestra selectivamente el hierro libre que alimenta a bacterias anaeróbicas oportunistas y células mutadas, privándolas de nutrientes de replicación.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica sugerida:** 1 a 2 gramos diarios de calostro bovino puro desgrasado (en polvo disuelto en boca o cápsulas entéricas).\n* **Criterio de calidad:** Elegir calostro recolectado en las primeras 24 horas post-parto de vacas alimentadas con pasto (grass-fed) y procesado a baja temperatura sin desnaturalización térmica.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir calostro bovino de pastoreo certificado con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Calostro Bovino en iHerb →](https://www.iherb.com/search?kw=colostrum%20transfer%20factors&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Aporte oral de inmunoglobulinas IgG/IgA bioactivas, regeneración epitelial por EGF e IGF-1, quelación de hierro por lactoferrina, neutralización de endotoxinas LPS en lumen intestinal.',
        clinical_status:'Nutracéutico aprobado ampliamente para reparación de barrera digestiva y soporte inmune. Documentado en ensayos clínicos en prevención de toxicidad intestinal por tratamientos invasivos.',
        pubmed_citations:JSON.stringify(['34208468','33804860','28574925']),status:'published'
      },
      {
        id:'wiki-probioticos-microbioma-galt',slug:'probioticos-multicepa-microbioma-eje-inmune',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Probióticos Multicepa y Microbioma: Modulación del Eje Intestino-Inmune y Butirato en Cáncer',
        subtitle:'Bacterias comensales de alta potencia (10 a 20 mil millones UFC) para regenerar la diversidad de la flora y potenciar la inmunoterapia',
        evidence_level:'Ensayos Clínicos en Cell Host & Microbe 2021 y Science',
        excerpt:'Compendio científico sobre probióticos multicepa en oncología integrativa: producción de ácidos grasos de cadena corta (butirato), modulación de linfocitos T reguladores, protección frente a disbiosis farmacológica y pautas diarias del Dr. Pete Sulack.',
        body:`## El Microbioma como Órgano Inmunometabólico\nEl tracto intestinal alberga trillones de microorganismos cuyo genoma colectivo (microbioma) supera con creces al genoma humano. En oncología clínica contemporánea, publicaciones pioneras en *Science* y *Nature* han demostrado que la composición y diversidad bacteriana intestinal predicen con precisión matemática la respuesta a la inmunoterapia y quimioterapia convencional.\n\n## Mecanismos Celulares Probióticos\n1. **Producción de Butirato e Inhibición de HDAC:** Cepas de *Bifidobacterium* y *Lactobacillus* favorecen la colonización de comensales productores de butirato. El butirato es un ácido graso de cadena corta (SCFA) que nutre a los colonocitos sanos y actúa como inhibidor natural de histonas desacetilasas (HDAC), suprimiendo la proliferación de células atípicas.\n2. **Competencia por Exclusión y Barrera Mucosal:** Evitan la colonización de patógenos productores de toxinas proinflamatorias como el lipopolisacárido (LPS), impidiendo la inflamación de bajo grado sistémica.\n3. **Cebado de Células Dendríticas:** Estimulan la presentación de antígenos tumorales a los linfocitos T citotóxicos CD8+ en los ganglios linfáticos mesentéricos.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica recomendada:** 1 cápsula diaria de un complejo multicepa de amplio espectro garantizando al menos 10 a 20 mil millones de UFC (Unidades Formadoras de Colonias).\n* **Formulación:** Fórmulas con cápsula de liberación retardada resistente a los ácidos estomacales (DRcaps) para asegurar supervivencia bacteriana hasta el intestino.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb\nPuedes adquirir probióticos multicepa con liberación retardada y garantía de potencia viva con descuento utilizando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Probióticos Multicepa en iHerb →](https://www.iherb.com/search?kw=probiotics%20multi%20strain&rcode=wUt7svK8)**\n> *(O accede a través de nuestro enlace directo de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Fermentación de fibra a butirato/acetato, mantenimiento de uniones estrechas intestinales, modulación de checkpoints inmunes y células dendríticas, exclusión de patógenos.',
        clinical_status:'Extensamente respaldado en la literatura médica. Ensayos clínicos en marcha demuestran que trasplantes de microbiota o cepas de Bifidobacterium revierten la resistencia a inhibidores de PD-1.',
        pubmed_citations:JSON.stringify(['34416041','29102798','31163624']),status:'published'
      },
      {
        id:'wiki-aceite-oliva-oleocantal',slug:'aceite-oliva-virgen-extra-oleocantal',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Aceite de Oliva Virgen Extra (AOVE): Oleocantal, Lisis Lisosomal Tumoral y Polifenoles',
        subtitle:'Compuesto fenólico secoridoide con capacidad de inducir apoptosis selectiva mediante permeabilización lisosomal',
        evidence_level:'Ensayos en Molecular & Cellular Oncology y Nutrients 2020',
        excerpt:'Investigación médica del oleocantal presente en el aceite de oliva virgen extra de alta recolección temprana: destrucción selectiva de la membrana lisosomal en células tumorales sin alterar células sanas, inhibición enzimática de COX-1/COX-2 y dosis de 1 a 2 cucharadas diarias del Dr. Sulack.',
        body:`## ¿Qué es el Oleocantal y los Polifenoles del AOVE?\nEl oleocantal es un polifenol secoiridoide natural presente exclusivamente en el aceite de oliva virgen extra (*Extra Virgin Olive Oil - EVOO*) de alta calidad, responsable de la sensación de picor característico en la parte posterior de la garganta. Comparte una notable similitud farmacológica con el ibuprofeno, pero con una biocompatibilidad celular superior.\n\n## El Asombroso Descubrimiento de la Lisis Lisosomal Selectiva\n1. **Permeabilización Lisosomal Tumoral (LMP):** En 2015, investigadores del Hunter College y Rutgers University publicaron un hallazgo histórico en *Molecular & Cellular Oncology*: el oleocantal penetra selectivamente en células cancerosas y altera la membrana de sus lisosomas (los "centros de reciclaje" celulares, más grandes y frágiles en tumores), liberando enzimas hidrolíticas destructivas que digieren a la célula maligna desde su interior en un lapso de 30 a 60 minutos.\n2. **Indemnidad de Células Normales:** Las células sanas experimentan una pausa temporal en su ciclo celular sin daño alguno, reactivando su metabolismo normal tras 24 horas.\n3. **Inhibición de Vías Inflamatorias:** Bloquea de forma dosis-dependiente las enzimas ciclooxigenasa-1 (COX-1) y ciclooxigenasa-2 (COX-2), inhibiendo prostaglandinas proangiogénicas como la PGE2.\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Dosificación clínica:** 1 a 2 cucharadas soperas diarias de aceite de oliva virgen extra en ayunas para absorción óptima.\n* **Uso culinario:** Utilizar crudo como base en aderezos de ensaladas o sobre vegetales cocidos para preservar sus polifenoles termolábiles.\n* **Sinergia:** Mezclar con unas gotas de zumo de limón fresco para estimular la producción biliar y la detoxificación hepática.\n* **Criterio de calidad:** Aceite de recolección temprana prensado en frío con certificación de alto contenido polifenólico (>300 mg/kg).\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb y Amazon\nPuedes adquirir aceites de oliva virgen extra de alta concentración polifenólica en iHerb con el código **\`wUt7svK8\`** o en Amazon:\n\n> 🛒 **[Ver Opciones de Aceite de Oliva Virgen Extra Rico en Polifenoles en iHerb →](https://www.iherb.com/search?kw=extra%20virgin%20olive%20oil%20organic&rcode=wUt7svK8)**\n> *(O explora opciones en Amazon a través de nuestro enlace oficial: [https://amzn.to/46PTWSA](https://amzn.to/46PTWSA))*.`,
        mechanisms:'Permeabilización selectiva de membrana lisosomal tumoral (LMP), liberación de catepsinas hidrolíticas, inhibición COX-1/COX-2, modulación antioxidante de peroxidación lipídica.',
        clinical_status:'Alimento funcional terapéutico ampliamente estudiado en estudios epidemiológicos de la Dieta Mediterránea (ensayo PREDIMED) con reducción de recurrencias neoplásicas.',
        pubmed_citations:JSON.stringify(['26451384','32050854','30138241']),status:'published'
      },
      {
        id:'wiki-incienso-boswellia',slug:'aceite-esencial-incienso-boswellia-akba',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Incienso y Ácidos Boswélicos (Boswellia / AKBA): Inhibición de 5-LOX, Apoptosis y Desinflamación',
        subtitle:'Resina de Boswellia carterii y serrata estandarizada en ácido acetil-11-ceto-beta-boswélico (AKBA)',
        evidence_level:'Ensayos Clínicos y Revisiones en BMC Complementary Medicine & Molecules',
        excerpt:'Monografía científica sobre el incienso (Frankincense / Boswellia serrata): inhibición alostérica no redox de la 5-lipoxigenasa (5-LOX), bloqueo de leucotrienos inflamatorios, inducción de apoptosis tumoral y pautas de administración tópica, inhalada y oral del Dr. Sulack.',
        body:`## ¿Qué es el Incienso y la Boswellia?\nEl incienso es una resina gomosa aromática recolectada de la corteza de árboles del género *Boswellia* (principalmente *Boswellia serrata* y *Boswellia carterii*), originarios de la península arábiga y el noreste de África. Durante siglos venerado en la medicina tradicional ayurvédica como *Salai Guggal*, su investigación fitoquímica ha aislado potentes triterpenos pentacíclicos conocidos colectivamente como **ácidos boswélicos**, destacando el **AKBA** (ácido acetil-11-ceto-beta-boswélico).\n\n## Mecanismo de Bloqueo Inflamatorio y Antitumoral\n1. **Inhibición Específica de la 5-Lipoxigenasa (5-LOX):** A diferencia de la aspirina o los AINEs clásicos que inhiben COX, el AKBA es uno de los escasísimos compuestos naturales que bloquea selectivamente la enzima 5-LOX, deteniendo la biosíntesis de leucotrienos (LTB4), potentes mediadores de inflamación tisular, edema y supervivencia tumoral.\n2. **Inducción de Apoptosis Dependiente de Caspasas:** Los ácidos boswélicos alteran la permeabilidad mitocondrial neoplásica, liberando citocromo C y activando caspasas 3 y 8 en líneas celulares de glioblastoma, mama y colon.\n3. **Reducción de Edema Cerebral Peritumoral:** Numerosos ensayos clínicos han demostrado su eficacia reduciendo la hinchazón cerebral en pacientes con tumores del sistema nervioso central o tras radioterapia, permitiendo reducir el uso de corticosteroides sintéticos (dexametasona).\n\n## Pautas del Protocolo Dr. Pete Sulack\n* **Difusión ambiental e inhalación:** Difundir aceite esencial puro de grado terapéutico (*Boswellia carterii*) a diario para promover relajación neurovegetativa y soporte pulmonar.\n* **Aplicación tópica:** Diluir unas gotas en aceite portador (como aceite de coco fraccionado o jojoba) y masajear suavemente sobre áreas ganglionares, cuello o abdomen.\n* **Vía oral estandarizada:** Para soporte sistémico, se recomiendan cápsulas de extracto estandarizado de *Boswellia serrata* (al menos 30% AKBA / fórmula AprèsFlex) junto con alimentos grasos.\n\n## 🌿 Adquisición de Grado Terapéutico en iHerb y Amazon\nPuedes adquirir extracto estandarizado de Boswellia (AKBA) en iHerb con el cupón **\`wUt7svK8\`** o aceite esencial puro en Amazon:\n\n> 🛒 **[Ver Extracto de Boswellia Serrata en iHerb →](https://www.iherb.com/search?kw=boswellia%20akba&rcode=wUt7svK8)**\n> *(O adquiere aceites esenciales puros en Amazon a través de nuestro enlace oficial: [https://amzn.to/46PTWSA](https://amzn.to/46PTWSA))*.`,
        mechanisms:'Inhibición alostérica no redox de 5-lipoxigenasa (5-LOX), detención de síntesis de leucotrienos LTB4, activación caspasas 3 y 8, inhibición de topoisomerasas tumorales.',
        clinical_status:'Fitofármaco aprobado en monografías de la Agencia Europea del Medicamento (EMA) y farmacopea alemana. Investigado en ensayos clínicos para edema cerebral peritumoral.',
        pubmed_citations:JSON.stringify(['32505599','31284566','22505876']),status:'published'
      }
    ];
    for(const art of seedArticles){
      await query('INSERT INTO wiki_articles(id,slug,category,category_id,title,subtitle,evidence_level,excerpt,body,mechanisms,clinical_status,pubmed_citations,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING',
        [art.id,art.slug,art.category,art.category_id,art.title,art.subtitle,art.evidence_level,art.excerpt,art.body,art.mechanisms,art.clinical_status,art.pubmed_citations,art.status]
      );
    }
    wikiSchemaChecked=true;
  }catch(e){console.warn('Auto-migración wiki:',e.message);}
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
    const u=new URL(req.url,'http://localhost');const path=u.searchParams.get('route')||u.pathname.replace(/^\/api\/?/,'');const method=req.method;
    if(!['GET','POST','DELETE','HEAD'].includes(method))fail('Método no permitido',405);
    if(method!=='GET' && method!=='HEAD' && req.headers.origin!==origin())fail('Origen de solicitud no permitido',403);
    if(path==='health')return send(res,{ok:true});
    if(path.startsWith('auth/'))await ensureAuthSchema();
    if(path.startsWith('wiki')||path.startsWith('admin')||path==='public'||path==='sitemap'||path==='preview')await ensureWikiSchema();
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
    if((path==='video/thumb'||path==='video/image'||path.endsWith('/thumb.jpg')||path.endsWith('/thumb'))&&(method==='GET'||method==='HEAD')){
      const vidId=u.searchParams.get('id')||u.searchParams.get('videoId')||path.replace(/^v\//,'').replace(/^video\//,'').replace(/\/thumb(\.jpg)?$/,'');
      const [v]=(await query("SELECT id,platform,external_id,thumbnail FROM videos WHERE id=? OR external_id=?",[vidId,vidId]))||[];
      let thumbUrl = v?.platform==='youtube'&&v?.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : v?.thumbnail;
      if(!thumbUrl) thumbUrl = origin()+'/favicon.svg';
      try{
        const r=await fetch(thumbUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; SanantesBot/1.0)'}});
        if(!r.ok) fail('Miniatura no disponible',404);
        const buf=Buffer.from(await r.arrayBuffer());
        res.statusCode=200;
        res.setHeader('Content-Type','image/jpeg');
        res.setHeader('Content-Length',buf.length);
        res.setHeader('Cache-Control','public, max-age=86400, s-maxage=604800');
        if(method==='HEAD') return res.end();
        return res.end(buf);
      }catch(err){
        res.statusCode=302;
        res.setHeader('Location',thumbUrl);
        return res.end();
      }
    }
    if((path==='robots.txt'||path==='robots')&&(method==='GET'||method==='HEAD')){
      const txt=`User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n\nSitemap: ${origin()}/sitemap.xml\n`;
      res.statusCode=200;
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.setHeader('Cache-Control','public, max-age=3600, s-maxage=86400');
      if(method==='HEAD') return res.end();
      return res.end(txt);
    }
    if((path==='sitemap.xml'||path==='sitemap')&&(method==='GET'||method==='HEAD')){
      const publishedVideos=(await query("SELECT id,title,description,thumbnail,external_id,platform,kind,duration,published_at FROM videos WHERE status='published' AND kind IN ('video','live') ORDER BY published_at DESC LIMIT 1000")).filter(v=>!exclusionReason(v));
      const publishedPosts=await query("SELECT id,slug,title,excerpt,updated_at FROM posts WHERE status='published' ORDER BY updated_at DESC LIMIT 500");
      const publishedWiki=await query("SELECT id,slug,title,updated_at FROM wiki_articles WHERE status='published' ORDER BY updated_at DESC LIMIT 500");
      const escXml=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
      const base=origin();
      const nowIso=new Date().toISOString();
      const videoItems=publishedVideos.map(v=>{
        const thumb=escXml(v.thumbnail||(v.platform==='youtube'?`https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg`:base+'/favicon.svg'));
        const title=escXml(v.title);
        const desc=escXml(v.description?v.description.slice(0,2048):v.title);
        const pubDate=v.published_at?new Date(v.published_at).toISOString():nowIso;
        return `  <url>
    <loc>${base}/v/${v.id}</loc>
    <lastmod>${pubDate.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <video:video>
      <video:thumbnail_loc>${thumb}</video:thumbnail_loc>
      <video:title>${title}</video:title>
      <video:description>${desc}</video:description>
      ${v.duration?`<video:duration>${Math.min(Number(v.duration),28800)}</video:duration>`:''}
      <video:publication_date>${pubDate}</video:publication_date>
      <video:family_friendly>yes</video:family_friendly>
      <video:live>${v.kind==='live'?'yes':'no'}</video:live>
    </video:video>
  </url>`;
      }).join('\n');
      const postItems=publishedPosts.map(p=>{
        const modDate=p.updated_at?new Date(p.updated_at).toISOString():nowIso;
        return `  <url>
    <loc>${base}/b/${p.slug}</loc>
    <lastmod>${modDate.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`;
      }).join('\n');
      const wikiItems=publishedWiki.map(w=>{
        const modDate=w.updated_at?new Date(w.updated_at).toISOString():nowIso;
        return `  <url>
    <loc>${base}/wiki/${w.slug}</loc>
    <lastmod>${modDate.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`;
      }).join('\n');
      const xml=`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
  <url>
    <loc>${base}/</loc>
    <lastmod>${nowIso.split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/wiki</loc>
    <lastmod>${nowIso.split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.95</priority>
  </url>
  <url>
    <loc>${base}/autores/william-makis</loc>
    <lastmod>${nowIso.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.95</priority>
  </url>
  <url>
    <loc>${base}/temas/medicamentos-reposicionados</loc>
    <lastmod>${nowIso.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.95</priority>
  </url>
  <url>
    <loc>${base}/temas/estrategia-metabolica</loc>
    <lastmod>${nowIso.split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.95</priority>
  </url>
${wikiItems}
${postItems}
${videoItems}
</urlset>`;
      res.statusCode=200;
      res.setHeader('Content-Type','application/xml; charset=utf-8');
      res.setHeader('Cache-Control','public, max-age=3600, s-maxage=14400');
      if(method==='HEAD') return res.end();
      return res.end(xml);
    }
    if((path==='preview'||path.startsWith('v/')||path.startsWith('b/')||path.startsWith('video/')||path.startsWith('blog/')||path.startsWith('autores/')||path.startsWith('autor/')||path.startsWith('temas/')||path.startsWith('tema/')||path.startsWith('wiki/')||path==='wiki')&&(method==='GET'||method==='HEAD')){
      const escHtml=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const formatRichText=(raw)=>{
        if(!raw) return '';
        const lines=String(raw).split(/\r?\n/);
        let html='', inList=false, inBlockquote=false;
        const inlineFormat=(text)=>{
          return escHtml(text)
            .replace(/`([^`]+)`/g, '<code style="background:#eef3f0;padding:2px 6px;border-radius:4px;font-size:0.88em;color:#183d35;">$1</code>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^\*]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s<)]+)\)/g, (m, label, url) => {
              const rawUrl = url.replace(/&amp;/g, '&');
              return `<a href="${rawUrl}" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;text-decoration:underline;">${label}</a>`;
            });
        };
        for(let line of lines){
          const trimmed=line.trim();
          if(!trimmed){
            if(inList){ html+='</ul>'; inList=false; }
            if(inBlockquote){ html+='</blockquote>'; inBlockquote=false; }
            continue;
          }
          if(trimmed.startsWith('### ')){
            if(inList){ html+='</ul>'; inList=false; }
            if(inBlockquote){ html+='</blockquote>'; inBlockquote=false; }
            html+=`<h3 style="color:#123d39;margin:24px 0 12px;font-size:1.25rem;">${inlineFormat(trimmed.slice(4))}</h3>`;
            continue;
          }
          if(trimmed.startsWith('## ')){
            if(inList){ html+='</ul>'; inList=false; }
            if(inBlockquote){ html+='</blockquote>'; inBlockquote=false; }
            html+=`<h2 style="color:#123d39;margin:28px 0 14px;font-size:1.45rem;border-bottom:1px solid #eef3f0;padding-bottom:8px;">${inlineFormat(trimmed.slice(3))}</h2>`;
            continue;
          }
          if(trimmed.startsWith('# ')){
            if(inList){ html+='</ul>'; inList=false; }
            if(inBlockquote){ html+='</blockquote>'; inBlockquote=false; }
            html+=`<h2 style="color:#123d39;margin:28px 0 14px;font-size:1.55rem;">${inlineFormat(trimmed.slice(2))}</h2>`;
            continue;
          }
          if(trimmed.startsWith('> ') || trimmed === '>'){
            if(inList){ html+='</ul>'; inList=false; }
            const content = trimmed.slice(trimmed.startsWith('> ') ? 2 : 1);
            if(!inBlockquote){
              html += '<blockquote style="margin:20px 0;padding:16px 20px;border-left:4px solid #1e6b42;background:#f8fbf9;border-radius:0 8px 8px 0;line-height:1.65;color:#183d35;">';
              inBlockquote = true;
            } else {
              html += '<br>';
            }
            html += inlineFormat(content);
            continue;
          } else if(inBlockquote){
            html += '</blockquote>';
            inBlockquote = false;
          }
          const isBullet=/^[•\-\*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
          if(isBullet){
            if(!inList){ html+='<ul style="margin:16px 0;padding-left:24px;line-height:1.7;">'; inList=true; }
            const clean=trimmed.replace(/^[•\-\*]\s+/,'').replace(/^\d+\.\s+/,'');
            html+=`<li style="margin-bottom:8px;">${inlineFormat(clean)}</li>`;
            continue;
          } else if(inList){
            html+='</ul>';
            inList=false;
          }
          html+=`<p style="margin:0 0 16px;line-height:1.75;color:#243e37;">${inlineFormat(trimmed)}</p>`;
        }
        if(inList) html+='</ul>';
        if(inBlockquote) html+='</blockquote>';
        return html;
      };
      const cleanDesc = (str, max=155) => {
        if(!str) return '';
        const clean = str.replace(/\s+/g,' ').trim();
        if(clean.length <= max) return clean;
        const cut = clean.slice(0, max);
        const lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > 70 ? cut.slice(0, lastSpace) : cut) + '...';
      };
      const cleanTitle = (str, max=60) => {
        if(!str) return 'Comunidad Sanantes';
        const clean = str.replace(/\s+/g,' ').trim();
        if(clean.length <= max) return clean;
        const cut = clean.slice(0, max - 3);
        const lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '...';
      };
      const orgPublisher = {
        "@type": "Organization",
        "name": "Comunidad Sanantes",
        "url": origin(),
        "logo": {
          "@type": "ImageObject",
          "url": origin() + "/logo.png"
        }
      };
      let type=u.searchParams.get('type')||'';
      let targetId=u.searchParams.get('id')||'';
      const ref=u.searchParams.get('ref')||'';
      if(!type&&(path.startsWith('v/')||path.startsWith('video/'))){type='video';targetId=path.replace(/^video\//,'').replace(/^v\//,'');}
      if(!type&&(path.startsWith('b/')||path.startsWith('blog/'))){type='blog';targetId=path.replace(/^blog\//,'').replace(/^b\//,'');}
      if(!type&&(path.startsWith('autores/')||path.startsWith('autor/'))){type='author';targetId=path.replace(/^autores\//,'').replace(/^autor\//,'');}
      if(!type&&(path.startsWith('temas/')||path.startsWith('tema/'))){type='topic';targetId=path.replace(/^temas\//,'').replace(/^tema\//,'');}
      if(!type&&(path.startsWith('wiki/')||path==='wiki')){type='wiki';targetId=path==='wiki'?'':path.replace(/^wiki\//,'');}
      let title=cleanTitle('Comunidad Sanantes · El Podcast del Cáncer');
      let desc=cleanDesc('Sanantes: El Podcast del Cáncer y plataforma de oncología integrativa. Investigaciones científicas, análisis del Dr. William Makis y acompañamiento.');
      let image='https://i.ytimg.com/vi/008JfHS61Ww/hqdefault.jpg';
      let targetUrl=origin()+(ref?'/?ref='+encodeURIComponent(ref):'');
      let canonicalUrl=origin()+'/';
      let category = '';
      let fullContentHtml = '';
      let activeEmbed = '';
      let schemaJson = '';
      if(type==='video'&&targetId){
        const [v]=(await query("SELECT id,title,description,thumbnail,external_id,platform,published_at,kind,category FROM videos WHERE id=? OR external_id=?",[targetId,targetId]))||[];
        if(v){
          category = v.category || 'Investigación y tratamientos';
          title=cleanTitle(v.title+' · Sanantes');
          if(v.description)desc=cleanDesc(v.description, 155);
          if(v.platform==='youtube'&&v.external_id){
            image=`https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg`;
          }else if(v.thumbnail){
            image=origin()+'/v/'+v.id+'/thumb.jpg';
          }
          targetUrl=origin()+(ref?'/?ref='+encodeURIComponent(ref):'/')+'#video/'+v.id;
          canonicalUrl=origin()+'/v/'+v.id;
          const embedUrl=v.platform==='youtube'?`https://www.youtube-nocookie.com/embed/${v.external_id}`:(v.platform==='odysee'?`https://odysee.com/$/embed/${v.external_id||v.id}`:undefined);
          activeEmbed = embedUrl || '';
          const geoEnrich = getGeoEnrichment(v);
          const geoHtml = geoEnrich ? renderGeoHtml(geoEnrich) : '';
          const relatedVideos = (await query("SELECT id,title,category,thumbnail,external_id,platform FROM videos WHERE status='published' AND id!=? AND (category=? OR kind=?) ORDER BY published_at DESC LIMIT 3", [v.id, v.category||'', v.kind||'video'])) || [];
          let relatedHtml = '';
          if (relatedVideos.length > 0) {
            const cards = relatedVideos.map(r => {
              const rThumb = r.platform==='youtube'&&r.external_id ? `https://i.ytimg.com/vi/${r.external_id}/hqdefault.jpg` : (r.thumbnail || origin()+'/favicon.svg');
              return `<a href="${origin()}/v/${r.id}" style="display:flex;flex-direction:column;background:#f9fbf9;border:1px solid #dce8df;border-radius:10px;overflow:hidden;text-decoration:none;color:#18322d;"><div style="position:relative;padding-bottom:56.25%;background:#0b292b;"><img src="${rThumb}" alt="${escHtml(r.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></div><div style="padding:12px;"><span style="display:inline-block;font-size:0.75rem;font-weight:700;color:#1e6b42;margin-bottom:6px;text-transform:uppercase;">${escHtml(r.category||'Investigación')}</span><h4 style="margin:0;font-size:0.9rem;line-height:1.4;color:#123d39;font-weight:600;">${escHtml(r.title)}</h4></div></a>`;
            }).join('');
            relatedHtml = `<nav aria-label="Contenidos relacionados" style="margin:32px 0 16px;padding-top:24px;border-top:1px solid #edf2ef;"><h3 style="color:#123d39;margin:0 0 16px;font-size:1.15rem;font-weight:700;">Investigaciones y contenidos relacionados:</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">${cards}</div></nav>`;
          }
          fullContentHtml = `<div style="margin:20px 0;line-height:1.7;color:#233833;font-size:1.05rem;">${formatRichText(v.description)}</div>${geoHtml}${relatedHtml}`;
          schemaJson=JSON.stringify({
            "@context":"https://schema.org",
            "@type":"VideoObject",
            "name":v.title,
            "description":desc,
            "thumbnailUrl":[image],
            "uploadDate":v.published_at?new Date(v.published_at).toISOString():undefined,
            "contentUrl":v.url||undefined,
            "embedUrl":embedUrl,
            "publisher":orgPublisher
          });
        }
      }else if(type==='blog'&&targetId){
        let [p]=(await query("SELECT id,slug,title,excerpt,body,image,category,updated_at FROM posts WHERE slug=? OR id=?",[targetId,targetId]))||[];
        if(!p && targetId==='criterio-editorial'){
          p={
            id:'criterio-editorial',
            slug:'criterio-editorial',
            title:'Criterio Editorial, Rigor Científico y Propósito de Sanantes',
            excerpt:'Conoce nuestra metodología de selección de literatura científica en PubMed, política de transparencia y principios de acompañamiento en oncología integrativa.',
            body:`## Propósito Institucional y Acompañamiento
Comunidad Sanantes y El Podcast del Cáncer nacen como una iniciativa de divulgación científica, salud integrativa y apoyo emocional para pacientes oncológicos, supervivientes y sus familias. Nuestro objetivo es democratizar el acceso al conocimiento médico riguroso en un formato claro, empático y constructivo.

## Metodología de Selección de Fuentes (PubMed y Evidencia Clínica)
Cada uno de los análisis, episodios y contenidos publicados en Sanantes se basa exclusivamente en:
- Publicaciones científicas arbitradas por pares en revistas médicas indexadas en MEDLINE/PubMed, Scopus o Cochrane Library.
- Revisiones sobre reposicionamiento de fármacos (drug repurposing) lideradas por universidades y centros de investigación oncológica reconocidos internacionalmente.
- Investigaciones en biología metabólica celular (Efecto Warburg, disfunción mitocondrial y modulación de la glucólisis).
- Ensayos clínicos y estudios observacionales registrados en ClinicalTrials.gov.

## Transparencia y Política de Responsabilidad Médica (YMYL)
- No sustitución de la atención oncológica: La información presentada tiene carácter puramente informativo, pedagógico y de acompañamiento. Bajo ninguna circunstancia reemplaza la consulta, el diagnóstico, el estadiaje ni las pautas de tratamiento prescritas por el oncólogo tratante o el equipo médico especializado.
- Diálogo médico informado: Fomentamos que los pacientes compartan los estudios científicos aquí divulgados con sus médicos para tomar decisiones conjuntas basadas en evidencia y en las particularidades de su historial clínico.
- Independencia editorial: No aceptamos financiamiento ni patrocinios condicionados por la industria farmacéutica ni por intereses comerciales que comprometan la objetividad de las revisiones bibliográficas.`,
            category:'Criterio Editorial y E-E-A-T',
            image:origin()+'/favicon.svg',
            updated_at:'2026-09-24T00:00:00.000Z'
          };
        }
        if(p){
          category = p.category || 'Blog Sanantes';
          title=cleanTitle(p.title+' · Sanantes');
          if(p.excerpt)desc=cleanDesc(p.excerpt, 155);
          if(p.image){
            if(p.image.startsWith('https://'))image=p.image;
            else if(p.image.startsWith('data:'))image=origin()+'/b/'+p.slug+'/image';
          }
          targetUrl=origin()+'/#blog/'+p.slug;
          canonicalUrl=origin()+'/b/'+p.slug;
          fullContentHtml = `<div style="margin:20px 0;line-height:1.7;color:#233833;font-size:1.05rem;">${formatRichText(p.body||p.excerpt)}</div>`;
          schemaJson=JSON.stringify({
            "@context":"https://schema.org",
            "@type":"MedicalWebPage",
            "headline":p.title,
            "description":desc,
            "image":[image],
            "datePublished":p.updated_at?new Date(p.updated_at).toISOString():undefined,
            "dateModified":p.updated_at?new Date(p.updated_at).toISOString():undefined,
            "publisher":orgPublisher,
            "medicalSpecialty":"Oncology",
            "aspect":["Emotional Support","Information"]
          });
        }
      }else if(type==='author'&&(targetId==='william-makis'||targetId==='dr-william-makis')){
        category = 'Autoridad Médica e Investigación';
        title = cleanTitle('Dr. William Makis en Español: Investigaciones y Cáncer · Sanantes');
        desc = cleanDesc('Biblioteca y análisis científico del Dr. William Makis en español. Protocolos de ivermectina, fenbendazol y estudios indexados en oncología integrativa.');
        image = origin()+'/favicon.svg';
        targetUrl = origin()+'/#podcast';
        canonicalUrl = origin()+'/autores/william-makis';
        const makisVideos = (await query("SELECT id,title,description,thumbnail,external_id,platform FROM videos WHERE status='published' AND (LOWER(title) LIKE '%makis%' OR LOWER(description) LIKE '%makis%') ORDER BY published_at DESC")) || [];
        let videoCardsHtml = '';
        if(makisVideos.length > 0){
          videoCardsHtml = `<h2 style="color:#123d39;margin:28px 0 16px;font-size:1.3rem;">Episodios y conferencias del Dr. William Makis en Sanantes:</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">` +
            makisVideos.map(v => {
              const rThumb = v.platform==='youtube'&&v.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : (v.thumbnail || origin()+'/favicon.svg');
              return `<a href="${origin()}/v/${v.id}" style="display:flex;flex-direction:column;background:#f9fbf9;border:1px solid #dce8df;border-radius:10px;overflow:hidden;text-decoration:none;color:#18322d;"><div style="position:relative;padding-bottom:56.25%;background:#0b292b;"><img src="${rThumb}" alt="${escHtml(v.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></div><div style="padding:14px;"><h3 style="margin:0 0 8px;font-size:0.95rem;line-height:1.4;color:#123d39;font-weight:700;">${escHtml(v.title)}</h3><p style="margin:0;font-size:0.8rem;color:#55726a;line-height:1.4;">${escHtml((v.description||'').slice(0,110))}...</p></div></a>`;
            }).join('') + `</div>`;
        }
        fullContentHtml = `<div style="margin:20px 0;line-height:1.75;color:#233833;font-size:1.05rem;">
          <h2 style="color:#123d39;font-size:1.4rem;margin:20px 0 12px;">¿Quién es el Dr. William Makis?</h2>
          <p>El Dr. William Makis, MD, es un médico canadiense especializado en radiología, oncología y medicina nuclear, graduado de la Universidad McGill. A lo largo de su carrera ha supervisado el tratamiento de miles de pacientes con diversas neoplasias y se ha convertido en una de las voces de referencia internacional en la investigación del reposicionamiento de fármacos (<em>drug repurposing</em>) contra el cáncer.</p>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Medicamentos Reposicionados y Vías de Acción Investigadas</h2>
          <p>El trabajo divulgativo y clínico del Dr. Makis se enfoca en moléculas antiparasitarias con décadas de perfil de seguridad farmacológica:</p>
          <ul style="margin:16px 0;padding-left:24px;line-height:1.7;">
            <li style="margin-bottom:10px;"><strong>Ivermectina:</strong> Inhibición del transporte nuclear mediado por importinas alfa/beta, alteración de la mitofagia tumoral y bloqueo de la proteína quinasa PAK1.</li>
            <li style="margin-bottom:10px;"><strong>Mebendazol y Fenbendazol:</strong> Desestabilización de microtúbulos tumorales, detención del ciclo celular en fase G2/M e inducción de apoptosis selectiva.</li>
            <li style="margin-bottom:10px;"><strong>Reversión de la Resistencia Multidroga (MDR):</strong> Modulación de la glicoproteína P (P-gp), facilitando que células refractarias respondan a intervenciones complementarias.</li>
          </ul>
          <blockquote style="margin:24px 0;padding:16px 20px;border-left:4px solid #1e6b42;background:#f9fbf9;border-radius:0 8px 8px 0;font-style:italic;color:#183d35;line-height:1.65;">
            &ldquo;El reposicionamiento de fármacos en oncología no pretende sustituir ciegamente las terapias, sino explorar la literatura científica que la medicina convencional a menudo no explora por falta de incentivo de patente comercial.&rdquo;
            <footer style="margin-top:8px;font-style:normal;font-weight:600;font-size:0.85rem;color:#496b63;">&mdash; Dr. William Makis, MD</footer>
          </blockquote>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Evidencia Indexada y Estudios en PubMed Citados</h2>
          <ul style="margin:16px 0;padding-left:24px;line-height:1.7;">
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Ivermectin as an inhibitor of cancer stem-like cells</strong> &mdash; <em>Pharmacological Research</em> (PMID: 29054452) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/29054452/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Repurposing Ivermectin for Cancer Treatment: Preclinical and Clinical Evidence</strong> &mdash; <em>Frontiers in Pharmacology</em> (PMID: 33633575) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/33633575/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a candidate for drug repurposing in oncology</strong> &mdash; <em>Cancers</em> (PMID: 31080350) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31080350/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>
          </ul>
          ${videoCardsHtml}
        </div>`;
        schemaJson=JSON.stringify({
          "@context":"https://schema.org",
          "@graph":[
            {
              "@type":"ProfilePage",
              "headline":title,
              "description":desc,
              "mainEntity":{
                "@type":"Person",
                "name":"Dr. William Makis",
                "jobTitle":"Médico Especialista en Oncología y Radiología",
                "alumniOf":"McGill University",
                "knowsAbout":["Oncología Integrativa","Ivermectina","Mebendazol","Fenbendazol","Drug Repurposing"]
              }
            },
            {
              "@type":"MedicalWebPage",
              "headline":title,
              "description":desc,
              "medicalSpecialty":"Oncology",
              "publisher":orgPublisher
            }
          ]
        });
      }else if(type==='topic'&&targetId==='medicamentos-reposicionados'){
        category = 'Compendio Temático';
        title = cleanTitle('Medicamentos Reposicionados en Cáncer · Sanantes');
        desc = cleanDesc('Investigaciones sobre fármacos antiparasitarios reposicionados en oncología integrativa: Ivermectina, mebendazol y fenbendazol.');
        image = origin()+'/favicon.svg';
        targetUrl = origin()+'/#podcast';
        canonicalUrl = origin()+'/temas/medicamentos-reposicionados';
        const repVideos = (await query("SELECT id,title,description,thumbnail,external_id,platform FROM videos WHERE status='published' AND (LOWER(title) LIKE '%ivermectina%' OR LOWER(description) LIKE '%ivermectina%' OR LOWER(title) LIKE '%mebendazol%' OR LOWER(description) LIKE '%mebendazol%') ORDER BY published_at DESC LIMIT 6")) || [];
        let repCardsHtml = '';
        if(repVideos.length > 0){
          repCardsHtml = `<h2 style="color:#123d39;margin:28px 0 16px;font-size:1.3rem;">Episodios relacionados en Sanantes:</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">` +
            repVideos.map(v => {
              const rThumb = v.platform==='youtube'&&v.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : (v.thumbnail || origin()+'/favicon.svg');
              return `<a href="${origin()}/v/${v.id}" style="display:flex;flex-direction:column;background:#f9fbf9;border:1px solid #dce8df;border-radius:10px;overflow:hidden;text-decoration:none;color:#18322d;"><div style="position:relative;padding-bottom:56.25%;background:#0b292b;"><img src="${rThumb}" alt="${escHtml(v.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></div><div style="padding:14px;"><h3 style="margin:0 0 8px;font-size:0.95rem;line-height:1.4;color:#123d39;font-weight:700;">${escHtml(v.title)}</h3></div></a>`;
            }).join('') + `</div>`;
        }
        fullContentHtml = `<div style="margin:20px 0;line-height:1.75;color:#233833;font-size:1.05rem;">
          <h2 style="color:#123d39;font-size:1.4rem;margin:20px 0 12px;">¿Qué es el Reposicionamiento Farmacológico (Drug Repurposing)?</h2>
          <p>El reposicionamiento de medicamentos consiste en investigar principios activos ya aprobados para otras indicaciones médicas (como enfermedades infecciosas o parasitarias) con el objetivo de evaluar su potencial en oncología complementaria. La gran ventaja reside en que su toxicidad, farmacocinética y dosificación de seguridad humana han sido documentadas durante décadas.</p>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Fármacos Clave en la Literatura Médica</h2>
          <p><strong>1. Ivermectina:</strong> Más allá de su efecto antiparasitario, la investigación preclínica reporta interferencia con la proteína quinasa PAK1, modulación del transporte nuclear de importinas e inducción de autofagia en líneas celulares neoplásicas.</p>
          <p><strong>2. Mebendazol:</strong> Derivado bencimidazol que inhibe la polimerización de tubulina, impidiendo la formación del huso mitótico tumoral y bloqueando la captación de glucosa en células malignas.</p>
          <p><strong>3. Fenbendazol:</strong> Análogo del mebendazol que ha ganado notoriedad por el caso testimonial de Joe Tippens y diversos estudios in vitro sobre daño mitocondrial en células tumorales.</p>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Fuentes Indexadas en MEDLINE / PubMed</h2>
          <ul style="margin:16px 0;padding-left:24px;line-height:1.7;">
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Antitumor effects of ivermectin: Mechanisms and clinical implications</strong> &mdash; <em>IJMS</em> (PMID: 32415487) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/32415487/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 32415487 &rarr;</a></li>
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a candidate for drug repurposing in oncology</strong> &mdash; <em>Cancers</em> (PMID: 31080350) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31080350/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 31080350 &rarr;</a></li>
          </ul>
          ${repCardsHtml}
        </div>`;
        schemaJson=JSON.stringify({
          "@context":"https://schema.org",
          "@type":"MedicalWebPage",
          "headline":title,
          "description":desc,
          "medicalSpecialty":"Oncology",
          "publisher":orgPublisher
        });
      }else if(type==='topic'&&targetId==='estrategia-metabolica'){
        category = 'Compendio Temático';
        title = cleanTitle('Estrategia Metabólica del Cáncer · Sanantes');
        desc = cleanDesc('Bases de la oncología metabólica: disfunción mitocondrial, restricción calórica, cetosis terapéutica e Índice Glucosa-Cetonas (GKI).');
        image = origin()+'/favicon.svg';
        targetUrl = origin()+'/#podcast';
        canonicalUrl = origin()+'/temas/estrategia-metabolica';
        const metaVideos = (await query("SELECT id,title,description,thumbnail,external_id,platform FROM videos WHERE status='published' AND (LOWER(title) LIKE '%metaból%' OR LOWER(description) LIKE '%metaból%' OR LOWER(title) LIKE '%seyfried%' OR LOWER(description) LIKE '%seyfried%') ORDER BY published_at DESC LIMIT 6")) || [];
        let metaCardsHtml = '';
        if(metaVideos.length > 0){
          metaCardsHtml = `<h2 style="color:#123d39;margin:28px 0 16px;font-size:1.3rem;">Episodios sobre metabolismo y cetosis en Sanantes:</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">` +
            metaVideos.map(v => {
              const rThumb = v.platform==='youtube'&&v.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : (v.thumbnail || origin()+'/favicon.svg');
              return `<a href="${origin()}/v/${v.id}" style="display:flex;flex-direction:column;background:#f9fbf9;border:1px solid #dce8df;border-radius:10px;overflow:hidden;text-decoration:none;color:#18322d;"><div style="position:relative;padding-bottom:56.25%;background:#0b292b;"><img src="${rThumb}" alt="${escHtml(v.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></div><div style="padding:14px;"><h3 style="margin:0 0 8px;font-size:0.95rem;line-height:1.4;color:#123d39;font-weight:700;">${escHtml(v.title)}</h3></div></a>`;
            }).join('') + `</div>`;
        }
        fullContentHtml = `<div style="margin:20px 0;line-height:1.75;color:#233833;font-size:1.05rem;">
          <h2 style="color:#123d39;font-size:1.4rem;margin:20px 0 12px;">La Teoría Metabólica del Cáncer</h2>
          <p>Planteada inicialmente por el Premio Nobel Otto Warburg en 1924 y desarrollada extensamente por el Dr. Thomas N. Seyfried (Boston College), esta teoría postula que el cáncer no se origina primordialmente por mutaciones genéticas nucleares, sino por una alteración irreversible de la fosforilación oxidativa mitocondrial.</p>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Pilares del Enfoque Metabólico</h2>
          <p><strong>1. El Efecto Warburg:</strong> Las células malignas dependen de la fermentación acelerada de glucosa y glutamina, incluso en presencia de oxígeno.</p>
          <p><strong>2. Ratio Glucosa-Cetonas (GKI):</strong> Medida clínica que compara la glucemia con los cuerpos cetónicos sanguíneos (Beta-hidroxibutirato). Un GKI inferior a 2.0 busca inducir estrés energético en el microambiente tumoral mientras protege a los tejidos sanos.</p>
          <p><strong>3. Estrategia Press-Pulse:</strong> Combinación de estrés crónico (dieta cetogénica restringida) con pulsos agudos de intervención terapéutica.</p>
          <h2 style="color:#123d39;font-size:1.4rem;margin:24px 0 12px;">Publicaciones Clave en PubMed</h2>
          <ul style="margin:16px 0;padding-left:24px;line-height:1.7;">
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Cancer as a metabolic disease: implications for novel therapeutics</strong> &mdash; <em>Carcinogenesis</em> (PMID: 24657584) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/24657584/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 24657584 &rarr;</a></li>
            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Press-pulse: a novel strategy for the metabolic management of cancer</strong> &mdash; <em>Nutrition & Metabolism</em> (PMID: 31804968) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31804968/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 31804968 &rarr;</a></li>
          </ul>
          ${metaCardsHtml}
        </div>`;
        schemaJson=JSON.stringify({
          "@context":"https://schema.org",
          "@type":"MedicalWebPage",
          "headline":title,
          "description":desc,
          "medicalSpecialty":"Oncology",
          "publisher":orgPublisher
        });
      }else if(type==='wiki'){
        const cats = (await query("SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC")) || [];
        const arts = (await query("SELECT id,slug,category,category_id,title,subtitle,evidence_level,excerpt,updated_at FROM wiki_articles WHERE status='published' ORDER BY title ASC")) || [];
        const wikiSidebarHtml = `<aside style="background:#fff;border-radius:12px;border:1px solid #dce8df;padding:20px;margin-bottom:24px;position:sticky;top:20px;">
          <div style="font-size:0.75rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#55726a;margin-bottom:16px;">Pilares Temáticos</div>
          <div style="display:flex;flex-direction:column;gap:16px;">` +
          cats.map(c => {
            const catArts = arts.filter(a => a.category_id === c.id || a.category === c.name);
            return `<div>
              <div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#1e6b42;margin-bottom:6px;display:flex;align-items:center;gap:6px;"><span>${c.icon||'📚'}</span> ${escHtml(c.name)}</div>
              <ul style="list-style:none;margin:0;padding:0 0 0 8px;border-left:2px solid #e2ebe5;display:flex;flex-direction:column;gap:4px;">
                ${catArts.map(a => `<li style="margin:0;"><a href="${origin()}/wiki/${a.slug}" style="display:block;padding:4px 8px;font-size:0.84rem;color:${targetId===a.slug||targetId===a.id?'#1e6b42':'#27453f'};font-weight:${targetId===a.slug||targetId===a.id?'700':'400'};text-decoration:none;border-radius:5px;background:${targetId===a.slug||targetId===a.id?'#e8f4ec':'transparent'};">${escHtml(a.title)}</a></li>`).join('')}
                ${!catArts.length ? `<li style="font-size:0.75rem;color:#78938b;padding:2px 8px;">Próximamente</li>` : ''}
              </ul>
            </div>`;
          }).join('') + `</div></aside>`;

        if(!targetId){
          category = 'Wiki Sanantes · Biblioteca Técnica';
          title = cleanTitle('Wiki Sanantes · Oncología Integrativa y Evidencia');
          desc = cleanDesc('Wiki Sanantes: Enciclopedia técnica y base de evidencia sobre medicamentos reposicionados, estrategia metabólica, suplementos y terapias complementarias.');
          image = origin()+'/favicon.svg';
          targetUrl = origin()+'/#wiki';
          canonicalUrl = origin()+'/wiki';
          let pillarsHtml = '';
          for(const c of cats){
            const catArts = arts.filter(a => a.category_id === c.id || a.category === c.name);
            pillarsHtml += `<section id="pillar-${c.slug||c.id}" style="margin-bottom:32px;background:#fbfdfc;border:1px solid #dce8df;border-radius:12px;padding:24px;">
              <h2 style="color:#123d39;margin:0 0 8px;font-size:1.35rem;display:flex;align-items:center;gap:10px;"><span>${c.icon||'📚'}</span> ${escHtml(c.name)}</h2>
              <p style="color:#55726a;margin:0 0 16px;font-size:0.9rem;line-height:1.5;">${escHtml(c.description||'')}</p>
              ${catArts.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;">` + catArts.map(a => `
                <a href="${origin()}/wiki/${a.slug}" style="display:block;background:#fff;border:1px solid #d8e5dd;border-radius:10px;padding:16px;text-decoration:none;color:#18322d;transition:box-shadow .15s ease;">
                  <span style="display:inline-block;background:#e8f4ec;color:#1e6b42;font-size:0.75rem;font-weight:700;padding:3px 8px;border-radius:6px;margin-bottom:8px;">⚖️ ${escHtml(a.evidence_level||'Evidencia')}</span>
                  <h3 style="margin:0 0 6px;color:#123d39;font-size:1.05rem;line-height:1.35;">${escHtml(a.title)}</h3>
                  ${a.subtitle?`<p style="margin:0 0 8px;color:#55726a;font-size:0.85rem;line-height:1.4;">${escHtml(a.subtitle)}</p>`:''}
                  <p style="margin:0;color:#28433d;font-size:0.85rem;line-height:1.5;">${escHtml((a.excerpt||'').slice(0,140))}...</p>
                </a>
              `).join('') + `</div>` : `<p style="color:#78938b;font-size:0.85rem;font-style:italic;margin:0;">Próximas monografías en desarrollo para este pilar.</p>`}
            </section>`;
          }
          const tocHubHtml = `<aside style="background:#fff;border-radius:12px;border:1px solid #dce8df;padding:20px;position:sticky;top:20px;">
            <div style="font-size:0.75rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#7a8f87;margin-bottom:12px;">Índice de Pilares</div>
            <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:0.82rem;">
              ${cats.map(c=>`<li><a href="#pillar-${c.slug||c.id}" style="color:#55726a;text-decoration:none;">• ${escHtml(c.name)}</a></li>`).join('')}
            </ul>
          </aside>`;
          fullContentHtml = `<div class="wiki-grid">
            <div class="wiki-left-col">${wikiSidebarHtml}</div>
            <div class="wiki-center-col">
              <article style="background:#ffffff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(18,61,57,0.06);">
                <nav style="display:flex;align-items:center;gap:8px;font-size:0.82rem;color:#6b877f;margin-bottom:16px;"><a href="${origin()}/" style="color:#1e6b42;text-decoration:none;">Inicio</a> <span>/</span> <span style="font-weight:600;color:#18322d;">Wiki Sanantes</span></nav>
                <span style="display:inline-block;background:#e8f0ec;color:#123d39;padding:4px 12px;border-radius:12px;font-size:0.8rem;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">BIBLIOTECA ABIERTA Y RIGOR CIENTÍFICO</span>
                <h1 style="color:#123d39;font-size:1.85rem;margin:0 0 16px;line-height:1.35;">Wiki Sanantes</h1>
                <p style="font-size:1.1rem;color:#3b5a52;margin-bottom:20px;line-height:1.6;">
                  Compendio colaborativo y base de evidencia sobre medicamentos reposicionados, estrategia metabólica celular, investigadores referentes, suplementos y terapias integrativas.
                </p>
                <div style="background:#f4f8f6;border-left:4px solid #1e6b42;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;font-size:0.95rem;line-height:1.65;color:#1d3e36;">
                  <strong>🧭 Estándar Documental de Evidencia:</strong> Cada monografía clasifica el nivel de investigación disponible con enlaces directos a sus respectivos identificadores <strong>PMID de PubMed</strong>.
                </div>
                ${pillarsHtml}
              </article>
            </div>
            <div class="wiki-right-col">${tocHubHtml}</div>
          </div>`;
          schemaJson=JSON.stringify({
            "@context":"https://schema.org",
            "@type":"CollectionPage",
            "name":title,
            "description":desc,
            "url":canonicalUrl,
            "publisher":orgPublisher
          });
        }else{
          const [art]=(await query("SELECT * FROM wiki_articles WHERE (slug=? OR id=?) AND status='published'",[targetId,targetId]))||[];
          if(art){
            category = 'Wiki Sanantes · ' + (art.category||'Investigación');
            title = (art.title + ' · Wiki Sanantes').length <= 60 
              ? (art.title + ' · Wiki Sanantes')
              : cleanTitle(art.title + ' · Sanantes', 60);
            desc = cleanDesc(art.excerpt || art.title, 155);
            image = origin()+'/favicon.svg';
            targetUrl = origin()+'/#wiki/'+art.slug;
            canonicalUrl = origin()+'/wiki/'+art.slug;
            let citations = [];
            try { citations = JSON.parse(art.pubmed_citations||'[]'); } catch(e){}
            let pubmedHtml = '';
            if(citations.length > 0){
              pubmedHtml = `<div id="referencias" style="margin:28px 0;background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:20px;">
                <h3 style="color:#123d39;margin:0 0 14px;font-size:1.15rem;display:flex;align-items:center;gap:8px;">📚 Referencias y Evidencia en MEDLINE / PubMed</h3>
                <ul style="margin:0;padding-left:20px;line-height:1.8;">
                  ${citations.map(c => `<li style="margin-bottom:8px;"><strong style="color:#183d35;">PMID: ${escHtml(c)}</strong> &mdash; <a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(c)}/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>`).join('')}
                </ul>
              </div>`;
            }
            const relatedWords = art.slug.split('-').filter(w => w.length > 3);
            let relatedVideos = [];
            if(relatedWords.length > 0){
              const likePattern = '%' + relatedWords[0] + '%';
              relatedVideos = (await query("SELECT id,title,description,thumbnail,external_id,platform FROM videos WHERE status='published' AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?) LIMIT 3", [likePattern, likePattern])) || [];
            }
            let relatedVideosHtml = '';
            if(relatedVideos.length > 0){
              relatedVideosHtml = `<div id="videos" style="margin-top:32px;"><h3 style="color:#123d39;margin:0 0 16px;font-size:1.2rem;">Episodios relacionados en El Podcast del Cáncer:</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;">` +
                relatedVideos.map(v => {
                  const rThumb = v.platform==='youtube'&&v.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : (v.thumbnail || origin()+'/favicon.svg');
                  return `<a href="${origin()}/v/${v.id}" style="display:flex;flex-direction:column;background:#f9fbf9;border:1px solid #dce8df;border-radius:10px;overflow:hidden;text-decoration:none;color:#18322d;"><div style="position:relative;padding-bottom:56.25%;background:#0b292b;"><img src="${rThumb}" alt="${escHtml(v.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></div><div style="padding:12px;"><h4 style="margin:0 0 6px;font-size:0.9rem;line-height:1.35;color:#123d39;font-weight:700;">${escHtml(v.title)}</h4></div></a>`;
                }).join('') + `</div></div>`;
            }
            let affiliateCardHtml = '';
            const isSupp = (art.category||'').toLowerCase().includes('suplemento');
            const isTherapyOrDevice = (art.category||'').toLowerCase().includes('terapia') || art.slug.includes('dieta-cetogenica') || (art.body||'').includes('amzn.to');

            if(isSupp){
              const suppNames = {
                'berberina': 'Berberina',
                'curcumina': 'Curcumina / Cúrcuma',
                'pectina-citrica-modificada': 'Pectina Cítrica Modificada (MCP)',
                'hongos-medicinales': 'Hongos Medicinales (Reishi, Melena de León, Cola de Pavo)',
                'te-verde-egcg': 'Extracto de Té Verde EGCG',
                'aceite-semilla-negra-timoquinona': 'Aceite de Semilla Negra (Timoquinona)',
                'melatonina-oncologia': 'Melatonina Grado Clínico',
                'cardo-mariano-silimarina': 'Cardo Mariano (Silimarina)',
                'omega-3-epa-dha': 'Omega-3 EPA / DHA',
                'ashwagandha-withania': 'Ashwagandha KSM-66',
                'graviola-guanabana': 'Graviola / Guanábana',
                'artemisinina-artemisia-annua': 'Artemisinina Pura',
                'beta-glucanos-inmunologia-reishi-cola-pavo': 'Beta-Glucanos Inmunológicos',
                'calostro-bovino-factores-transferencia-galt': 'Calostro Bovino y Transfer Factors',
                'probioticos-multicepa-microbioma-eje-inmune': 'Probióticos Multicepa',
                'aceite-oliva-virgen-extra-oleocantal': 'Aceite de Oliva Virgen Extra Rico en Oleocantal',
                'aceite-esencial-incienso-boswellia-akba': 'Incienso / Boswellia Serrata (AKBA)'
              };
              const suppName = suppNames[art.slug] || art.title.split(':')[0];
              const bodyMatch = (art.body || '').match(/https?:\/\/(?:www\.)?iherb\.com\/search[^\s\)\>]+/);
              const searchUrl = bodyMatch ? bodyMatch[0].replace(/&amp;/g, '&') : `https://www.iherb.com/search?kw=${encodeURIComponent(art.slug.replace(/-/g,' '))}&rcode=wUt7svK8`;
              affiliateCardHtml += `<div id="adquisicion-iherb" class="wiki-affiliate-card" style="margin:28px 0;padding:24px;background:linear-gradient(135deg,#f2f8f4 0%,#e7f4eb 100%);border:2px solid #2e7d32;border-radius:14px;box-shadow:0 4px 16px rgba(46,125,50,0.08);">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                  <span style="font-size:2rem;line-height:1;">🌿</span>
                  <div>
                    <h3 style="margin:0;color:#123d39;font-size:1.25rem;font-weight:800;">Adquisición de Grado Terapéutico en iHerb</h3>
                    <p style="margin:2px 0 0;color:#3b6559;font-size:0.88rem;">Fórmulas verificadas en pureza y biodisponibilidad · Descuento exclusivo de comunidad</p>
                  </div>
                </div>
                <p style="margin:0 0 16px;color:#203c34;font-size:0.95rem;line-height:1.65;">
                  Puedes adquirir fórmulas seleccionadas de <strong>${escHtml(suppName)}</strong> aplicando nuestro código de descuento de comunidad:
                  <span style="display:inline-block;background:#ffffff;border:1px dashed #2e7d32;padding:4px 10px;border-radius:6px;color:#1e6b42;font-family:monospace;font-size:1.05rem;font-weight:700;margin-left:4px;">wUt7svK8</span>
                </p>
                <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
                  <a href="${searchUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;background:#2e7d32;color:#ffffff;font-weight:700;padding:12px 24px;border-radius:30px;text-decoration:none;font-size:0.95rem;box-shadow:0 3px 10px rgba(46,125,50,0.25);">
                    🛒 Ver ${escHtml(suppName)} en iHerb →
                  </a>
                  <a href="https://iherb.co/wUt7svK8" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;background:#ffffff;color:#1e6b42;border:1px solid #a3cbb3;font-weight:600;padding:11px 20px;border-radius:30px;text-decoration:none;font-size:0.9rem;">
                    Enlace directo comunidad (wUt7svK8) ↗
                  </a>
                </div>
              </div>`;
            }

            if(isTherapyOrDevice){
              const devNames = {
                'fotobiomodulacion-luz-roja': 'Paneles y Lámparas de Luz Roja e Infrarroja (660nm / 850nm)',
                'pemf-campos-magneticos-pulsados-bemer': 'Esterillas y Dispositivos de Campos PEMF',
                'oxigenoterapia-hiperbarica-hbot': 'Cámaras Hiperbáricas Portátiles y Accesorios',
                'sauna-infrarrojo-lejano-detox': 'Mantas Térmicas y Saunas Infrarrojos Lejanos de Bajo CEM',
                'sauna-ozono-tecnologia-hocatt': 'Equipos Generadores de Ozono Terapéutico y Saunas Corporales',
                'estimulacion-nervio-vago-vns': 'Dispositivos de Bioestimulación del Nervio Vago (tVNS)',
                'terapia-frecuencias-maquina-rife': 'Equipos de Resonancia Bioeléctrica y Frecuencias RIFE',
                'terapia-jugos-desintoxicacion-enzimas': 'Extractores Lentos de Prensado en Frío (Cold-Press Juicers)',
                'cuidado-quiropractico-alineacion-neuroinmune': 'Dispositivos de Tracción Cervical y Descompresión Espinal',
                'dieta-cetogenica-oncologia-metabolica': 'Kit de Medición de Cetonas y Glucosa en Sangre (Keto-Mojo)'
              };
              const devName = devNames[art.slug] || art.title.split(':')[0];
              affiliateCardHtml += `<div id="equipamiento-amazon" class="wiki-affiliate-card amazon-card" style="margin:28px 0;padding:24px;background:linear-gradient(135deg,#fffbf5 0%,#fef6e7 100%);border:2px solid #e08b1f;border-radius:14px;box-shadow:0 4px 16px rgba(224,139,31,0.09);">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                  <span style="font-size:2rem;line-height:1;">🛒</span>
                  <div>
                    <h3 style="margin:0;color:#232f3e;font-size:1.25rem;font-weight:800;">Equipamiento y Dispositivos en Amazon</h3>
                    <p style="margin:2px 0 0;color:#5a4a35;font-size:0.88rem;">Dispositivos con valoraciones verificadas para el protocolo en casa o consultorio</p>
                  </div>
                </div>
                <p style="margin:0 0 16px;color:#2b2217;font-size:0.95rem;line-height:1.65;">
                  Para implementar este protocolo con precisión y seguridad, puedes adquirir opciones certificadas de <strong>${escHtml(devName)}</strong> en Amazon:
                </p>
                <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
                  <a href="https://amzn.to/46PTWSA" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;background:#f09d23;color:#111111;font-weight:700;padding:12px 24px;border-radius:30px;text-decoration:none;font-size:0.95rem;box-shadow:0 3px 10px rgba(240,157,35,0.3);">
                    🛒 Ver Opciones de Equipamiento en Amazon →
                  </a>
                  <a href="https://amzn.to/46PTWSA" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;background:#ffffff;color:#965d0a;border:1px solid #dcb074;font-weight:600;padding:11px 20px;border-radius:30px;text-decoration:none;font-size:0.9rem;">
                    Enlace de Afiliado Oficial Sanantes ↗
                  </a>
                </div>
              </div>`;
            }
            const idx = arts.findIndex(x => x.id === art.id || x.slug === art.slug);
            const prevArt = idx > 0 ? arts[idx - 1] : null;
            const nextArt = idx < arts.length - 1 ? arts[idx + 1] : null;
            const paginationHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:36px 0 20px;padding-top:20px;border-top:1px solid #eef3f0;">
              ${prevArt ? `<a href="${origin()}/wiki/${prevArt.slug}" style="padding:14px 18px;border:1px solid #dce8df;border-radius:10px;background:#fff;text-decoration:none;display:flex;flex-direction:column;"><span style="font-size:0.75rem;color:#78938b;font-weight:700;text-transform:uppercase;">← Anterior</span><span style="font-size:0.9rem;font-weight:700;color:#123d39;">${escHtml(prevArt.title)}</span></a>` : '<div></div>'}
              ${nextArt ? `<a href="${origin()}/wiki/${nextArt.slug}" style="padding:14px 18px;border:1px solid #dce8df;border-radius:10px;background:#fff;text-decoration:none;display:flex;flex-direction:column;text-align:right;"><span style="font-size:0.75rem;color:#78938b;font-weight:700;text-transform:uppercase;">Siguiente →</span><span style="font-size:0.9rem;font-weight:700;color:#123d39;">${escHtml(nextArt.title)}</span></a>` : '<div></div>'}
            </div>`;
            const tocArtHtml = `<aside style="background:#fff;border-radius:12px;border:1px solid #dce8df;padding:20px;position:sticky;top:20px;">
              <div style="font-size:0.75rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#7a8f87;margin-bottom:12px;">En esta página</div>
              <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:0.82rem;">
                ${art.excerpt ? `<li><a href="#resumen" style="color:#55726a;text-decoration:none;">• Resumen Ejecutivo</a></li>` : ''}
                ${art.mechanisms ? `<li><a href="#mecanismos" style="color:#55726a;text-decoration:none;">• Mecanismos Biológicos</a></li>` : ''}
                ${art.clinical_status ? `<li><a href="#estado-clinico" style="color:#55726a;text-decoration:none;">• Estado Clínico</a></li>` : ''}
                <li><a href="#investigacion" style="color:#55726a;text-decoration:none;">• Monografía y Análisis</a></li>
                ${isSupp ? `<li><a href="#adquisicion-iherb" style="color:#1e6b42;font-weight:700;text-decoration:none;">• Adquisición en iHerb</a></li>` : ''}
                ${isTherapyOrDevice ? `<li><a href="#equipamiento-amazon" style="color:#d97706;font-weight:700;text-decoration:none;">• Equipamiento en Amazon</a></li>` : ''}
                ${citations.length ? `<li><a href="#referencias" style="color:#55726a;text-decoration:none;">• Citas PubMed</a></li>` : ''}
                ${relatedVideos.length ? `<li><a href="#videos" style="color:#55726a;text-decoration:none;">• Videos Relacionados</a></li>` : ''}
              </ul>
            </aside>`;
            fullContentHtml = `<div class="wiki-grid">
              <div class="wiki-left-col">${wikiSidebarHtml}</div>
              <div class="wiki-center-col">
                <article style="background:#ffffff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(18,61,57,0.06);">
                  <nav style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:0.82rem;color:#6b877f;margin-bottom:16px;">
                    <a href="${origin()}/" style="color:#1e6b42;text-decoration:none;">Inicio</a> <span>/</span>
                    <a href="${origin()}/wiki" style="color:#1e6b42;text-decoration:none;">Wiki Sanantes</a> <span>/</span>
                    <span>${escHtml(art.category||'Wiki')}</span> <span>/</span>
                    <span style="font-weight:600;color:#18322d;">${escHtml(art.title)}</span>
                  </nav>
                  <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;">
                    <span style="background:#e8f4ec;color:#1e6b42;font-size:0.85rem;font-weight:700;padding:5px 12px;border-radius:20px;">⚖️ Nivel de Evidencia: ${escHtml(art.evidence_level||'Preclínica')}</span>
                    <span style="background:#eef3f0;color:#35534b;font-size:0.85rem;font-weight:600;padding:5px 12px;border-radius:20px;">🏛️ ${escHtml(art.category||'Wiki')}</span>
                  </div>
                  <h1 style="color:#123d39;font-size:1.85rem;margin:0 0 16px;line-height:1.35;">${escHtml(art.title)}</h1>
                  ${art.subtitle ? `<p style="font-size:1.15rem;color:#395a52;margin:0 0 20px;font-weight:500;line-height:1.5;">${escHtml(art.subtitle)}</p>` : ''}
                  ${art.excerpt ? `<div id="resumen" style="background:#f4f8f6;border-left:4px solid #1e6b42;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;font-size:1.02rem;line-height:1.65;color:#1d3e36;"><strong>Resumen Ejecutivo:</strong> ${escHtml(art.excerpt)}</div>` : ''}
                  ${art.mechanisms ? `<div id="mecanismos" style="margin:24px 0;padding:18px;background:#fbfdfc;border:1px solid #dce8df;border-radius:10px;"><h3 style="margin:0 0 10px;color:#123d39;font-size:1.15rem;">🧬 Mecanismos Biológicos y Farmacodinámicos</h3><p style="margin:0;line-height:1.7;">${escHtml(art.mechanisms)}</p></div>` : ''}
                  ${art.clinical_status ? `<div id="estado-clinico" style="margin:24px 0;padding:18px;background:#fbfdfc;border:1px solid #dce8df;border-radius:10px;"><h3 style="margin:0 0 10px;color:#123d39;font-size:1.15rem;">📋 Estado Clínico y Regulatorio</h3><p style="margin:0;line-height:1.7;">${escHtml(art.clinical_status)}</p></div>` : ''}
                  <div id="investigacion" style="margin:24px 0;line-height:1.8;">${formatRichText(art.body)}</div>
                  ${affiliateCardHtml}
                  ${pubmedHtml}
                  ${relatedVideosHtml}
                  ${paginationHtml}
                  <div style="text-align:center;margin:32px 0 12px;padding-top:20px;border-top:1px solid #edf2ef;">
                    <a href="${escHtml(targetUrl)}" style="display:inline-block;background:#d65337;color:#fff;font-weight:700;padding:12px 26px;border-radius:30px;text-decoration:none;font-size:0.95rem;box-shadow:0 3px 10px rgba(214,83,55,0.25);">Abrir en la app de Sanantes</a>
                  </div>
                </article>
              </div>
              <div class="wiki-right-col">${tocArtHtml}</div>
            </div>`;
            schemaJson=JSON.stringify({
              "@context":"https://schema.org",
              "@type":"MedicalWebPage",
              "headline":art.title,
              "description":desc,
              "medicalSpecialty":"Oncology",
              "about":{"@type":"MedicalEntity","name":art.title},
              "citation":citations.map(c=>`https://pubmed.ncbi.nlm.nih.gov/${c}/`),
              "publisher":orgPublisher
            });
          }
        }
      }else if(!type){
        category = 'Portal de Oncología Integrativa';
        title = cleanTitle('Comunidad Sanantes · El Podcast del Cáncer');
        desc = cleanDesc('Plataforma y podcast de oncología integrativa, medicina metabólica y fármacos reposicionados. Investigaciones, análisis del Dr. William Makis y acompañamiento.', 155);
        image = 'https://i.ytimg.com/vi/008JfHS61Ww/hqdefault.jpg';
        targetUrl = origin() + (ref ? '/?ref=' + encodeURIComponent(ref) : '/');
        canonicalUrl = origin() + '/';

        const s = await settings();
        const allPublishedVideos = (await query("SELECT videos.id,videos.title,videos.description,videos.thumbnail,videos.external_id,videos.platform,videos.kind,videos.category,videos.published_at,sources.own FROM videos LEFT JOIN sources ON sources.id=videos.source_id WHERE videos.status='published' ORDER BY videos.published_at DESC LIMIT 60")) || [];
        const featVideoIds = [s.homeFeaturedVideo1, s.homeFeaturedVideo2, s.homeFeaturedVideo3, s.homeFeaturedVideo4].filter(Boolean);
        const featVideos = [];
        for(const id of featVideoIds){
          const found = allPublishedVideos.find(v => v.id === id);
          if(found && !featVideos.some(x => x.id === found.id)) featVideos.push(found);
        }
        for(const v of allPublishedVideos){
          if(featVideos.length >= 4) break;
          if(v.kind === 'video' && !featVideos.some(x => x.id === v.id)) featVideos.push(v);
        }

        let featLive = s.homeFeaturedLive ? allPublishedVideos.find(v => v.id === s.homeFeaturedLive) : null;
        if(!featLive){
          featLive = allPublishedVideos.find(v => v.kind === 'live' && (v.category === 'Música y relajación' || (v.title||'').toLowerCase().includes('pizarra'))) || allPublishedVideos.find(v => v.kind === 'live');
        }

        const allPublishedPosts = (await query("SELECT id,slug,title,excerpt,download_url,download_title FROM posts WHERE status='published' ORDER BY updated_at DESC LIMIT 10")) || [];
        let featPost = s.homeFeaturedPost ? allPublishedPosts.find(p => p.slug === s.homeFeaturedPost || p.id === s.homeFeaturedPost) : null;
        if(!featPost && allPublishedPosts.length) featPost = allPublishedPosts[0];

        const allPublishedWikis = (await query("SELECT id,slug,title,subtitle,excerpt,evidence_level,category FROM wiki_articles WHERE status='published' ORDER BY updated_at DESC LIMIT 20")) || [];
        let featWiki = s.homeFeaturedWiki ? allPublishedWikis.find(w => w.slug === s.homeFeaturedWiki || w.id === s.homeFeaturedWiki) : null;
        if(!featWiki && allPublishedWikis.length) featWiki = allPublishedWikis.find(w => w.slug === 'ivermectina') || allPublishedWikis[0];

        const videoGridHtml = featVideos.map(v => {
          const rThumb = v.platform === 'youtube' && v.external_id ? `https://i.ytimg.com/vi/${v.external_id}/hqdefault.jpg` : (v.thumbnail || origin() + '/favicon.svg');
          return `<article style="display:flex;flex-direction:column;background:#fff;border:1px solid #dce8df;border-radius:10px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.03);">
            <a href="${origin()}/v/${v.id}" style="text-decoration:none;color:inherit;">
              <div style="position:relative;padding-bottom:56.25%;background:#0b292b;">
                <img src="${rThumb}" alt="${escHtml(v.title)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;">
              </div>
              <div style="padding:14px;">
                <span style="display:inline-block;font-size:0.75rem;font-weight:700;color:#1e6b42;text-transform:uppercase;margin-bottom:6px;">${escHtml(v.category||'Investigación')}</span>
                <h3 style="margin:0 0 8px;font-size:0.95rem;line-height:1.4;color:#123d39;font-weight:700;">${escHtml(v.title)}</h3>
                <p style="margin:0;font-size:0.82rem;color:#4f6d65;line-height:1.5;">${escHtml((v.description||'').slice(0,140))}...</p>
              </div>
            </a>
          </article>`;
        }).join('');

        const liveHtml = featLive ? `
          <div style="margin:36px 0;background:linear-gradient(135deg,#123d39 0%,#0b2623 100%);color:#fff;border-radius:14px;padding:24px;box-shadow:0 6px 20px rgba(18,61,57,0.12);">
            <span style="display:inline-block;background:rgba(255,255,255,0.15);color:#8be3b8;padding:4px 10px;border-radius:12px;font-size:0.75rem;font-weight:700;text-transform:uppercase;margin-bottom:10px;">Directo Destacado · Música y Pizarra del Podcast</span>
            <h3 style="color:#fff;margin:0 0 10px;font-size:1.3rem;">${escHtml(featLive.title)}</h3>
            <p style="color:#cbe0d5;margin:0 0 16px;line-height:1.6;font-size:0.92rem;">Espacio de relajación activa, reducción de cortisol neurovegetativo y pizarra gráfica de estudio visual para acompañar el aprendizaje de nuestras investigaciones.</p>
            <a href="${origin()}/v/${featLive.id}" style="display:inline-flex;align-items:center;gap:6px;background:#d65337;color:#fff;padding:10px 20px;border-radius:24px;text-decoration:none;font-size:0.9rem;font-weight:700;">▶ Ver sesión en directo</a>
          </div>
        ` : '';

        const scienceHtml = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin:32px 0;">
            ${featPost ? `
              <div style="background:#fff;border:1px solid #dce8df;border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-content:space-between;">
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                    <span style="font-size:0.75rem;font-weight:700;color:#1e6b42;text-transform:uppercase;">Blog Destacado</span>
                    ${featPost.download_url ? `<span style="font-size:0.72rem;background:#e8f4ec;color:#1e6b42;padding:2px 8px;border-radius:10px;font-weight:700;">📄 Incluye PDF</span>` : ''}
                  </div>
                  <h4 style="margin:0 0 8px;font-size:1.05rem;line-height:1.4;color:#123d39;"><a href="${origin()}/b/${featPost.slug}" style="text-decoration:none;color:inherit;">${escHtml(featPost.title)}</a></h4>
                  <p style="margin:0;font-size:0.85rem;color:#4f6d65;line-height:1.5;">${escHtml((featPost.excerpt||'').slice(0,140))}...</p>
                </div>
                <div style="margin-top:16px;border-top:1px solid #edf2ef;padding-top:10px;">
                  <a href="${origin()}/b/${featPost.slug}" style="color:#d65337;font-weight:700;font-size:0.88rem;text-decoration:none;">Leer artículo y descargar PDF →</a>
                </div>
              </div>
            ` : ''}
            ${featWiki ? `
              <div style="background:#fff;border:1px solid #dce8df;border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-content:space-between;">
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                    <span style="font-size:0.75rem;font-weight:700;color:#1e6b42;text-transform:uppercase;">Wiki Sanantes · ${escHtml(featWiki.category||'Monografía')}</span>
                    <span style="font-size:0.72rem;background:#e8f4ec;color:#1e6b42;padding:2px 8px;border-radius:10px;font-weight:700;">⚖️ ${escHtml(featWiki.evidence_level||'Evidencia')}</span>
                  </div>
                  <h4 style="margin:0 0 8px;font-size:1.05rem;line-height:1.4;color:#123d39;"><a href="${origin()}/wiki/${featWiki.slug}" style="text-decoration:none;color:inherit;">${escHtml(featWiki.title)}</a></h4>
                  <p style="margin:0;font-size:0.85rem;color:#4f6d65;line-height:1.5;">${escHtml((featWiki.subtitle||featWiki.excerpt||'').slice(0,140))}...</p>
                </div>
                <div style="margin-top:16px;border-top:1px solid #edf2ef;padding-top:10px;">
                  <a href="${origin()}/wiki/${featWiki.slug}" style="color:#1e6b42;font-weight:700;font-size:0.88rem;text-decoration:none;">Consultar monografía en la Wiki →</a>
                </div>
              </div>
            ` : ''}
          </div>
        `;

        fullContentHtml = `
          <div style="margin:20px 0;line-height:1.7;color:#233833;">
            <p style="font-size:1.1rem;color:#35534b;margin-bottom:24px;line-height:1.75;">
              Comunidad Sanantes y El Podcast del Cáncer integran investigación científica rigurosa, protocolos basados en evidencia y soporte humano para pacientes, familias y profesionales de la salud. Nuestro repositorio examina literatura clínica en MEDLINE/PubMed sobre el reposicionamiento de medicamentos, oncología metabólica, nutracéuticos de grado terapéutico y terapias complementarias.
            </p>

            <h2 style="color:#123d39;font-size:1.35rem;margin:32px 0 16px;font-weight:700;">Áreas y Recursos de Sanantes:</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:32px;">
              <div style="background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:16px;">
                <div style="font-size:1.4rem;margin-bottom:6px;">🎬</div>
                <strong style="color:#123d39;font-size:0.95rem;">El Podcast del Cáncer</strong>
                <p style="font-size:0.82rem;color:#4f6d65;margin:4px 0 8px;line-height:1.5;">Episodios monográficos y análisis del Dr. William Makis en español.</p>
                <a href="${origin()}/#podcast" style="color:#d65337;font-size:0.82rem;font-weight:700;">Ir a videoteca →</a>
              </div>
              <div style="background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:16px;">
                <div style="font-size:1.4rem;margin-bottom:6px;">🏛️</div>
                <strong style="color:#123d39;font-size:0.95rem;">Wiki Sanantes</strong>
                <p style="font-size:0.82rem;color:#4f6d65;margin:4px 0 8px;line-height:1.5;">Compendio en 5 pilares con nivel de evidencia y citas PubMed.</p>
                <a href="${origin()}/wiki" style="color:#1e6b42;font-size:0.82rem;font-weight:700;">Explorar Wiki →</a>
              </div>
              <div style="background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:16px;">
                <div style="font-size:1.4rem;margin-bottom:6px;">📖</div>
                <strong style="color:#123d39;font-size:0.95rem;">Blog y Descargas</strong>
                <p style="font-size:0.82rem;color:#4f6d65;margin:4px 0 8px;line-height:1.5;">Artículos de fondo y compendios descargables en PDF.</p>
                <a href="${origin()}/#blog" style="color:#d65337;font-size:0.82rem;font-weight:700;">Leer blog →</a>
              </div>
              <div style="background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:16px;">
                <div style="font-size:1.4rem;margin-bottom:6px;">🎵</div>
                <strong style="color:#123d39;font-size:0.95rem;">Directos y Pizarra</strong>
                <p style="font-size:0.82rem;color:#4f6d65;margin:4px 0 8px;line-height:1.5;">Música de relajación activa y pizarra gráfica explicativa.</p>
                <a href="${origin()}/#directos" style="color:#1e6b42;font-size:0.82rem;font-weight:700;">Ver directos →</a>
              </div>
            </div>

            <h2 style="color:#123d39;font-size:1.35rem;margin:32px 0 16px;font-weight:700;">Episodios e Investigaciones Destacadas:</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;">
              ${videoGridHtml}
            </div>

            ${liveHtml}
            ${scienceHtml}

            <div style="background:#eef5f1;border:1px solid #c9ded2;border-radius:12px;padding:24px;margin:32px 0;text-align:center;">
              <span style="display:inline-block;font-size:0.75rem;font-weight:700;color:#1e6b42;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Comunidad y Gamificación</span>
              <h3 style="color:#123d39;margin:0 0 10px;font-size:1.35rem;">Únete a Sanantes: Recibe +50 Puntos de Bienvenida</h3>
              <p style="color:#35534b;margin:0 0 18px;font-size:0.95rem;max-width:600px;margin-left:auto;margin-right:auto;line-height:1.6;">Crea tu cuenta gratuita para desbloquear descargas en PDF, sumar puntos difundiendo investigaciones y formar parte del Muro de Gratitud.</p>
              <a href="${origin()}/#comunidad" style="display:inline-block;background:#d65337;color:#fff;font-weight:700;padding:12px 28px;border-radius:30px;text-decoration:none;font-size:0.95rem;box-shadow:0 3px 10px rgba(214,83,55,0.25);">Unirme gratis a la comunidad →</a>
            </div>
          </div>
        `;

        schemaJson = JSON.stringify({
          "@context":"https://schema.org",
          "@graph":[
            {
              "@type":"WebSite",
              "name":"Comunidad Sanantes",
              "alternateName":["El Podcast del Cáncer","Podcast del Cáncer","Sanantes"],
              "url":origin(),
              "description":desc,
              "inLanguage":"es"
            },
            {
              "@type":"MedicalOrganization",
              "name":"Comunidad Sanantes",
              "alternateName":["El Podcast del Cáncer","Podcast del Cáncer"],
              "url":origin(),
              "logo":origin()+"/logo.png",
              "medicalSpecialty":"Oncology",
              "description":"Plataforma de recursos, podcast sobre el cáncer y comunidad de oncología integrativa para pacientes y familias.",
              "disclaimer":"Contenido informativo y de acompañamiento. No sustituye la atención médica especializada."
            }
          ]
        });
      }
      const sTitle=escHtml(title),sDesc=escHtml(desc),sImg=escHtml(image),sUrl=escHtml(targetUrl),sCanon=escHtml(canonicalUrl);
      res.statusCode=200;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Cache-Control','public, max-age=60, s-maxage=300');
      if(method==='HEAD') return res.end();
      return res.end(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sTitle}</title><meta name="description" content="${sDesc}"><link rel="canonical" href="${sCanon}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/logo.png"><meta property="og:type" content="article"><meta property="og:site_name" content="Comunidad Sanantes"><meta property="og:title" content="${sTitle}"><meta property="og:description" content="${sDesc}"><meta property="og:image" content="${sImg}"><meta property="og:image:secure_url" content="${sImg}"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720"><meta property="og:url" content="${sCanon}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${sTitle}"><meta name="twitter:description" content="${sDesc}"><meta name="twitter:image" content="${sImg}"><style>.wiki-grid{display:grid;grid-template-columns:260px minmax(0,1fr) 220px;gap:32px;align-items:start;max-width:1440px;margin:28px auto;padding:0 20px}@media(max-width:1150px){.wiki-grid{grid-template-columns:240px minmax(0,1fr)}.wiki-right-col{display:none}}@media(max-width:768px){.wiki-grid{grid-template-columns:1fr}}</style>${type==='video'?`<script>location.replace(${JSON.stringify(targetUrl)});</script>`:''}${schemaJson?`<script type="application/ld+json">${schemaJson}</script>`:''}</head><body style="margin:0;padding:0;background:#f3f6f4;color:#18322d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><header style="background:#123d39;color:#fff;padding:14px 20px;"><div style="max-width:${type==='wiki'?'1440px':'860px'};margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 10px;"><a href="${origin()}/" style="color:#fff;text-decoration:none;font-weight:700;font-size:1.1rem;display:flex;align-items:center;gap:8px;">🌿 Comunidad Sanantes <span style="font-weight:400;opacity:0.85;font-size:0.9rem;">· El Podcast del Cáncer</span></a><a href="${sUrl}" style="background:#d65337;color:#fff;padding:7px 16px;border-radius:20px;text-decoration:none;font-size:0.85rem;font-weight:600;">Abrir en la app</a></div></header>${type==='wiki'?fullContentHtml:`<main style="max-width:860px;margin:32px auto;padding:0 16px;"><article style="background:#ffffff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(18,61,57,0.06);">${category?`<span style="display:inline-block;background:#e8f0ec;color:#123d39;padding:4px 12px;border-radius:12px;font-size:0.8rem;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">${escHtml(category)}</span>`:''}<h1 style="color:#123d39;font-size:1.75rem;margin:0 0 20px;line-height:1.35;letter-spacing:-0.3px;">${sTitle}</h1>${activeEmbed?`<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:10px;margin:0 0 24px;background:#000;"><iframe src="${activeEmbed}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`:`<div style="text-align:center;margin:0 0 24px;"><img src="${sImg}" alt="${sTitle}" style="max-width:100%;border-radius:10px;height:auto;"></div>`}<div style="background:#f7faf8;border-left:4px solid #123d39;padding:12px 18px;margin:20px 0;border-radius:0 8px 8px 0;font-size:0.85rem;color:#35534b;line-height:1.5;"><strong>Aviso médico informativo:</strong> Este contenido es de carácter divulgativo y de acompañamiento. No sustituye la consulta médica, el diagnóstico ni el tratamiento oncológico profesional.</div>${fullContentHtml}<div style="text-align:center;margin:36px 0 16px;padding-top:24px;border-top:1px solid #edf2ef;"><p style="color:#57746c;font-size:0.95rem;margin-bottom:14px;">Únete a la conversación, guarda tus favoritos y gana puntos en la comunidad.</p><a href="${sUrl}" style="display:inline-block;background:#d65337;color:#fff;font-weight:700;padding:13px 28px;border-radius:30px;text-decoration:none;font-size:1rem;box-shadow:0 3px 10px rgba(214,83,55,0.25);">Participar en Sanantes</a></div></article></main>`}<footer style="text-align:center;padding:24px 16px 40px;color:#6b877f;font-size:0.85rem;"><p style="margin:0 0 8px;">El Podcast del Cáncer · Un espacio de encuentro y esperanza.</p><p style="margin:0;"><a href="${origin()}/b/criterio-editorial" style="color:#1e6b42;font-weight:600;text-decoration:underline;">Criterio Editorial y Rigor Científico</a> &bull; <a href="${origin()}/wiki" style="color:#1e6b42;font-weight:600;text-decoration:none;">Wiki Sanantes</a> &bull; <a href="${origin()}/sitemap.xml" style="color:#6b877f;text-decoration:none;">Mapa del sitio</a> &bull; <a href="${origin()}/" style="color:#6b877f;text-decoration:none;">Inicio</a></p></footer></body></html>`);
    }
    if(path==='public'&&method==='GET'){
      const s=await settings();const [total]=await query('SELECT COALESCE(SUM(amount),0) total FROM donations');
      return send(res,{settings:s,donated:total.total,sources:await query('SELECT id,name,platform,url,own,last_sync FROM sources WHERE enabled=1'),videos:(await query("SELECT videos.*,sources.name source_name,sources.own FROM videos LEFT JOIN sources ON sources.id=videos.source_id WHERE videos.status='published' AND videos.kind IN ('video','live') ORDER BY featured DESC,published_at DESC LIMIT 300")).filter(v=>!exclusionReason(v)),posts:await query("SELECT * FROM posts WHERE status='published' ORDER BY updated_at DESC"),wikiCategories:await query("SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC"),wikiArticles:await query("SELECT id,slug,category,category_id,title,subtitle,evidence_level,excerpt,body,mechanisms,clinical_status,pubmed_citations,status,updated_at FROM wiki_articles WHERE status='published' ORDER BY title ASC"),me:await user(req),ranking:await getRanking()});
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
    if(path==='share'&&method==='POST'){const me=await requireUser(req);const b=await body(req);const vidId=text(b.videoId,64);const [vid]=(await query("SELECT id,title FROM videos WHERE id=? AND status='published'",[vidId]))||[];if(!vid)fail('Video no disponible',404);await rate('share:'+me.id,50);await query('INSERT INTO shares(id,user_id,video_id) VALUES(?,?,?) ON CONFLICT(user_id,video_id) DO NOTHING',[id(),me.id,vidId]);const [s]=await query('SELECT id FROM shares WHERE user_id=? AND video_id=?',[me.id,vidId]);let awarded=0;const recentShares=await query("SELECT id FROM points WHERE user_id=? AND event_key LIKE 'video_share:%' AND created_at >= datetime('now', '-20 minutes') LIMIT 1",[me.id]);if(!recentShares.length){const r=await query("INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,'video_share:'||?||':'||?) ON CONFLICT(event_key) DO NOTHING RETURNING id",[id(),me.id,2,'Difundir video: '+text(vid.title,60),me.id,vidId]);if(r.length)awarded=2;}return send(res,{url:origin()+'/v/'+vidId+'?ref='+s.id,awarded});}
    if(path==='post/unlock'&&method==='POST'){const me=await user(req);const b=await body(req);const slug=text(b.slug,100);const [p]=(await query("SELECT id,title FROM posts WHERE slug=? AND status='published'",[slug]))||[];if(!p)fail('Artículo no disponible',404);let awarded=0;if(me){const s=await settings();const pts=Number(s.referralPoints||10);const r=await query("INSERT INTO points(id,user_id,amount,reason,event_key) VALUES(?,?,?,?,'download_share:'||?||':'||?) ON CONFLICT(event_key) DO NOTHING RETURNING id",[id(),me.id,pts,'Compartir lectura: '+text(p.title,60),me.id,p.id]);if(r.length)awarded=pts;}return send(res,{ok:true,awarded});}
    if(path==='cron'&&method==='GET'){
      if(!secretEqual(req.headers.authorization||'', 'Bearer '+(process.env.CRON_SECRET||''))||!process.env.CRON_SECRET)fail('No autorizado',401);
      const sources=await query("SELECT * FROM sources WHERE enabled=1 AND platform!='rumble' ORDER BY COALESCE(last_sync,'') ASC LIMIT 1");const results=[];for(const s of sources){try{results.push({source:s.id,...await sync(s)})}catch(e){await query('UPDATE sources SET last_error=?,last_sync=CURRENT_TIMESTAMP WHERE id=?',[e.message,s.id]);results.push({source:s.id,error:e.message})}}
      await query('DELETE FROM rate_limits WHERE expires<?',[now()]);await query('DELETE FROM login_tokens WHERE expires<?',[now()]);await query('DELETE FROM sessions WHERE expires<?',[now()]);return send(res,{results});
    }
    if(path.startsWith('admin')){
      const me=await requireEditor(req);
      if(path==='admin'&&method==='GET'){
        if(me.role==='editor'){
          return send(res,{isEditorOnly:true,role:'editor',wikiCategories:await query('SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC'),wikiArticles:await query('SELECT * FROM wiki_articles ORDER BY updated_at DESC'),audit:await query("SELECT * FROM audit WHERE action LIKE 'Wiki%' ORDER BY created_at DESC LIMIT 30")});
        }
        return send(res,{role:'admin',wikiCategories:await query('SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC'),wikiArticles:await query('SELECT * FROM wiki_articles ORDER BY updated_at DESC'),classifierReady:!!process.env.TYPESAFE_API_KEY,classifications:await query('SELECT * FROM classifications ORDER BY created_at DESC LIMIT 100'),sources:await query('SELECT * FROM sources ORDER BY own DESC,name'),videos:await query('SELECT videos.*,media_labels.relevance,media_labels.response editorial_response FROM videos LEFT JOIN media_labels ON videos.id=media_labels.video_id ORDER BY videos.published_at DESC LIMIT 1000'),posts:await query('SELECT * FROM posts ORDER BY updated_at DESC'),users:await query('SELECT users.id,users.email,users.name,users.role,users.created_at,COALESCE(SUM(points.amount),0) points FROM users LEFT JOIN points ON users.id=points.user_id GROUP BY users.id'),settings:await settings(),donations:await query('SELECT donations.*,users.name user_name,users.email user_email FROM donations LEFT JOIN users ON donations.user_id=users.id ORDER BY donations.created_at DESC'),audit:await query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 50')});
      }
      const b=await body(req);
      if(path==='admin/wiki/article'&&method==='POST'){
        const title=text(b.title,300),slug=text(b.slug,120);
        if(!title||!/^[-a-z0-9]+$/.test(slug)||!['draft','published'].includes(b.status))fail('Revisa el título, el slug y el estado del artículo');
        let pubmedArr=[];
        if(Array.isArray(b.pubmed_citations))pubmedArr=b.pubmed_citations;
        else if(typeof b.pubmed_citations==='string'&&b.pubmed_citations.trim()){
          try{const parsed=JSON.parse(b.pubmed_citations);if(Array.isArray(parsed))pubmedArr=parsed;}catch{pubmedArr=b.pubmed_citations.split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);}
        }
        const pubmedJson=JSON.stringify(pubmedArr.map(x=>String(x).trim()));
        const artId=b.id||id();
        await query(`INSERT INTO wiki_articles(id,slug,category_id,category,title,subtitle,evidence_level,excerpt,body,mechanisms,clinical_status,pubmed_citations,status,author_id,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            slug=excluded.slug,category_id=excluded.category_id,category=excluded.category,title=excluded.title,subtitle=excluded.subtitle,
            evidence_level=excluded.evidence_level,excerpt=excluded.excerpt,body=excluded.body,mechanisms=excluded.mechanisms,
            clinical_status=excluded.clinical_status,pubmed_citations=excluded.pubmed_citations,status=excluded.status,updated_at=CURRENT_TIMESTAMP`,
          [artId,slug,text(b.category_id,64)||null,text(b.category,80)||'Medicamentos Reposicionados',title,text(b.subtitle,300),text(b.evidence_level,80)||'Preclínica / In vitro',text(b.excerpt,1000),text(b.body,50000),text(b.mechanisms,5000),text(b.clinical_status,5000),pubmedJson,b.status,me.id]
        );
        await audit(me.id,'Wiki artículo guardado: '+title);
        return send(res,{ok:true,id:artId});
      }
      if(path==='admin/wiki/article'&&method==='DELETE'){
        await query('DELETE FROM wiki_articles WHERE id=?',[b.id]);
        await audit(me.id,'Wiki artículo eliminado: '+text(b.id,64));
        return send(res,{ok:true});
      }
      if(path==='admin/wiki/category'&&method==='POST'){
        const name=text(b.name,120),slug=text(b.slug,100);
        if(!name||!/^[-a-z0-9]+$/.test(slug))fail('Revisa el nombre y el slug del pilar');
        const catId=b.id||id();
        const sortOrder=Number.isInteger(Number(b.sort_order))?Number(b.sort_order):0;
        await query(`INSERT INTO wiki_categories(id,slug,name,icon,description,sort_order)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            slug=excluded.slug,name=excluded.name,icon=excluded.icon,description=excluded.description,sort_order=excluded.sort_order`,
          [catId,slug,name,text(b.icon,20)||'📚',text(b.description,500),sortOrder]
        );
        await audit(me.id,'Wiki pilar guardado: '+name);
        return send(res,{ok:true,id:catId});
      }
      if(path==='admin/wiki/category'&&method==='DELETE'){
        await query('DELETE FROM wiki_categories WHERE id=?',[b.id]);
        await audit(me.id,'Wiki pilar eliminado: '+text(b.id,64));
        return send(res,{ok:true});
      }
      if(me.role!=='admin')fail('Esta sección es exclusiva del administrador',403);
      if(path==='admin/user/role'&&method==='POST'){
        if(!['member','editor','admin'].includes(b.role))fail('Rol inválido');
        const [targetUser]=(await query('SELECT id,email,role FROM users WHERE id=?',[b.user_id]))||[];
        if(!targetUser)fail('Usuario no encontrado',404);
        const adminEmail=(process.env.ADMIN_EMAIL||'artistproco@gmail.com').trim().toLowerCase();
        if(targetUser.email===adminEmail&&b.role!=='admin')fail('No se puede revocar el rol de administrador al propietario');
        await query('UPDATE users SET role=? WHERE id=?',[b.role,targetUser.id]);
        await audit(me.id,`Rol modificado para ${targetUser.email}: ${b.role}`);
        return send(res,{ok:true});
      }
      if(path==='admin/organize'&&method==='POST'){await rate('organize:'+me.id,12);try{const r=await organizePending();await audit(me.id,'Organización Jev: '+r.processed+' contenidos');return send(res,r)}catch(e){fail(e.message,502)}}
      if(path==='admin/classify'&&method==='POST'){await rate('classify:'+me.id,12);try{const result=await classifyPending();await audit(me.id,'Clasificación Jev: '+result.processed+' evaluados');return send(res,result)}catch(e){fail(e.message,502)}}
      if(path==='admin/source'&&method==='POST'){if(!platforms.includes(b.platform))fail('Plataforma no válida');mediaURL(b.url,b.platform);if(b.id){await query('UPDATE sources SET name=?,own=?,enabled=? WHERE id=?',[text(b.name,120),b.own?1:0,b.enabled?1:0,b.id]);}else{await query('INSERT INTO sources(id,name,platform,url,own) VALUES(?,?,?,?,?)',[id(),text(b.name,120)||b.platform,b.platform,b.url,b.own?1:0]);}await audit(me.id,'Fuente guardada: '+text(b.name));return send(res,{ok:true});}
      if(path==='admin/sync'&&method==='POST'){await rate('sync:'+me.id,30);const [s]=await query('SELECT * FROM sources WHERE id=?',[text(b.id,64)]);if(!s)fail('Fuente no encontrada',404);if(b.restart){s.cursor=null;await query('UPDATE sources SET cursor=NULL WHERE id=?',[s.id]);}try{const r=await sync(s);await audit(me.id,`Sincronización ${s.name}: ${r.added} nuevos`);return send(res,r)}catch(e){await query('UPDATE sources SET last_error=? WHERE id=?',[e.message,s.id]);fail(e.message,502);}}
      if(path==='admin/video'&&method==='POST'){
        if(!['video','live','review'].includes(b.kind)||!['pending','published','hidden'].includes(b.status))fail('Estado o tipo inválido');if(b.status==='published'&&b.kind==='review')fail('Clasifica el contenido como video o directo antes de publicarlo');
        const [existing]=b.id?await query('SELECT * FROM videos WHERE id=?',[b.id]):[];
        if(b.status==='published'&&exclusionReason({...existing,...b,duration:existing?.duration||0}))fail('Los directos musicales de menos de una hora están excluidos del catálogo');
        const title=text(b.title,400);if(!title)fail('Escribe un título');
        const external=b.id?existing?.external_id:identify(b.url,b.platform);
        const autoThumb=(b.platform==='youtube'||existing?.platform==='youtube')&&external?`https://i.ytimg.com/vi/${external}/hqdefault.jpg`:'';
        const thumb=safeImage(b.thumbnail)||autoThumb||existing?.thumbnail||'';
        if(b.id)await query('UPDATE videos SET title=?,description=?,category=?,kind=?,status=?,featured=?,thumbnail=? WHERE id=?',[title,text(b.description,15000),text(b.category,80)||'Conversaciones',b.kind,b.status,b.featured?1:0,thumb,b.id]);
        else{if(!platforms.includes(b.platform))fail('Plataforma inválida');if(!b.source_id||!(await query('SELECT id FROM sources WHERE id=? AND platform=?',[b.source_id,b.platform])).length)fail('Selecciona una fuente de la misma plataforma');await query('INSERT INTO videos(id,source_id,platform,external_id,title,description,url,thumbnail,published_at,kind,status,category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id(),b.source_id,b.platform,external,title,text(b.description,15000),b.url,thumb,new Date().toISOString(),b.kind,b.status,text(b.category,80)||'Conversaciones']);}
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
