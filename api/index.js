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
let productsSchemaChecked=false;
async function ensureProductsSchema(){
  if(productsSchemaChecked)return;
  try{
    await query(`CREATE TABLE IF NOT EXISTS products(
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'Suplementos y Nutracéuticos',
      category_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'iHerb',
      affiliate_url TEXT NOT NULL,
      original_price TEXT DEFAULT '',
      discount_code TEXT DEFAULT 'wUt7svK8',
      image_url TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await query('CREATE INDEX IF NOT EXISTS products_slug ON products(slug)');
    await query('CREATE INDEX IF NOT EXISTS products_status ON products(status)');

    const countRes=await query('SELECT COUNT(*) count FROM products');
    if(!countRes[0]?.count){
      const seedProducts=[
        {
          id:'prod-berberina',slug:'berberina-grado-terapeutico',category:'Suplementos y Nutracéuticos',
          title:'Berberina 500 mg (Grado Terapéutico)',subtitle:'Activador de AMPK y modulación del metabolismo tumoral',
          provider:'iHerb',affiliate_url:'https://www.iherb.com/search?kw=berberine&rcode=wUt7svK8',discount_code:'wUt7svK8',badge:'Grado Clínico',
          description:'Alcaloide vegetal para regular glucemia e insulina. Utilizado en el protocolo del Dr. Pete Sulack.',status:'published',sort_order:1
        },
        {
          id:'prod-curcumina',slug:'curcumina-c3-complex',category:'Suplementos y Nutracéuticos',
          title:'Curcumina C3 Complex (Alta Biodisponibilidad)',subtitle:'Inhibición NF-kB y apagado del microambiente inflamatorio',
          provider:'iHerb',affiliate_url:'https://www.iherb.com/search?kw=curcumin%20turmeric&rcode=wUt7svK8',discount_code:'wUt7svK8',badge:'Descuento Comunidad',
          description:'Extracto estandarizado de curcuminoides para reducir citoquinas inflamatorias y VEGF.',status:'published',sort_order:2
        },
        {
          id:'prod-mcp',slug:'pectina-citrica-modificada-pectasol',category:'Suplementos y Nutracéuticos',
          title:'Pectina Cítrica Modificada PectaSol-C',subtitle:'Bloqueo competitivo de Galectina-3 y adhesión celular',
          provider:'iHerb',affiliate_url:'https://www.iherb.com/search?kw=modified%20citrus%20pectin&rcode=wUt7svK8',discount_code:'wUt7svK8',badge:'Patente Clínica',
          description:'Fracción soluble de bajo peso molecular (<15 kDa) para evitar fijación y colonización metastásica.',status:'published',sort_order:3
        },
        {
          id:'prod-luz-roja',slug:'panel-fotobiomodulacion-luz-roja',category:'Equipamiento Terapéutico',
          title:'Panel de Fotobiomodulación (Luz Roja e Infrarroja)',subtitle:'660nm / 850nm flicker-free para energía mitocondrial',
          provider:'Amazon',affiliate_url:'https://amzn.to/46PTWSA',discount_code:'',badge:'Equipamiento Verificado',
          description:'Dispositivo de fotobiomodulación para estimular la respiración celular y citocromo c oxidasa en casa.',status:'published',sort_order:4
        },
        {
          id:'prod-pemf',slug:'esterilla-campos-magneticos-pulsados-pemf',category:'Equipamiento Terapéutico',
          title:'Esterilla de Campos Magnéticos Pulsados (PEMF)',subtitle:'Repolarización de membrana y microcirculación capilar',
          provider:'Amazon',affiliate_url:'https://amzn.to/46PTWSA',discount_code:'',badge:'Tecnología Bioeléctrica',
          description:'Esterilla PEMF para favorecer la oxigenación tisular e intercambio iónico celular.',status:'published',sort_order:5
        }
      ];
      for(const p of seedProducts){
        await query(`INSERT INTO products(id,slug,category,title,subtitle,provider,affiliate_url,discount_code,badge,description,status,sort_order)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING`,
          [p.id,p.slug,p.category,p.title,p.subtitle,p.provider,p.affiliate_url,p.discount_code,p.badge,p.description,p.status,p.sort_order]
        );
      }
    }
    productsSchemaChecked=true;
  }catch(e){console.warn('Auto-migración products:',e.message);}
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
        title:'Ivermectina en Oncología: Mecanismos Celulares y Evidencia Preclínica',
        subtitle:'Antiparasitario macrocíclico en estudio por modulación del transporte nuclear y estrés mitocondrial',
        evidence_level:'Preclínica / In vitro y Ensayos Fase I/II',
        excerpt:'La ivermectina es conocida como antiparasitario, pero en laboratorio ha mostrado efectos directos sobre células cancerosas: bloquea el transporte nuclear por importinas α/β, altera la mitocondria e inhibe la quinasa PAK1. Analizamos la evidencia preclínica y su alcance real en humanos.',
        body:`## De antiparasitario a objeto de estudio en oncología\nLa ivermectina nació a partir de la fermentación de *Streptomyces avermitilis*, descubrimiento que le valió el Premio Nobel a Satoshi Ōmura y William C. Campbell en 2015. Durante cuatro décadas se ha usado en millones de personas contra parasitosis como la oncocercosis, con un perfil de seguridad muy documentado. En los últimos años, varios grupos de investigación han querido entender por qué esta molécula interfiere con el crecimiento tumoral en ensayos de laboratorio.\n\n## Vías y dianas moleculares en el laboratorio\nLejos de tratarse de magia, los estudios in vitro y en modelos animales apuntan a dianas bioquímicas concretas:\n\n* **Transporte nuclear (Importinas α/β):** Para multiplicarse, las células tumorales envían continuamente proteínas y factores de señalización hacia su núcleo. La ivermectina bloquea este transporte mediado por importinas, dejando a la célula maligna sin órdenes de proliferación.\n* **Estrés mitocondrial y mitofagia:** Altera el potencial eléctrico de la membrana mitocondrial del tumor, elevando las especies reactivas de oxígeno (ROS) e induciendo muerte celular programada.\n* **La quinasa PAK1:** Esta enzima actúa como acelerador del crecimiento tumoral en más del 70% de los cánceres sólidos. La ivermectina frena su actividad, lo que en modelos celulares reduce la invasión.\n* **Sensibilización frente a quimioterapia:** Ciertas células malignas expulsan los quimioterápicos mediante bombas como la Glicoproteína P (P-gp). Al modular esta proteína, la ivermectina ayuda a que otros fármacos permanezcan dentro del tumor.\n\n## Realidad clínica actual\nLa mayor parte de la literatura científica procede de cultivos celulares y modelos animales. Aunque existen series de casos observacionales y médicos integrativos que la prescriben dentro de protocolos combinados off-label, faltan ensayos clínicos fase III aleatorizados. Cualquier uso debe contar con supervisión médica y nunca reemplazar el tratamiento oncológico a ciegas.`,
        mechanisms:'Inhibición importinas α/β, bloqueo PAK1, mitofagia tumoral, alteración ATP mitocondrial, modulación P-gp.',
        clinical_status:'Aprobado FDA/EMA como antiparasitario. Ensayos clínicos Fase I/II y estudios observacionales en oncología.',
        pubmed_citations:JSON.stringify(['29054452','33633575','32419409']),status:'published'
      },
      {
        id:'wiki-fenbendazol',slug:'fenbendazol',category:'Medicamentos Reposicionados',category_id:catMedsId,
        title:'Fenbendazol: Microtúbulos, Captación de Glucosa y Datos Preclínicos',
        subtitle:'Benzimidazol antiparasitario con acción sobre la tubulina y el metabolismo energético en células tumorales',
        evidence_level:'Preclínica / Modelos Animales',
        excerpt:'El fenbendazol es un desparasitante veterinario que en pruebas de laboratorio actúa de forma parecida a ciertos quimioterápicos: desestabiliza los microtúbulos e interfiere con el consumo de glucosa tumoral. Revisamos qué dice la ciencia real detrás del compuesto.',
        body:`## Origen del interés y qué es realmente este compuesto\nEl fenbendazol pertenece a los carbamatos de benzimidazol, fármacos usados habitualmente en veterinaria contra parásitos intestinales. Su salto al debate oncológico comenzó a raíz de testimonios difundidos en internet (como el caso de Joe Tippens) y de observaciones casuales en laboratorios de investigación con ratones, donde grupos tratados con fenbendazol mostraron una reducción inesperada en el crecimiento de tumores implantados.\n\n## Cómo interactúa con la biología del tumor\nLos estudios preclínicos publicados (especialmente el trabajo del laboratorio de Mukhopadhyay en Scientific Reports) describen tres mecanismos centrales:\n\n* **Desestabilización de microtúbulos:** De modo análogo a fármacos oncológicos como los taxanos o la vincristina, el fenbendazol se une a la tubulina. Al impedir el ensamblaje de los microtúbulos, la célula tumoral no puede dividirse y se detiene en la fase G2/M del ciclo celular.\n* **Freno a la captación de glucosa:** Las células cancerosas dependen de un consumo voraz de azúcar (efecto Warburg). En modelos in vitro, el fenbendazol reduce la expresión de transportadores GLUT y de enzimas glucolíticas, cortando parte del suministro de energía.\n* **Respuesta vinculada a p53:** Se ha observado que promueve la apoptosis reactivando vías del gen supresor tumoral p53, con menor toxicidad destructiva en células epiteliales sanas.\n\n## Prudencia y contexto clínico\nA pesar del enorme interés público, el fenbendazol no tiene aprobación para consumo humano en agencias reguladoras. Por esta razón, muchos médicos integrativos prefieren evaluar su análogo humano aprobado, el mebendazol, cuya farmacocinética en personas está documentada. Quienes exploran protocolos complementarios deben hacerlo con analíticas hepáticas regulares y acompañamiento médico.`,
        mechanisms:'Detención ciclo celular G2/M, disrupción microtúbulos, inhibición transportador GLUT glucosa, reactivación p53.',
        clinical_status:'Uso veterinario estándar. Investigación off-label y preclínica en oncología; protocolos complementarios observacionales.',
        pubmed_citations:JSON.stringify(['30154681','12154388']),status:'published'
      },
      {
        id:'wiki-william-makis',slug:'william-makis',category:'Investigadores y Referentes',category_id:catRefsId,
        title:'Dr. William Makis, MD: Trayectoria Médica, Medicina Nuclear y Fármacos Reposicionados',
        subtitle:'Oncólogo y especialista en medicina nuclear (Universidad McGill)',
        evidence_level:'Revisión Clínica / Casos Observacionales',
        excerpt:'El Dr. William Makis es un oncólogo y especialista en medicina nuclear canadiense (Universidad McGill). Es una de las figuras más consultadas sobre el uso de antiparasitarios reposicionados y terapias combinadas en cáncer. Resumimos su trayectoria, postura clínica y publicaciones.',
        body:`## Formación y experiencia médica\nEl Dr. William Makis completó sus estudios de medicina en la Universidad McGill de Montreal y se especializó en Medicina Nuclear, Radiología y Oncología General, certificado por el Royal College of Physicians and Surgeons de Canadá. A lo largo de su carrera clínica ha diagnosticado y tratado a miles de pacientes utilizando tomografías por emisión de positrones (PET) y terapia dirigida de radionúclidos contra tumores neuroendocrinos y metástasis óseas.\n\n## Enfoque sobre medicamentos reposicionados\nEn los últimos años, el Dr. Makis se ha convertido en una voz muy activa en la divulgación médica internacional, compartiendo revisiones de estudios indexados sobre el reposicionamiento de fármacos antiparasitarios (ivermectina, mebendazol y fenbendazol). Su planteamiento sostiene que cuando los tratamientos convencionales de primera y segunda línea se agotan, la literatura científica ofrece compuestos con mecanismos documentados y toxicidad conocida que merecen ser estudiados y evaluados con seriedad clínica.\n\n## Publicaciones y debate científico\nHa publicado más de un centenar de artículos revisados por pares en revistas científicas de radiología, oncología y medicina nuclear. En sus análisis en video y conferencias detalla cómo ciertas moléculas interfieren con el microambiente tumoral, la función de las células madre cancerosas y la angiogénesis, invitando a la comunidad médica a no desestimar la investigación preclínica disponible en PubMed.`,
        mechanisms:'Terapia de radionúclidos dirigida, medicina nuclear, sinergia antiparasitaria, modulación inmunológica.',
        clinical_status:'Médico especialista certificado (Royal College of Physicians and Surgeons of Canada). Divulgador e investigador clínico.',
        pubmed_citations:JSON.stringify(['29054452','31080350','33633575']),status:'published'
      },
      {
        id:'wiki-berberina',slug:'berberina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Berberina: Activación de AMPK, Regulación Glucémica y Metabolismo Tumoral',
        subtitle:'Alcaloide vegetal isoquinolínico con acción moduladora del sensor energético celular análoga a la metformina',
        evidence_level:'Ensayos Clínicos y Preclínica en Oncología',
        excerpt:'La berberina es un compuesto vegetal amargo con un efecto similar a la metformina: enciende la enzima AMPK, disminuye la glucosa en sangre y dificulta que las células tumorales obtengan energía rápida. Revisamos cómo actúa y las dosis habituales del protocolo del Dr. Pete Sulack.',
        body:`## Un alcaloide vegetal con perfil metabólico\nLa berberina se extrae de la raíz y corteza de plantas como el agracejo (*Berberis vulgaris*) o el sello de oro (*Hydrastis canadensis*). Aunque se ha utilizado tradicionalmente en Asia contra problemas digestivos, la investigación metabólica reciente la sitúa como uno de los compuestos naturales más eficaces para regular el azúcar en sangre, actuando por vías muy parecidas a la metformina.\n\n## Qué le hace al metabolismo tumoral\nEl cáncer se alimenta predominantemente de fermentar glucosa. Al introducir berberina en el organismo, se desencadenan varios frenos bioquímicos:\n\n* **Encendido de AMPK:** La proteína quinasa activada por AMP es el termostato energético celular. Cuando la berberina activa AMPK, el cuerpo pasa a modo de ahorro y frena mTOR, el complejo que le da la orden al tumor de crecer y sintetizar proteínas.\n* **Menos glucosa e insulina circulante:** Al mejorar la sensibilidad a la insulina y reducir los picos glucémicos posprandiales, deja al tumor sin su combustible predilecto.\n* **Interferencia en la cadena mitocondrial:** Inhibe parcialmente el complejo I mitocondrial en células cancerosas, lo que genera un estrés energético selectivo en células con metabolismo alterado.\n* **Equilibrio de la flora intestinal:** Favorece bacterias comensales que producen butirato y disminuye la absorción de toxinas inflamatorias (como el lipopolisacárido o LPS).\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis de referencia:** Se suele pautar en 500 mg administrados dos o tres veces al día, siempre acompañando a las comidas para moderar la absorción de carbohidratos.\n* **Sinergias comunes:** Se combina con frecuencia con extracto de té verde (EGCG) o curcumina para atacar varias vías metabólicas al mismo tiempo.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nPara quienes buscan fórmulas purificadas con estándares analíticos de pureza, pueden utilizar el código de descuento de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Berberina en iHerb →](https://www.iherb.com/search?kw=berberine&rcode=wUt7svK8)**\n> *(O ingresa directamente mediante nuestro enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación AMPK, inhibición mTOR, disminución glucemia e insulina, disrupción complejo I mitocondrial, modulación microbiota.',
        clinical_status:'Ampliamente utilizado en fitoterapia clínica y síndrome metabólico. Ensayos clínicos en curso en oncología integrativa.',
        pubmed_citations:JSON.stringify(['34226532','31582977','31908277']),status:'published'
      },
      {
        id:'wiki-curcumina',slug:'curcumina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Cúrcuma y Curcumina: Vía NF-kB, Apagado Inflamatorio y Biodisponibilidad',
        subtitle:'Polifenol de Curcuma longa con propiedades reguladoras del microambiente inflamatorio tumoral',
        evidence_level:'Ensayos Clínicos Fase I/II y Metaanálisis',
        excerpt:'El principio activo de la cúrcuma actúa sobre el interruptor central de la inflamación: el factor NF-kB. En esta monografía repasamos cómo apaga las señales inflamatorias que necesita el tumor para crecer, su sinergia con otros tratamientos y cómo resolver su baja absorción.',
        body:`## La molécula dorada y el problema de la absorción\nLa curcumina es el polifenol más estudiado del rizoma de *Curcuma longa*. Cientos de publicaciones en PubMed avalan su capacidad para modular procesos inflamatorios. Sin embargo, tiene un obstáculo conocido: ingerida en polvo tal cual se absorbe muy poco. Para que cumpla un papel terapéutico requiere formulaciones con fitosomas, nanopartículas o la presencia obligada de lípidos y piperina.\n\n## Su impacto en la biología tumoral\n* **Inhibición de NF-kB:** Este factor de transcripción es el centro de mando que activa la inflamación crónica en el cuerpo. Cuando está encendido continuamente, promueve la multiplicación celular, la angiogénesis y la resistencia a la muerte celular. La curcumina ayuda a desactivarlo, reduciendo mediadores como COX-2, IL-6 y TNF-α.\n* **Freno a nuevos vasos sanguíneos (angiogénesis):** Los tumores necesitan crear su propia red capilar para alimentarse. La curcumina reduce la señalización del factor VEGF, dificultando esa vascularización anómala.\n* **Activación de caspasas:** En líneas celulares malignas, induce la rotura de la membrana mitocondrial y la liberación de enzimas (caspasa-3 y 9) que guían a la célula hacia la apoptosis.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis habitual:** Entre 1.000 y 2.000 mg diarios de extracto estandarizado (95% curcuminoides), repartidos en dos tomas.\n* **Regla indispensable:** Tomarla con grasas saludables (aceite de oliva virgen extra, aguacate o aceite de coco) para asegurar que pase a la circulación sistémica y no se elimine en el tracto digestivo.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nPuedes encontrar fórmulas de alta absorción con descuento usando el código de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Curcumina en iHerb →](https://www.iherb.com/search?kw=curcumin%20turmeric&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición NF-kB, supresión COX-2 y VEGF, activación caspasas 3 y 9, reducción citoquinas proinflamatorias, sinergia antimicrotubular.',
        clinical_status:'Nutracéutico de grado alimentario y farmacéutico. Numerosos ensayos clínicos Fase I y II en oncología integrativa.',
        pubmed_citations:JSON.stringify(['30768910','31464319','28935748']),status:'published'
      },
      {
        id:'wiki-pectina-citrica-modificada',slug:'pectina-citrica-modificada',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Pectina Cítrica Modificada (MCP): Galectina-3 y Bloqueo de la Adhesión Celular',
        subtitle:'Fracción soluble de bajo peso molecular estudiada para reducir la fijación vascular y metástasis',
        evidence_level:'Estudios Clínicos Observacionales y Preclínica',
        excerpt:'La Pectina Cítrica Modificada (MCP) es una forma tratada de la pectina capaz de entrar al flujo sanguíneo. Se une a la Galectina-3, una proteína que las células tumorales usan para adherirse a los vasos y colonizar otros tejidos. Explicamos cómo actúa y su toma en ayunas.',
        body:`## Qué cambia entre la pectina común y la modificada\nLa pectina tradicional de la fruta tiene cadenas moleculares demasiado grandes para ser absorbidas en el intestino humano y se queda en el colon actuando como fibra. En cambio, la Pectina Cítrica Modificada (como la fórmula patentada PectaSol) se somete a un tratamiento enzimático y de pH que reduce su peso molecular por debajo de los 15 kiloDaltons. Gracias a este tamaño reducido, atraviesa la barrera intestinal y pasa directamente a la circulación sanguínea.\n\n## Diana biológica: el bloqueo de la Galectina-3\n* **Freno a la adhesión tumoral:** Las células cancerosas que viajan por el torrente circulatorio sobreexpresan una lectina llamada Galectina-3, que actúa como un "adhesivo" para anclarse a las paredes endoteliales de otros órganos y formar colonias. La MCP se une a los receptores de carbohidratos de la Galectina-3 y los satura, dificultando ese anclaje.\n* **Eliminación del camuflaje inmune:** La Galectina-3 también ayuda al tumor a esconderse de los linfocitos T y las células Natural Killer (NK). Al bloquearla, el sistema inmunitario reconoce mejor las células anormales.\n* **Quelación suave de metales:** Se ha documentado su afinidad por unirse a metales pesados como plomo, mercurio y cadmio para facilitar su eliminación renal, sin arrastrar minerales indispensables como calcio o magnesio.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis de referencia:** Entre 5 y 15 gramos al día, disueltos en agua templada.\n* **Condición indispensable:** Debe tomarse con el estómago vacío (al menos 30 minutos antes de cualquier alimento o 2 horas después), ya que la presencia de comida en el estómago reduce drásticamente su absorción.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nPuedes adquirir Pectina Cítrica Modificada verificada con descuento usando el código de comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Pectina Cítrica Modificada en iHerb →](https://www.iherb.com/search?kw=modified%20citrus%20pectin&rcode=wUt7svK8)**\n> *(O accede con nuestro enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Bloqueo competitivo Galectina-3, inhibición adhesión metastásica, reactivación vigilancia células NK, quelación selectiva metales pesados.',
        clinical_status:'Nutracéutico patentado con ensayos clínicos evaluando duplicación de antígeno prostático específico (PSA) y tiempo libre de progresión.',
        pubmed_citations:JSON.stringify(['31604462','29871788','18641477']),status:'published'
      },
      {
        id:'wiki-hongos-medicinales',slug:'hongos-medicinales',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Hongos Medicinales (Reishi, Melena de León, Cola de Pavo): Inmunidad y Neuroprotección',
        subtitle:'Beta-glucanos 1,3/1,6 y triterpenos para activar células NK y regenerar tejido nervioso',
        evidence_level:'Ensayos Clínicos Aleatorizados y Revisiones Sistemáticas',
        excerpt:'Especies como la Cola de Pavo (Coriolus), el Reishi y la Melena de León contienen beta-glucanos que despiertan la respuesta innata de macrófagos y células NK. Revisamos por qué son parte de la oncología hospitalaria en Asia y cómo tomarlos.',
        body:`## De la tradición oriental a los hospitales oncológicos\nEn países como Japón y China, extractos purificados de hongos como *Trametes versicolor* (Cola de Pavo) llevan cuatro décadas aprobados como medicamentos adyuvantes en hospitales oncológicos (bajo nombres comerciales como PSK o Krestin). Lejos del misticismo, la micología médica moderna ha identificado en estos macromicetos moléculas bioactivas muy concretas: beta-1,3/1,6-D-glucanos y triterpenos.\n\n## Cómo interactúan con nuestras defensas\n* **El receptor Dectina-1:** Cuando los beta-glucanos llegan al intestino, los macrófagos de las placas de Peyer los reconocen a través del receptor Dectina-1. Este contacto activa una alerta en cascada que estimula la respuesta inmune innata.\n* **Células Natural Killer (NK) y linfocitos T:** Múltiples ensayos clínicos demuestran que fracciones fúngicas estandarizadas duplican la capacidad de las células NK para identificar y lisar células enfermas.\n* **Melena de León y el factor de crecimiento nervioso (NGF):** La *Hericium erinaceus* aporta hericenonas y erinacinas que cruzan la barrera hematoencefálica y estimulan la síntesis de factor de crecimiento nervioso (NGF), de gran ayuda para pacientes con neuropatía periférica por quimioterapia o problemas cognitivos ("quimiocerebro").\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis sugerida:** 2 cápsulas al día de extracto concentrado de cuerpo fructífero con alimentos.\n* **Detalle de calidad clave:** Asegurarse de que el producto especifique el porcentaje de beta-glucanos y proceda del cuerpo fructífero del hongo, evitando polvos de micelio cultivado sobre cereal que son mayoritariamente almidón.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nFórmulas de hongos medicinales orgánicos con descuento con nuestro código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones de Hongos Medicinales (Reishi, Melena de León, Cola de Pavo) en iHerb →](https://www.iherb.com/search?kw=mushroom%20reishi%20lions%20mane%20turkey%20tail&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación receptores dectina-1, estimulación células Natural Killer y linfocitos T citotóxicos, secreción de NGF cerebral, modulación microbioma.',
        clinical_status:'Extractos PSK y PSP aprobados como coadyuvantes oncológicos oficiales en hospitales de Japón y China desde la década de 1980.',
        pubmed_citations:JSON.stringify(['33574805','30806254','28574925']),status:'published'
      },
      {
        id:'wiki-te-verde-egcg',slug:'te-verde-egcg',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Extracto de Té Verde (EGCG): Angiogénesis, Glutamina y Regulación Celular',
        subtitle:'Polifenol de Camellia sinensis con capacidad para interferir en los vasos nutricios y el metabolismo tumoral',
        evidence_level:'Ensayos Clínicos y Evidencia Mecanicista',
        excerpt:'El galato de epigalocatequina (EGCG) es el polifenol más potente del té verde. En laboratorio ha demostrado frenar los receptores de VEGF (angiogénesis) e interferir con la enzima glutaminasa. Analizamos su mecanismo y recomendaciones de toma.',
        body:`## Qué hace único al EGCG del té verde\nLas hojas de té verde (*Camellia sinensis*) contienen catequinas con propiedades antioxidantes notables, pero entre todas destaca el galato de epigalocatequina (EGCG). A diferencia de una infusión tradicional (que aporta dosis modestas), los protocolos integrativos emplean extractos estandarizados de alta concentración para alcanzar niveles tisulares activos.\n\n## Mecanismos en la biología tumoral\n* **Bloqueo de VEGF y nuevos vasos sanguíneos:** Para que un tumor supere unos milímetros de diámetro, necesita inducir nuevos capilares. El EGCG interfiere con la activación de los receptores VEGFR-1 y VEGFR-2, dificultando la formación de esa red vascular tumoral.\n* **Vía de la glutamina:** Muchas células tumorales recurren a la glutamina como fuente de nitrógeno y energía cuando se les corta la glucosa. El EGCG inhibe parcialmente la glutaminasa, cerrando una de las vías de escape metabólico más habituales.\n* **Modulación epigenética:** Ayuda a inhibir enzimas de metilación del ADN (DNMT), lo que en modelos in vitro permite volver a expresar ciertos genes supresores de tumores que la célula cancerosa había apagado.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis habitual:** 1 o 2 cápsulas diarias de extracto descafeinado rico en EGCG con las comidas.\n* **Precaución digestiva y hepática:** Tomarlo siempre con alimentos; dosis excesivas de extracto de té verde en ayunas pueden causar molestias gástricas o sobrecargar el hígado.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nExtractos de té verde descafeinados estandarizados en EGCG con el código de comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de EGCG y Té Verde en iHerb →](https://www.iherb.com/search?kw=egcg%20green%20tea&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición tirosina quinasa VEGFR, modulación DNMT epigenética, interferencia glutaminólisis tumoral, neutralización radicales hidroxilo.',
        clinical_status:'Suplemento dietético estandarizado. Investigado en ensayos clínicos Fase II para prevención de recurrencias en tumores sólidos.',
        pubmed_citations:JSON.stringify(['33435478','31096590','29452285']),status:'published'
      },
      {
        id:'wiki-aceite-semilla-negra',slug:'aceite-semilla-negra-timoquinona',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Aceite de Semilla Negra (Nigella Sativa): Timoquinona, Apoptosis y Protección Hepática',
        subtitle:'Aceite prensado en frío con propiedades antiinflamatorias y antioxidantes verificadas',
        evidence_level:'Preclínica Avanzada y Estudios Clínicos Observacionales',
        excerpt:'El comino negro (Nigella sativa) contiene timoquinona, una molécula que en modelos de laboratorio eleva la relación Bax/Bcl-2 en células tumorales y protege el tejido hepático y renal frente a toxicidad farmacológica. Resumimos la evidencia.',
        body:`## Una semilla con historia milenaria y respaldo fitoquímico\nEl aceite virgen de *Nigella sativa* (comino negro) es uno de los remedios botánicos tradicionales más antiguos de Oriente Medio y el Mediterráneo. Su valor biomédico moderno reside en su contenido de **timoquinona**, un compuesto volátil que ha demostrado una actividad antiproliferativa y antiinflamatoria constante en pruebas de laboratorio.\n\n## Acciones biológicas observadas\n* **Equilibrio entre muerte y supervivencia celular (Bax/Bcl-2):** La timoquinona inclina la balanza interna de la célula tumoral: eleva las proteínas pro-muerte (Bax) y reduce las proteínas protectoras (Bcl-2), provocando la liberación de citocromo C y activando caspasas destructoras.\n* **Defensa celular y autofagia:** Modula procesos de autofagia citotóxica en células tumorales que se han vuelto resistentes a tratamientos habituales.\n* **Protección hepática y renal:** Uno de sus mayores beneficios clínicos en pacientes es su capacidad para amortiguar la toxicidad en el hígado y los riñones durante pautas farmacológicas complejas, reduciendo la elevación de transaminasas.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis sugerida:** 1 cápsula de aceite puro prensado en frío una o dos veces al día con alimentos (o una cucharadita de aceite virgen líquido).\n* **Control de calidad:** Debe ser aceite virgen de primera presión en frío, 100% puro y libre de solventes químicos de extracción.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nAceite de comino negro prensado en frío estandarizado en timoquinona con descuento usando: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Aceite de Semilla Negra en iHerb →](https://www.iherb.com/search?kw=black%20seed%20oil%20nigella%20sativa&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Aumento ratio Bax/Bcl-2, activación caspasas 3 y 9, modulación autofagia tumoral, inhibición NF-kB, citoprotección hepatorrenal.',
        clinical_status:'Complemento nutricional de uso tradicional extendido con creciente documentación en ensayos clínicos sobre marcadores inflamatorios.',
        pubmed_citations:JSON.stringify(['30138241','33668832','31163624']),status:'published'
      },
      {
        id:'wiki-melatonina',slug:'melatonina-oncologia',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Melatonina en Oncología: Ritmo Circadiano, Mitocondrias y Dosis Clínicas',
        subtitle:'Indolamina antioxidante nocturna como regulador mitocondrial y apoyo en tratamientos oncológicos',
        evidence_level:'Múltiples Ensayos Clínicos Aleatorizados y Metaanálisis',
        excerpt:'Lejos de ser solo una pastilla para dormir, la melatonina es sintetizada en las mitocondrias de casi todas nuestras células. En dosis clínicas (5 a 20 mg) desacopla la glucólisis tumoral, modula la aromatasa y mejora la respuesta inmunitaria nocturna.',
        body:`## Más allá del sueño: la melatonina como protector mitocondrial\nCasi todo el mundo asocia la melatonina con la glándula pineal y el sueño. Sin embargo, la mayor parte de la melatonina corporal es producida localmente por las mitocondrias de nuestros propios tejidos. En el ámbito oncológico integrativo se considera uno de los antioxidantes y reguladores celulares más versátiles y seguros que existen.\n\n## Por qué interesa en el terreno tumoral\n* **Entrada directa a la mitocondria:** Gracias a los transportadores PEPT1 y PEPT2, la melatonina entra en la matriz mitocondrial protegiendo el ADN sano del estrés oxidativo severo.\n* **Freno a la glucólisis aeróbica:** Ayuda a revertir el efecto Warburg forzando a las células cancerosas a depender de la fosforilación oxidativa normal, lo que a menudo desata crisis metabólica en tumores con mitocondrias dañadas.\n* **Modulación hormonal:** En tumores sensibles a hormonas (como mama o próstata), la melatonina frena la actividad de la enzima aromatasa, reduciendo la producción local de estrógenos.\n* **Inmunovigilancia nocturna:** Durante las fases de sueño profundo apoya la actividad de los linfocitos T y las células NK encargadas de revisar y limpiar células mutadas.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis oncológica frente a dosis de insomnio:** Mientras que para dormir se usan 0.5 a 3 mg, los protocolos oncológicos suelen pautar entre 5 y 20 mg por la noche, entre 30 y 60 minutos antes de acostarse.\n* **Condición de eficacia:** Dormir en una habitación completamente a oscuras para evitar que la luz ambiental suprima los receptores de melatonina.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nMelatonina pura en dosis clínicas con descuento con nuestro código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Melatonina en iHerb →](https://www.iherb.com/search?kw=melatonin&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Captación mitocondrial PEPT1/2, reversión efecto Warburg, inhibición aromatasa, estimulación linfocitos T y células NK, captación radicales hidroxilo.',
        clinical_status:'Metaanálisis de más de 20 ensayos clínicos aleatorizados respaldan su uso como adyuvante oncológico con mejoras en supervivencia y calidad de vida.',
        pubmed_citations:JSON.stringify(['32070007','30248888','29235948']),status:'published'
      },
      {
        id:'wiki-cardo-mariano',slug:'cardo-mariano-silimarina',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Cardo Mariano (Silimarina): Protección Hepática, Glutatión y Transaminasas',
        subtitle:'Flavonolignanos de Silybum marianum para sostener el hígado durante terapias farmacológicas',
        evidence_level:'Ensayos Clínicos y Revisiones Sistemáticas Cochrane',
        excerpt:'La silimarina del cardo mariano estimula la síntesis de proteínas en las células hepáticas y preserva las reservas de glutatión. En protocolos integrativos es el protector de cabecera cuando se combinan tratamientos que exigen esfuerzo al hígado.',
        body:`## Qué es la silimarina y por qué el hígado la necesita\nEl cardo mariano (*Silybum marianum*) es una de las plantas medicinales con mayor respaldo clínico formal de Europa (monografiada por la Comisión E alemana). Sus semillas concentran **silimarina**, una mezcla de flavonolignanos donde destaca la silibinina. Su función no es "limpiar" de forma mágica, sino apoyar bioquímicamente a los hepatocitos dañados por sobrecargas farmacológicas.\n\n## Mecanismos de acción en el hepatocito\n* **Estimulación de la ARN polimerasa I:** Activa la síntesis ribosomal en las células del hígado, acelerando su capacidad de regeneración celular tras sufrir agresiones químicas.\n* **Preservación de glutatión endógeno:** El glutatión es el antioxidante maestro del hígado. La silimarina evita que se agote ante la presencia de metabolitos tóxicos y fármacos de síntesis.\n* **Estabilización de membranas:** Dificulta que ciertas toxinas penetren al interior de las células hepáticas al interactuar con los lípidos de su membrana exterior.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis recomendada:** 1 a 2 cápsulas al día de extracto estandarizado (al menos 80% silimarina) con las comidas.\n* **Uso combinado:** Es un apoyo muy valioso cuando se toman medicamentos reposicionados (como ivermectina, mebendazol o fenbendazol) para mantener las enzimas hepáticas (GOT, GPT, GGT) en rangos saludables.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nExtracto de cardo mariano estandarizado en silimarina con descuento usando el código de comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Cardo Mariano (Milk Thistle) en iHerb →](https://www.iherb.com/search?kw=milk%20thistle%20silymarin&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Activación ARN polimerasa I, preservación glutatión hepático, estabilización de membrana celular contra xenobióticos, acción antioxidante directa.',
        clinical_status:'Monografía oficial de la Comisión E alemana y fitofármaco ampliamente prescrito en Europa para hepatoprotección.',
        pubmed_citations:JSON.stringify(['30568019','31238470','29534435']),status:'published'
      },
      {
        id:'wiki-omega-3',slug:'omega-3-epa-dha',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Ácidos Grasos Omega-3 (EPA / DHA): Desinflamación, Masa Muscular y Caquexia',
        subtitle:'Lípidos esenciales y precursores de mediadores pro-resolutivos (SPMs) en el paciente oncológico',
        evidence_level:'Guías Clínicas ESPEN y Ensayos Clínicos Aleatorizados',
        excerpt:'El EPA y el DHA de los aceites de pescado compiten con el ácido araquidónico e inducen resolvinas que apagan la inflamación. Además, las guías europeas ESPEN los recomiendan para frenar la pérdida de masa muscular y la caquexia oncológica.',
        body:`## Grasas esenciales frente a la inflamación sistémica\nEn el organismo existe una competencia permanente entre dos familias de grasas: los omega-6 (predominantes en dietas ultraprocesadas y aceites vegetales refinados, generadores de inflamación) y los omega-3 de cadena larga (ácido eicosapentaenoico o **EPA** y ácido docosahexaenoico o **DHA**). En el paciente oncológico, equilibrar esta balanza es crucial para enfriar el microambiente inflamatorio.\n\n## Qué aportan al terreno celular\n* **Mediadores pro-resolutivos especializados (SPMs):** A partir del EPA y DHA, el cuerpo sintetiza resolvinas, protectinas y maresinas. Estas moléculas no apagan las defensas a la fuerza como un fármaco corticoide; le dan al organismo la señal de resolver y retirar la inflamación una vez cumplida su misión.\n* **Integración en la membrana tumoral:** Al incorporarse a la bicapa lipídica de las células malignas, alteran la estabilidad de las balsas lipídicas (lipid rafts) donde se ubican receptores de crecimiento celular, volviendo al tumor más sensible a la apoptosis.\n* **Protección contra la caquexia (pérdida muscular):** La Sociedad Europea de Nutrición Clínica (ESPEN) avala el aporte de omega-3 en pacientes oncológicos porque frenan la degradación proteica muscular (vía ubiquitina-proteasoma) desatada por citoquinas tumorales.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis habitual:** Alrededor de 2.000 mg diarios combinados de EPA y DHA en forma de triglicéridos naturales purificados.\n* **Criterio de pureza obligatorio:** Exigir siempre aceites con certificación independiente IFOS (International Fish Oil Standards) de 5 estrellas, que garantiza ausencia de mercurio, PCBs y bajo índice de oxidación (Totox).\n\n## 🌿 Opciones de grado terapéutico en iHerb\nAceites de pescado Omega-3 purificados con certificación IFOS y descuento con el código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Omega-3 EPA/DHA en iHerb →](https://www.iherb.com/search?kw=omega%203%20epa%20dha&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Síntesis de resolvinas y protectinas SPMs, alteración de balsas lipídicas de membrana, supresión vía ubiquitina-proteasoma muscular, reducción PGE2.',
        clinical_status:'Incluido en las Guías Europeas de Nutrición Clínica en Oncología (ESPEN) para pacientes con pérdida de peso o inflamación sistémica.',
        pubmed_citations:JSON.stringify(['30415309','32575416','31872166']),status:'published'
      },
      {
        id:'wiki-ashwagandha',slug:'ashwagandha-withania',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Ashwagandha (Withania somnifera): Cortisol, Eje de Estrés y Withaferina A',
        subtitle:'Adaptógeno ayurvédico estandarizado para modular el impacto del estrés crónico sobre las defensas',
        evidence_level:'Ensayos Clínicos en Estrés/Fatiga y Preclínica Oncológica',
        excerpt:'El diagnóstico de cáncer dispara el cortisol y deprime las defensas. La Ashwagandha ayuda a regular el eje hipotálamo-hipófisis-adrenal, mejora el descanso y aporta withaferina A, una lactona con acción antiproliferativa en modelos de laboratorio.',
        body:`## El impacto del estrés en el terreno biológico\nEl choque emocional y la incertidumbre que acompañan a un proceso oncológico mantienen al sistema nervioso en alerta continua. Ese estrés sostenido dispara el cortisol y la noradrenalina, hormonas que adormecen a las células Natural Killer y aumentan la permeabilidad de los vasos. La *Withania somnifera* (Ashwagandha) es la raíz adaptógena por excelencia para ayudar al cuerpo a recuperar el equilibrio.\n\n## Mecanismos observados\n* **Regulación del eje hipotálamo-hipófisis-adrenal (HPA):** Ensayos clínicos en humanos demuestran reducciones objetivas en los niveles de cortisol matutino y mejoras notables en la calidad del sueño y la percepción de fatiga.\n* **La withaferina A:** Esta lactona esteroidal presente en la raíz interactúa con chaperonas moleculares como la proteína Hsp90 e induce estrés proteico selectivo en líneas celulares tumorales, favoreciendo su muerte programada.\n* **Apoyo contra la fatiga ("fatiga relacionada con el cáncer"):** Ayuda a recuperar energía física sin el efecto estimulante o ansiogénico de la cafeína.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis clínica de referencia:** 600 mg al día de extracto estandarizado de raíz completa (como KSM-66 o Sensoril).\n* **Momento de toma:** Puede tomarse por la mañana para sostener la energía adaptativa durante el día, o por la noche si el objetivo prioritario es calmar la mente y conciliar un sueño profundo.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nExtracto de Ashwagandha KSM-66 certificado con descuento usando nuestro código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Ashwagandha en iHerb →](https://www.iherb.com/search?kw=ashwagandha%20ksm-66&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Atenuación eje HPA, reducción cortisol sérico, inhibición chaperona Hsp90 por withaferina A, modulación receptores GABAérgicos cerebrales.',
        clinical_status:'Múltiples ensayos clínicos aleatorizados doble ciego controlados con placebo en reducción de cortisol, estrés y fatiga.',
        pubmed_citations:JSON.stringify(['31517876','32021735','30466985']),status:'published'
      },
      {
        id:'wiki-graviola',slug:'graviola-guanabana',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Graviola / Guanábana (Annona muricata): Acetogeninas y Cadena Mitocondrial',
        subtitle:'Compuestos vegetales de la hoja de guanábana que frenan la producción de ATP en células hipermetabólicas',
        evidence_level:'Preclínica In vitro / In vivo y Estudios Etnobotánicos',
        excerpt:'Las hojas de guanábana contienen acetogeninas annonáceas que inhiben el complejo I mitocondrial, reduciendo la energía en células con alta demanda metabólica. Analizamos su acción in vitro y las precauciones indispensables sobre su duración.',
        body:`## Qué son las acetogeninas de la hoja de guanábana\nLa *Annona muricata* (guanábana o graviola) es un árbol frutal tropical popularmente conocido por sus frutos comestibles. Sin embargo, en investigación fitoquímica el verdadero foco de interés está en sus hojas y corteza, de donde se extraen las **acetogeninas annonáceas** (como la annonacina y la bullatacina), moléculas lipídicas con una acción citotóxica muy potente en modelos de laboratorio.\n\n## Cómo actúan en el cultivo celular\n* **Bloqueo del complejo I mitocondrial:** Las acetogeninas interfieren con la enzima NADH:ubiquinona oxidorreductasa en la membrana mitocondrial interna, frenando la cadena respiratoria y cortando la síntesis de ATP.\n* **Sensibilidad de las células hipermetabólicas:** Dado que las células tumorales tienen una demanda energética altísima para multiplicarse, una caída brusca de ATP las deja sin recursos para dividirse.\n* **Inhibición de bombas de expulsión de fármacos:** Al depender estas bombas del ATP para expulsar la quimioterapia, la falta de energía dificulta esa resistencia.\n\n## Advertencia toxicológica y pautas de seguridad\nA diferencia de otros suplementos botánicos inocuos a largo plazo, la graviola requiere cautela:\n* **Nunca usar de forma continua indefinida:** Dosis muy altas o prolongadas de annonacina se han asociado a neurotoxicidad en modelos animales. Por ello, protocolos como el del Dr. Pete Sulack la limitan a ciclos de 30 a 60 días seguidos de periodos de descanso obligatorio.\n* **Supervisión profesional:** No debe combinarse sin control con fármacos dopaminérgicos ni usarse en mujeres embarazadas.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nExtractos estandarizados de Graviola con descuento con nuestro código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Graviola en iHerb →](https://www.iherb.com/search?kw=graviola%20soursop&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Inhibición NADH:ubiquinona oxidorreductasa (complejo I), depleción crítica de ATP tumoral, modulación bombas de resistencia MDR.',
        clinical_status:'Uso en medicina tradicional y suplementación herbal. Mayoritariamente preclínica; requiere uso ciclado y supervisión médica.',
        pubmed_citations:JSON.stringify(['30323380','29139589','28677610']),status:'published'
      },
      {
        id:'wiki-artemisinina',slug:'artemisinina-artemisia-annua',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Artemisinina (Artemisia annua): Reacción con Hierro Tumoral y Estrés Oxidativo',
        subtitle:'Lactona sesquiterpénica que reacciona con la ferritina intracelular generando lisis selectiva',
        evidence_level:'Ensayos Clínicos Piloto y Preclínica Rigurosa',
        excerpt:'La artemisinina (premio Nobel de Tu Youyou) contiene un puente endoperóxido que reacciona con el hierro libre acumulado dentro de las células cancerosas, liberando radicales libres que destruyen al tumor por dentro. Explicamos por qué debe ciclarse (5 días sí, 2 no).',
        body:`## El hallazgo del Nobel y su salto a la oncología\nEl descubrimiento de la artemisinina a partir de la planta china *Artemisia annua* (ajenjo dulce) por la científica Tu Youyou revolucionó la medicina mundial contra la malaria, valiéndole el Premio Nobel en 2015. En los últimos veinte años, biofísicos y oncólogos descubrieron que el mismo mecanismo que mata al parásito puede aprovecharse contra células cancerosas.\n\n## La reacción con el hierro tumoral\n* **El tumor acumula hierro:** Para sostener su rápida división, las células malignas absorben grandes cantidades de hierro ferroso (Fe2+) y sobreexpresan receptores de transferrina.\n* **Ruptura del puente endoperóxido:** La molécula de artemisinina contiene un enlace químico singular: un puente endoperóxido. Cuando este puente entra en contacto con el hierro libre dentro de la célula tumoral, se rompe y genera una ráfaga inmediata de radicales libres basados en carbono (ROS focalizados) que rompen las membranas celulares y el ADN del tumor.\n* **Inhibición de HIF-1α:** Reduce la señalización de factores que promueven nuevos vasos sanguíneos (angiogénesis).\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis habitual:** 200 a 500 mg diarios tomados con algo de alimento.\n* **Estrategia de ciclado obligatoria:** Se toma durante 5 días seguidos y se descansan 2 días completos cada semana (esquema 5/2). Esto evita que el hígado acelere enzimas de degradación que volverían ineficaz al compuesto tras varias semanas continuas.\n* **Sinergia:** Frecuentemente se combina con berberina para atacar en paralelo el suministro de glucosa.\n\n## 🌿 Opciones de grado terapéutico en iHerb\nArtemisinina pura estandarizada con descuento usando nuestro código: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Artemisinina en iHerb →](https://www.iherb.com/search?kw=artemisinin&rcode=wUt7svK8)**\n> *(Enlace de comunidad: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Ruptura puente endoperóxido por Fe2+, generación ROS de carbono intracelular, inhibición HIF-1α y VEGF, detención ciclo celular.',
        clinical_status:'Fármaco antiparasitario aprobado por la OMS/FDA. Ensayos clínicos piloto en oncología integrativa en cáncer colorrectal, mama y glioblastoma.',
        pubmed_citations:JSON.stringify(['31668482','29432098','29712711']),status:'published'
      },
      {
        id:'wiki-fotobiomodulacion',slug:'fotobiomodulacion-luz-roja',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Fotobiomodulación (Luz Roja e Infrarroja): Mitocondrias, ATP y Reparación',
        subtitle:'Longitudes de onda de 660 nm y 850 nm para estimular la citocromo c oxidasa y desinflamar',
        evidence_level:'Ensayos Clínicos y Revisiones en Photomedicine and Laser Surgery',
        excerpt:'La luz roja (660 nm) y el infrarrojo cercano (850 nm) penetran en el tejido y estimulan la enzima mitocondrial citocromo c oxidasa, aumentando la energía celular (ATP) y reduciendo la inflamación profunda. Analizamos su base biofísica y tiempos de sesión.',
        body:`## Cómo la luz se convierte en energía celular\nPasa desapercibido que la luz influye en el metabolismo interno, pero la biofísica lo explica con claridad. Ciertas longitudes de onda lumínicas —especialmente en torno a 660 nanómetros (rojo visible) y 850 nanómetros (infrarrojo cercano)— atraviesan la piel y llegan a músculos, articulaciones y tejidos profundos donde las células absorben los fotones.\n\n## Qué sucede en la mitocondria\n* **La citocromo c oxidasa:** Esta enzima de la cadena de transporte de electrones contiene centros de cobre y hierro que actúan como fotorreceptores. Al recibir la longitud de onda adecuada, se acelera el paso de electrones y la síntesis de ATP (energía celular).\n* **Liberación de óxido nítrico:** En situaciones de inflamación o estrés, el óxido nítrico bloquea la respiración celular uniéndose a la mitocondria. La luz roja ayuda a despejar ese bloqueo, permitiendo que el oxígeno vuelva a procesarse correctamente.\n* **Reparación y menos inflamación:** Genera un pulso controlado de señalización que promueve la regeneración tisular y calma la respuesta inflamatoria sistémica.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Sesiones:** Entre 10 y 20 minutos por zona, manteniendo una distancia de unos 15 a 30 centímetros del panel.\n* **Zonas clave:** Área torácica, abdomen, zonas de drenaje linfático o sobre cicatrices quirúrgicas para acelerar la recuperación de los tejidos.\n\n## 🛒 Paneles recomendados en Amazon\nPuedes explorar paneles de luz roja e infrarroja con parámetros verificados en Amazon:\n\n> 🛒 **[Ver Paneles de Luz Roja e Infrarroja Médica en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Estimulación complejo IV (citocromo c oxidasa), disociación de NO inhibitorio, incremento síntesis ATP, reducción estrés oxidativo mitocondrial.',
        clinical_status:'Aprobado por la FDA para alivio del dolor musculoesquelético y regeneración tisular. Guías MASCC/ISOO recomiendan PBM para prevención de mucositis en pacientes oncológicos.',
        pubmed_citations:JSON.stringify(['32832811','30589886','31904573']),status:'published'
      },
      {
        id:'wiki-pemf-bemer',slug:'pemf-campos-magneticos-pulsados-bemer',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia PEMF y BEMER: Potencial de Membrana y Microcirculación Capilar',
        subtitle:'Campos electromagnéticos pulsados de baja frecuencia para restaurar el voltaje celular y la vasomoción',
        evidence_level:'Ensayos Clínicos en Bioelectromagnetismo (Bioelectromagnetics 2022)',
        excerpt:'Las células sanas mantienen un voltaje de -70 mV, mientras que los tejidos inflamados o tumorales caen a -15 mV. La tecnología PEMF y BEMER utiliza pulsos magnéticos para estimular las bombas iónicas celulares y mejorar el flujo en los capilares más finos.',
        body:`## Las células como baterías biológicas\nToda célula viva mantiene una diferencia de potencial eléctrico a través de su membrana. Una célula sana y oxigenada opera habitualmente entre -70 mV y -90 mV. Cuando un tejido sufre inflamación crónica o transformación tumoral, ese voltaje cae a cifras de -15 mV o -30 mV, lo que dificulta el intercambio de electrolitos, la absorción de nutrientes y la salida de residuos metabólicos.\n\n## Cómo actúan los pulsos magnéticos\n* **Reactivación de bombas de membrana:** Las ondas de baja frecuencia (PEMF) inducen microcorrientes suaves en el espacio extracelular, favoreciendo el funcionamiento de las bombas de sodio-potasio ATPasa y ayudando a recuperar el potencial eléctrico de la célula.\n* **Estimulación de la vasomoción (tecnología BEMER):** Las microarteriolas poseen una contracción muscular rítmica llamada vasomoción. En tejidos enfermos ese movimiento suele estar estancado. La señal electromagnética patentada de BEMER ayuda a estimular rítmicamente ese bombeo capilar.\n* **Menor apilamiento de glóbulos rojos:** Ayuda a dispersar los eritrocitos agrupados en columnas (efecto "rouleaux"), facilitando que pasen uno a uno por los capilares más estrechos para entregar oxígeno.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Esterilla PEMF corporal:** 30 minutos al día sobre esterilla de cuerpo completo o mediante aplicadores locales sobre articulaciones o zonas doloridas.\n* **Esquema BEMER:** Sesiones de 8 a 16 minutos por la mañana y por la tarde para acompañar el ritmo circadiano de la microcirculación.\n\n## 🛒 Dispositivos en Amazon\nExplora esterillas PEMF y dispositivos de modulación bioeléctrica en Amazon:\n\n> 🛒 **[Ver Dispositivos y Esterillas PEMF en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Repolarización del potencial transmembrana (-70 mV), estimulación vasomotriz precapilar, incremento de fosforilación oxidativa, desagregación de eritrocitos.',
        clinical_status:'Dispositivos médicos clase II aprobados por la FDA para seudoartrosis, dolor osteoarticular y edema. Ensayos clínicos en marcha en medicina integrativa.',
        pubmed_citations:JSON.stringify(['35384180','33887985','34900898']),status:'published'
      },
      {
        id:'wiki-oxigenoterapia-hiperbarica',slug:'oxigenoterapia-hiperbarica-hbot',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Oxigenoterapia Hiperbárica (HBOT): Reversión de la Hipoxia Tumoral y Sinergia',
        subtitle:'Oxígeno puro a 1.5 - 2.0 ATA para disolver O2 en el plasma sanguíneo y romper el ambiente anaeróbico',
        evidence_level:'Ensayos Clínicos y Biología Tumoral (Cancer Cell 2016)',
        excerpt:'El oxígeno puro bajo presión (1.5 a 2.0 ATA) disuelve O2 directamente en el plasma y líquidos corporales, alcanzando las zonas tumorales con hipoxia profunda. Al revertir la falta de oxígeno, frena el factor HIF-1α y potencia la vulnerabilidad del tumor.',
        body:`## La física del oxígeno bajo presión\nEn condiciones normales, prácticamente todo el oxígeno que viaja por nuestro cuerpo va unido a los glóbulos rojos (hemoglobina). En una cámara hiperbárica, al respirar oxígeno al 100% bajo una presión atmosférica superior a la habitual (de 1.5 a 2.0 ATA), la ley de Henry hace que el gas se disuelva físicamente en el plasma, la linfa y el líquido cefalorraquídeo. Esto permite que el oxígeno llegue a zonas donde los vasos sanguíneos están colapsados o dañados.\n\n## Por qué la hipoxia favorece al tumor\nLos tumores agresivos suelen crecer más rápido que los vasos que los irrigan, creando zonas internas sin oxígeno (hipoxia). Para sobrevivir a ese ambiente asfixiante, el tumor activa un interruptor genético llamado HIF-1α (factor inducible por hipoxia), que ordena crear nuevos vasos débiles y desata mecanismos de escape e invasión.\n\nAl inundar el tejido de oxígeno con la cámara hiperbárica:\n* **Se desactiva HIF-1α:** El tumor pierde esa señal de supervivencia.\n* **Estrés oxidativo selectivo:** Las células tumorales tienen menos enzimas antioxidantes (como catalasa) que las células sanas. El torrente de oxígeno les genera un estrés metabólico que no pueden neutralizar bien.\n* **La pinza metabólica:** Combinar HBOT con una dieta cetogénica es una de las estrategias que más interés despierta en oncología metabólica: mientras la dieta le quita glucosa, el oxígeno rompe su microambiente anaeróbico.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Duración habitual:** Sesiones de 60 a 90 minutos, de 3 a 5 veces por semana en centros especializados.\n* **Hidratación previa:** Buena ingesta de agua filtrada y minerales antes de ingresar a la cámara.\n\n## 🛒 Cámaras y accesorios en Amazon\nExplora accesorios de oxigenación y soporte hiperbárico en Amazon:\n\n> 🛒 **[Ver Opciones de Cámaras Hiperbáricas y Accesorios en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Saturación de oxígeno plasmático disuelto, supresión transcripcional HIF-1α, generación selectiva de ROS en microambientes anaeróbicos, proliferación de células madre CD34+.',
        clinical_status:'Tratamiento médico aprobado internacionalmente por la UHMS y FDA para radionecrosis de tejidos blandos y lesiones refractarias. Extensamente investigado en oncología metabólica.',
        pubmed_citations:JSON.stringify(['27743477','31804968','33177658']),status:'published'
      },
      {
        id:'wiki-sauna-infrarrojo',slug:'sauna-infrarrojo-lejano-detox',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Sauna Infrarrojo Lejano: Hipertermia Suave y Excreción Transdérmica de Toxinas',
        subtitle:'Termoterapia a 50-60°C para movilizar toxinas lipofílicas en el sudor sin sobrecarga cardiovascular',
        evidence_level:'Estudios Clínicos en Toxicología (Integrative Cancer Therapies 2019)',
        excerpt:'El sauna de infrarrojo lejano calienta directamente los tejidos corporales a 50-60°C, promoviendo una sudoración profunda que ayuda a excretar metales pesados y toxinas ambientales con mucho menor estrés cardiovascular que un sauna convencional.',
        body:`## Calor directo frente al aire caliente tradicional\nEn un sauna finlandés el aire se calienta a 80 o 90 grados, lo que para muchos pacientes resulta sofocante y agotador para el corazón. Los saunas de infrarrojo lejano funcionan distinto: emiten una radiación térmica que penetra unos centímetros dentro del cuerpo, calentando los tejidos de forma suave a temperaturas mucho más cómodas (entre 48 y 60°C).\n\n## Por qué ayuda a la desintoxicación\n* **Excreción de toxinas en el sudor:** Diversos estudios toxicológicos han comprobado que el sudor provocado por infrarrojo lejano contiene concentraciones cuantificables de pesticidas, bisfenol A y metales como plomo, mercurio y cadmio que el hígado y los riñones a menudo tienen dificultad para eliminar por sí solos.\n* **Proteínas de choque térmico (HSPs):** El estrés térmico moderado induce la expresión de HSP70 en células sanas, lo que ayuda a reparar proteínas y despierta la atención del sistema inmune.\n* **Mejora del flujo sanguíneo y relajación:** Dilata los vasos sanguíneos periféricos y promueve un alivio muscular notable que reduce el tono simpático de alarma.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Frecuencia:** De 3 a 5 sesiones semanales de unos 30 a 45 minutos.\n* **Regla de seguridad fundamental:** Usar equipos con certificación de muy baja emisión de campos electromagnéticos (Ultra Low EMF) y beber abundante agua mineralizada al terminar para reponer sales perdidas.\n\n## 🛒 Mantas y saunas infrarrojos en Amazon\nExplora mantas térmicas de infrarrojo lejano de bajo CEM en Amazon:\n\n> 🛒 **[Ver Saunas y Mantas Infrarrojas de Bajo CEM en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Diaforesis transdérmica selectiva de toxinas lipófilas, estimulación de chaperonas moleculares Hsp70, vasodilatación periférica por óxido nítrico, reducción de tono simpático.',
        clinical_status:'Ampliamente prescrito en clínicas de medicina funcional e integrativa europea y estadounidense para desintoxicación ambiental y apoyo oncológico.',
        pubmed_citations:JSON.stringify(['31113271','22505876','29737482']),status:'published'
      },
      {
        id:'wiki-sauna-ozono-hocatt',slug:'sauna-ozono-tecnologia-hocatt',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Sauna de Ozono y Cámara HOCATT: Ozonoterapia Transdérmica y Ácido Carbónico',
        subtitle:'Combinación de ozono médico (O3), CO2 transdérmico e hipertermia para generar estrés oxidativo focal',
        evidence_level:'Ensayos Clínicos y Revisiones en Medical Gas Research & Annals of Oncology',
        excerpt:'La tecnología HOCATT combina vapor caliente, ácido carbónico para dilatar capilares y ozono medicinal transdérmico. Los productos lipoperoxidados resultantes estimulan el factor antioxidante Nrf2 en células sanas mientras atacan a las tumorales carentes de catalasa.',
        body:`## Cómo opera una cámara de ozono transdérmico\nLa tecnología HOCATT (*Hyperthermic Ozone Carbonic Acid Transdermal Technology*) ubica al paciente sentado dentro de una cápsula hermética de cuello para abajo, manteniendo la cabeza fuera para respirar aire limpio o concentrado en oxígeno mientras el cuerpo recibe la terapia.\n\n## Los pasos de la sesión\n* **Ácido carbónico inicial:** En los primeros minutos, el dióxido de carbono reacciona con el vapor formando ácido carbónico que dilata los poros y los vasos cutáneos, activando el **efecto Bohr** (la hemoglobina cede más oxígeno a los tejidos circundantes).\n* **Entrada del ozono medicinal:** Al ingresar el O3, interactúa con los lípidos del sudor generando ozónidos y peróxidos lipídicos (LOPs) que se absorben por vía transdérmica hacia el sistema linfático y circulatorio.\n* **Vulnerabilidad de las células tumorales:** Al igual que con la vitamina C intravenosa, las células cancerosas carecen de catalasa suficiente para degradar los peróxidos, sufriendo lisis selectiva, mientras que los tejidos normales activan el eje Nrf2 elevando su propia producción de glutatión y SOD.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Frecuencia clínica:** Habitualmente de 2 a 4 sesiones semanales según tolerancia.\n* **Soporte de drenaje:** Es fundamental acompañar con abundante hidratación con electrolitos (al menos 1 litro de agua de calidad) y apoyos para la evacuación biliar e intestinal.\n\n## 🛒 Generadores y saunas en Amazon\nExplora equipos de sauna de vapor y accesorios en Amazon:\n\n> 🛒 **[Ver Generadores de Ozono y Saunas de Vapor en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Formación de peróxidos lipídicos (LOPs), activación del eje Nrf2/ARE, incremento de 2,3-DPG eritrocitario, hipertermia con destrucción selectiva de células deficientes en catalasa.',
        clinical_status:'Reconocido en farmacopeas y sociedades médicas de ozonoterapia (ISCO3). Estudios clínicos demuestran modulación inmunitaria y mejora en la calidad de vida de pacientes oncológicos.',
        pubmed_citations:JSON.stringify(['21627798','22359495','30568019']),status:'published'
      },
      {
        id:'wiki-estimulacion-nervio-vago',slug:'estimulacion-nervio-vago-vns',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Estimulación del Nervio Vago (VNS): Vía Antiinflamatoria Colinérgica y Tono Parasimpático',
        subtitle:'Bioestimulación auricular y cervical no invasiva para modular el eje cerebro-inmune y calmar citoquinas',
        evidence_level:'Ensayos Clínicos en Neuroinmunología (Frontiers in Neuroscience 2018 & Brain Stimulation 2020)',
        excerpt:'La estimulación transcutánea del nervio vago (tVNS) aprovecha la vía antiinflamatoria colinérgica para frenar la producción desmedida de citoquinas en el bazo y elevar la variabilidad de la frecuencia cardíaca, un marcador clave en la recuperación clínica.',
        body:`## La conexión entre el vago y el sistema inmune\nEl nervio vago no solo regula la frecuencia cardíaca o la motilidad gastrointestinal; también actúa como un cable directo entre el cerebro y los órganos inmunes. El grupo de Kevin Tracey demostró que la acetilcolina liberada por fibras vagales frena la inflamación descontrolada en macrófagos del bazo, un circuito conocido como la vía antiinflamatoria colinérgica.\n\n## Lo que ocurre en el organismo al estimular el vago\n* **Freno a las citoquinas inflamatorias:** La acetilcolina se une a los receptores nicotínicos alfa-7 (α7nAChR) en macrófagos tisulares, impidiendo que el factor NF-κB entre al núcleo. Esto reduce la liberación de TNF-α, IL-1β e IL-6, que frecuentemente alimentan el dolor y el desgaste en procesos crónicos.\n* **Desahogo de células Natural Killer:** Cuando el cuerpo vive en modo simpático continuo (lucha o huida), el exceso de adrenalina y cortisol agota la vigilancia inmune. Al elevar el tono vagal medido por la variabilidad de frecuencia cardíaca (VFC o HRV), las células citotóxicas y NK recuperan su capacidad de respuesta.\n* **Soporte al drenaje glifático y descanso:** Facilita la transición hacia el sueño profundo, periodo en el que el cerebro activa su sistema de limpieza de metabolitos.\n\n## Esquema de uso diario (Dr. Pete Sulack / Dispositivos como Vagustim)\n* **Al levantarse:** 5 a 10 minutos para calmar la descarga matutina de cortisol.\n* **Antes de comer:** 10 a 15 minutos para favorecer la digestión y la acidez gástrica normal.\n* **Por la noche:** 10 a 15 minutos antes de apagar las luces para predisponer el cuerpo al sueño profundo.\n* **Consejo de aplicación:** Los electrodos de clip auricular suelen colocarse en la concha o en el trago de la oreja izquierda, donde la rama auricular del vago es más accesible.\n\n## 🛒 Dispositivos y estimuladores en Amazon\nPuedes ver equipos de estimulación transcutánea vagal y electrodos auriculares en Amazon:\n\n> 🛒 **[Ver Dispositivos de Estimulación del Nervio Vago en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Señalización vagal colinérgica, activación receptor nicotínico α7nAChR, supresión transcripcional de TNF-α/IL-6, aumento de variabilidad cardíaca (HRV) y modulación de células NK.',
        clinical_status:'Dispositivos invasivos y transcutáneos aprobados por la FDA para cefaleas, depresión resistente y epilepsia. Investigación clínica activa en oncología por su correlación pronóstica con HRV.',
        pubmed_citations:JSON.stringify(['29662432','32371089','29387002']),status:'published'
      },
      {
        id:'wiki-maquina-rife-frecuencias',slug:'terapia-frecuencias-maquina-rife',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia de Frecuencias y Máquina RIFE: Bioresonancia Electromagnética y Evidencia Biofísica',
        subtitle:'Frecuencias de oscilación coordinada para modular la homeostasis eléctrica celular y disrumpir patógenos',
        evidence_level:'Biofísica y Estudios Experimentales (Journal of Alternative & Complementary Medicine)',
        excerpt:'La terapia de frecuencias basada en los planteamientos de Royal Raymond Rife utiliza microcorrientes y campos electromagnéticos específicos para inducir relajación del sistema nervioso, apoyar el terreno celular y complementar la desintoxicación.',
        body:`## El concepto detrás de las frecuencias bioeléctricas\nEn los años 30, Royal Raymond Rife postuló que cada microorganismo o tejido posee una frecuencia electromagnética característica a la que respondería por resonancia. Aunque la medicina convencional cataloga este enfoque como complementario o experimental por falta de grandes ensayos a doble ciego, en muchas clínicas integrativas se utiliza para influir en el terreno bioeléctrico y apoyar el drenaje de toxinas.\n\n## Efectos observados y mecanismos biofísicos\n* **Modulación del potencial de membrana:** Las microcorrientes pueden alterar temporalmente la conductancia en canales iónicos de calcio y potasio, facilitando el intercambio de nutrientes y desechos entre el interior celular y el líquido intersticial.\n* **Efecto sobre biopelículas bacterianas:** Investigaciones experimentales in vitro sugieren que ciertas frecuencias debilitan la matriz extracelular de biopelículas oportunistas que suelen proliferar cuando las defensas están bajas.\n* **Inducción de relajación física:** Trabajos que emplean ondas en frecuencias bajas (como las frecuencias de resonancia Schumann o el rango de ondas alfa entre 7 y 10 Hz) muestran una rápida bajada del estrés muscular y la ansiedad.\n\n## Recomendaciones prácticas del Dr. Pete Sulack\n* **Frecuencia:** De 3 a 5 sesiones a la semana, de unos 30 a 60 minutos cada una.\n* **Hidratación rigurosa:** Tomar suficiente agua mineral o filtrada antes y después de la sesión para evitar mareos o fatiga.\n* **Uso de aglutinantes:** Si se produce sensación de saturación o cansancio leve (reacción tipo depurativa), añadir arcilla bentonita, carbón vegetal o chlorella ayuda a fijar toxinas en el intestino.\n\n## 🛒 Equipos de frecuencias en Amazon\nExplora generadores de frecuencias y dispositivos bioeléctricos disponibles en Amazon:\n\n> 🛒 **[Ver Equipos de Frecuencias y Generadores Bioeléctricos en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Resonancia bioeléctrica, modulación de conductancia iónica transmembrana, perturbación electromagnética de biopelículas, estimulación de microcorrientes tisulares.',
        clinical_status:'Dispositivos de biofield experimental y bienestar complementario. Utilizados en clínicas de medicina alternativa internacional acompañados de seguimiento metabólico.',
        pubmed_citations:JSON.stringify(['12537682','21798363']),status:'published'
      },
      {
        id:'wiki-terapia-jugos-verdes',slug:'terapia-jugos-desintoxicacion-enzimas',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Terapia de Jugos Verdes Terapéuticos: Clorofila, Enzimas Vivas y Fitoquímica de Detoxificación',
        subtitle:'Zumos vegetales en prensado en frío para nutrir el organismo de micronutrientes sin fatiga digestiva',
        evidence_level:'Ensayos Nutricionales y Fitoquímica (Nutrients 2021)',
        excerpt:'Los zumos vegetales prensados en frío entregan concentraciones altas de clorofila, sulforafano y electrolitos sin exigir el desgaste calórico de una digestión pesada, apoyando las fases de desintoxicación hepática en organismos fatigados.',
        body:`## Por qué zumos vegetales en lugar de ensaladas enteras en terapia\nEn situaciones de enfermedad prolongada o caquexia, el aparato digestivo gasta mucha energía procesando grandes volúmenes de fibra cruda. Al extraer el zumo mediante prensado en frío (masticación lenta), los nutrientes, enzimas y sales minerales pasan con rapidez al torrente circulatorio sin fatigar el estómago ni el intestino delgado.\n\n## Los compuestos activos que marcan la diferencia\n* **Clorofila y oxigenación celular:** La clorofila tiene una estructura muy parecida a la hemoglobina humana, con magnesio en su núcleo en lugar de hierro. Ayuda a capturar mutágenos en el tubo digestivo y aporta magnesio biodisponible.\n* **Activación de enzimas de fase II:** Las crucíferas como la col rizada y el brócoli aportan glucosinolatos y sulforafano, inductores directos de la vía Nrf2 que aumentan la producción de glutatión hepático.\n* **Contrarrestar la acidez extracelular:** El aporte abundante de potasio y sales de citrato compensa el ambiente ácido que suele rodear a tejidos crónicamente inflamados.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Verduras base:** Apio, pepino, col rizada, espinaca y cilantro, combinados con un trozo de jengibre fresco o cúrcuma.\n* **Regla estricta con el azúcar:** Nada de zumos de naranja ni frutas dulces con mucha fructosa, porque elevan la insulina rápidamente. Para mejorar el sabor, basta con medio limón, una lima o un trozo pequeño de manzana verde ácida.\n* **Momento ideal:** Tomar un vaso grande recién hecho a primera hora en la mañana, con el estómago vacío.\n\n## 🛒 Extractores de prensado lento en Amazon\nPuedes conseguir extractores de prensado en frío (masticating juicers) en Amazon a través de nuestro enlace oficial:\n\n> 🛒 **[Ver Extractores de Prensado en Frío (Cold-Press) en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Aporte masivo de magnesio quelado por clorofila, inducción Nrf2/ARE de enzimas hepáticas de fase II, modulación alcalina del fluido intersticial, neutralización de ROS.',
        clinical_status:'Intervención nutricional complementaria consolidada en clínicas de oncología integrativa a nivel mundial (Terapia Gerson, protocolo Sulack, Centro Hippocrates).',
        pubmed_citations:JSON.stringify(['33671239','28678034','31487843']),status:'published'
      },
      {
        id:'wiki-vitamina-c-intravenosa',slug:'vitamina-c-intravenosa-altas-dosis',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Vitamina C Intravenosa (IVC): Pro-Oxidante Selectivo, Producción de H2O2 y Apoptosis Tumoral',
        subtitle:'Infusiones de ascorbato en dosis milimolares (25 a 100 g) que actúan como quimioterapia redox natural',
        evidence_level:'Ensayos Clínicos Fase I/II y Revisiones en Frontiers in Oncology & Redox Biology',
        excerpt:'En dosis intravenosas de 25 a 100 gramos, el ascorbato alcanza concentraciones milimolares en sangre y cambia su conducta: pasa de antioxidante a agente pro-oxidante que genera peróxido de hidrógeno en el tejido dañado sin perjudicar las células sanas.',
        body:`## De antioxidante oral a pro-oxidante en sangre\nCuando tomamos vitamina C por la boca, los transportadores intestinales se saturan pronto y la sangre rara vez pasa de 200 micromoles por litro. A esas concentraciones, el ácido ascórbico se comporta como un antioxidante clásico. En cambio, si se administran entre 25 y 100 gramos por goteo intravenoso continuo, las concentraciones plasmáticas se disparan a niveles de 20 a 30 milimoles por litro. A ese nivel ocurre un giro bioquímico: se convierte en un oxidante dirigido.\n\n## El mecanismo del peróxido de hidrógeno y la catalasa\n* **Reacción de Fenton en el espacio intercelular:** El ascorbato en sangre interacciona con trazas de hierro libre en los tejidos y produce peróxido de hidrógeno (H2O2).\n* **La gran diferencia con el tejido sano:** Las células normales cuentan con abundante catalasa y glutatión peroxidasa, enzimas que descomponen el peróxido en agua y oxígeno casi al instante. Las células neoplásicas, en cambio, tienen niveles muy bajos de catalasa, por lo que el peróxido daña sus mitocondrias y fractura su ADN sin que puedan defenderse.\n* **Menor formación de nuevos vasos sanguíneos:** Favorece la degradación de HIF-1α, la proteína que ordena fabricar nuevos capilares para alimentar lesiones anómalas.\n\n## Pautas y precauciones clínicas (Dr. Sulack / Protocolo Riordan)\n* **Frecuencia habitual:** De 1 a 3 infusiones por semana, ajustando la dosis según el nivel de ascorbato en sangre medido tras la infusión.\n* **Prueba obligatoria previa:** Es indispensable medir la enzima glucosa-6-fosfato deshidrogenasa (G6PD) antes de la primera dosis; si hay deficiencia de esta enzima, las dosis altas de vitamina C pueden romper glóbulos rojos (hemólisis).\n* **Hidratación con electrolitos:** Beber abundante líquido mineralizado antes y después de cada goteo para proteger los riñones y facilitar la eliminación.\n\n## 🛒 Apoyo y electrolitos en Amazon\nPuedes encontrar suplementos de electrolitos y accesorios de soporte clínico en Amazon:\n\n> 🛒 **[Ver Electrolitos y Accesorios de Salud en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Reacción de Fenton en espacio extracelular, generación masiva de peróxido de hidrógeno (H2O2), colapso mitocondrial por déficit de catalasa tumoral, degradación de HIF-1α.',
        clinical_status:'Protocolo Riordan ampliamente estandarizado. Ensayos clínicos Fase I y II publicados en cáncer de páncreas, ovario y glioblastoma demostrando seguridad y sinergia.',
        pubmed_citations:JSON.stringify(['33936998','32050854','29432098']),status:'published'
      },
      {
        id:'wiki-cuidado-quiropractico-neuroinmune',slug:'cuidado-quiropractico-alineacion-neuroinmune',category:'Enfoques y Terapias Complementarias',category_id:catTherId,
        title:'Cuidado Quiropráctico y Eje Neuroespinal: Alineación Vertebral, Flujo de LCR e Inmunidad',
        subtitle:'Corrección de subluxaciones vertebrales para normalizar el flujo simpático, drenaje de LCR y función inmune',
        evidence_level:'Estudios en Neuroplasticidad y Journal of Manipulative and Physiological Therapeutics',
        excerpt:'El ajuste quiropráctico específico busca corregir desalineaciones vertebrales que provocan irritación nerviosa continua, normalizando la sobrecarga simpática y facilitando la circulación del líquido cefalorraquídeo.',
        body:`## La columna como autopista del sistema nervioso y la inmunidad\nDe la médula espinal emergen las raíces nerviosas que coordinan no solo los músculos, sino la función de órganos como el bazo, el timo, los ganglios linfáticos y la médula ósea. Cuando una vértebra pierde su alineación biomecánica adecuada, se produce una compresión o irritación mecánica que envía señales constantes de estrés hacia la médula, manteniendo al sistema nervioso simpático en un estado de alarma crónica.\n\n## Lo que demuestran los estudios fisiológicos\n* **Descenso de mediadores de inflamación:** Diversos análisis clínicos publicados en revistas como el *Journal of Manipulative and Physiological Therapeutics* han documentado caídas objetivas en marcadores como TNF-α e IL-6 en sangre tras la corrección de fijaciones vertebrales.\n* **Circulación del líquido cefalorraquídeo:** La movilidad del segmento cervical superior (la unión entre el occipucio, el atlas y el axis) y del sacro influye directamente en el bombeo del líquido cefalorraquídeo, que limpia desechos celulares en el cerebro y la médula.\n* **Alivio de la sobrecarga de cortisol:** Al retirar la señal constante de dolor articular o pinzamiento, disminuye el estímulo que empuja a las glándulas suprarrenales a bombear cortisol sin descanso.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Evaluación profesional:** Recurrir siempre a quiroprácticos certificados que evalúen la columna de manera individualizada, sin maniobras bruscas en zonas comprometidas.\n* **Soporte postural en el hogar:** Realizar descompresión cervical suave, ejercicios de alineación con rodillos y descansos regulares para no sobrecargar el cuello ni la zona lumbar.\n* **Respiración diafragmática:** Acompañar los ajustes con respiraciones lentas para sostener el tono parasimpático a lo largo del día.\n\n## 🛒 Dispositivos de tracción y descanso en Amazon\nPuedes revisar equipos de tracción cervical pasiva y rodillos de descarga postural en Amazon:\n\n> 🛒 **[Ver Soportes Cervicales y Dispositivos de Tracción en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Atenuación de aferencias nociceptivas espinales, reducción de tono simpático periférico, normalización del flujo pulsátil de LCR, modulación de citoquinas inflamatorias.',
        clinical_status:'Profesión sanitaria regulada en Estados Unidos, Canadá, Europa y América Latina. Empleada en oncología integrativa para alivio de dolor músculo-esquelético y fatiga.',
        pubmed_citations:JSON.stringify(['20609867','27429842']),status:'published'
      },
      {
        id:'wiki-dieta-cetogenica-oncologia',slug:'dieta-cetogenica-oncologia-metabolica',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Dieta Cetogénica Terapéutica en Cáncer: Deprivación Glucémica, Cuerpos Cetónicos y Ratio GKI',
        subtitle:'Distribución rica en grasas saludables y baja en carbohidratos para asfixiar la dependencia tumoral de glucosa',
        evidence_level:'Ensayos Clínicos, Nature Reviews Cancer y Cell Metabolism',
        excerpt:'La dieta cetogénica terapéutica reduce drásticamente la disponibilidad de glucosa e insulina en sangre, aprovechando que la gran mayoría de células tumorales no pueden utilizar cuerpos cetónicos debido a defectos en sus mitocondrias.',
        body:`## La trampa metabólica del tumor (Efecto Warburg)\nEn la década de 1920, Otto Warburg descubrió que las células cancerosas dependen casi por completo de la fermentación rápida de glucosa para subsistir, incluso cuando hay oxígeno disponible. Sus mitocondrias suelen presentar alteraciones estructurales que les impiden quemar cuerpos cetónicos eficientemente. En cambio, las células sanas del cerebro, el corazón y el tejido muscular funcionan con total normalidad quemando cetonas como combustible limpio.\n\n## Cambios bioquímicos al entrar en cetosis\n* **Freno a la ruta de crecimiento PI3K/Akt/mTOR:** Al recortar los carbohidratos refinados, los niveles basales de glucosa e insulina disminuyen, retirando el principal estímulo que activa la multiplicación acelerada.\n* **Estrés bioenergético en la célula alterada:** Al verse privadas de glucosa y sin mitocondrias sanas para procesar grasas, las células atípicas sufren un colapso energético que precipita la apoptosis.\n* **El papel señalizador del beta-hidroxibutirato:** Más allá de ser un combustible, el beta-hidroxibutirato (BHB) actúa inhibiendo enzimas histonas desacetilasas (HDAC), lo que ayuda a reactivar genes de defensa celular que estaban apagados.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Reparto aproximado del plato:** Alrededor del 70% de las calorías provenientes de grasas de calidad (aceite de oliva virgen extra, aguacate, coco, frutos secos), 20% de proteínas limpias y 10% de carbohidratos netos (verduras de hoja verde sin almidón).\n* **El ratio glucosa-cetonas (GKI):** Desarrollado por el Dr. Thomas Seyfried en Boston College, busca mantener un índice GKI por debajo de 2.0 (calculado como: glucosa en mg/dL dividido entre 18, y ese resultado dividido entre las cetonas en mmol/L).\n* **Monitoreo con sangre capilar:** Para saber si se está en cetosis real, es aconsejable medir glucosa y cetonas con tiras reactivas en sangre (dispositivos como Keto-Mojo), ya que las tiras de orina pierden exactitud al cabo de pocos días.\n\n## 🛒 Kits de medición en Amazon\nPuedes adquirir el kit de medición capilar de glucosa y cetonas Keto-Mojo en Amazon:\n\n> 🛒 **[Ver Kit de Medición Keto-Mojo en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Supresión vía PI3K/Akt/mTOR, privación de sustrato glucolítico tumoral, inhibición de HDAC por beta-hidroxibutirato, elevación selectiva de estrés oxidativo en células mutadas.',
        clinical_status:'Ensayos clínicos aleatorizados en gliomas, cáncer de mama, próstata y endometrio. Protocolo metabólico central impulsado por el Dr. Thomas Seyfried en Boston College.',
        pubmed_citations:JSON.stringify(['32832811','31804968','33177658']),status:'published'
      },
      {
        id:'wiki-ayuno-intermitente-oncologia',slug:'ayuno-intermitente-autofagia-sensibilizacion',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Ayuno Intermitente: Autofagia Celular, Flexibilidad Metabólica y Protección Diferencial',
        subtitle:'Ventanas 16:8 y 18:6 para activar SIRT1, reciclar mitocondrias disfuncionales y proteger al tejido sano',
        evidence_level:'Ensayos Clínicos en Humanos (Cell Metabolism 2021 & NEJM 2019)',
        excerpt:'El ayuno intermitente activa la autofagia y pone en marcha el principio de resistencia diferencial al estrés descubierto por Valter Longo: las células sanas se protegen ante la escasez calórica, mientras que las células atípicas quedan desprotegidas y vulnerables.',
        body:`## Qué ocurre durante las horas sin comida\nEl ayuno intermitente no consiste en pasar hambre durante días, sino en delimitar las comidas a una ventana horaria del día (por ejemplo, 16 horas de pausa digestiva y 8 horas de comida, o esquemas 18:6). Durante esas horas de descanso digestivo solo se consumen líquidos sin calorías: agua filtrada, infusiones de hierbas y electrolitos.\n\n## El concepto de resistencia diferencial al estrés (DSR)\n* **El escudo de las células sanas:** El Dr. Valter Longo describió cómo las células sanas, al percibir la bajada de glucosa e insulina, detienen temporalmente sus procesos de división celular y dirigen su energía al mantenimiento interno y la reparación de ADN.\n* **La vulnerabilidad de la célula tumoral:** Debido a sus mutaciones de crecimiento constante, las células cancerosas no pueden poner el freno de mano. Continúan intentando replicarse sin combustible, lo que las debilita enormemente frente al estrés oxidativo o a los tratamientos convencionales.\n* **Activación de autofagia y mitofagia:** Tras unas 14 a 16 horas continuas de ayuno, se disparan los mecanismos de limpieza celular mediada por lisosomas, reciclando mitocondrias gastadas y cúmulos de proteínas anómalas.\n\n## Recomendaciones del Dr. Pete Sulack\n* **Avance paulatino:** Conviene empezar con un esquema suave de 14 horas de ayuno y 10 de ingesta durante unos días, pasando después a 16:8 si el cuerpo se adapta con buena energía.\n* **Agua con minerales:** Mantener una hidratación generosa con una pizca de sal marina o electrolitos sin azúcar para no tener dolores de cabeza ni calambres.\n* **Calidad en la ventana de comida:** Al romper el ayuno, elegir alimentos ricos en micronutrientes y grasas buenas en lugar de carbohidratos refinados o comidas copiosas.\n\n## 🛒 Electrolitos para ayuno en Amazon\nRevisa marcas de electrolitos sin edulcorantes artificiales en Amazon:\n\n> 🛒 **[Ver Electrolitos sin Azúcar para Ayuno en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Activación de AMPK y sirtuinas SIRT1/3, supresión mTOR, degradación lisosomal por autofagia/mitofagia, descenso de IGF-1 sérico, resistencia diferencial al estrés (DSR).',
        clinical_status:'Ensayos clínicos Fase II en humanos demuestran que el ayuno periquimioterapia reduce significativamente efectos adversos hematológicos y gastrointestinales.',
        pubmed_citations:JSON.stringify(['31881139','33887985','29387002']),status:'published'
      },
      {
        id:'wiki-ayuno-hidrico-prolongado',slug:'ayuno-hidrico-prolongado-regeneracion-celular',category:'Estrategia Metabólica y Biología Celular',category_id:catMetaId,
        title:'Ayuno Hídrico Prolongado: Autofagia Profunda, Regeneración Inmune y Reseteo por Células Madre',
        subtitle:'Abstinencia calórica de 24 a 72 horas para reciclar leucocitos senescentes y despertar células madre hematopoyéticas',
        evidence_level:'Investigación Fundamental y Ensayos Clínicos (NEJM & Cell Stem Cell)',
        excerpt:'El ayuno solo con agua durante 24 a 72 horas agota el glucógeno hepático y desencadena una renovación profunda: elimina glóbulos blancos senescentes, reduce los niveles de IGF-1 y estimula a las células madre de la médula ósea.',
        body:`## Qué le ocurre al cuerpo tras 24 horas de ayuno con agua\nCuando pasan las primeras 24 horas continuas de ayuno hídrico, las reservas de glucógeno almacenadas en el hígado se agotan por completo. El organismo entra de lleno en una cetogénesis profunda. A partir de las 48 y hasta las 72 horas se producen cambios biológicos difíciles de reproducir con ningún fármaco.\n\n## La renovación del sistema inmune según Valter Longo\n* **Limpieza de glóbulos blancos gastados:** Las investigaciones del Dr. Valter Longo publicadas en *Cell Stem Cell* demostraron que un ayuno prolongado de 48 a 72 horas obliga al organismo a destruir una parte importante de leucocitos viejos o dañados para reciclar sus componentes.\n* **Despertar de células madre en médula ósea:** Al volver a comer, las células madre hematopoyéticas se activan y generan una población nueva de glóbulos blancos jóvenes y funcionales.\n* **Bajada de IGF-1 y PKA:** El factor de crecimiento semejante a la insulina tipo 1 (IGF-1) y la enzima proteína quinasa A (PKA) caen en picado, retirando dos de las señales que más favorecen la supervivencia tumoral.\n* **Autofagia intensiva:** Las células degradan mitocondrias defectuosas y cúmulos de proteínas mal plegadas para obtener aminoácidos de mantenimiento.\n\n## Pautas de seguridad del protocolo del Dr. Pete Sulack\n* **Frecuencia y duración:** Empezar con periodos de 24 a 48 horas una vez al mes. Llegar a 72 horas debe hacerse siempre con supervisión de un médico o especialista en nutrición integrativa.\n* **Líquidos y descanso:** Beber abundante agua filtrada con electrolitos (sodio, potasio, magnesio) y guardar reposo, evitando esfuerzos físicos intensos.\n* **Cómo romper el ayuno sin dañar el estómago:** Nunca romper un ayuno prolongado con carbohidratos, azúcar ni comidas pesadas. Lo adecuado es empezar con caldo de huesos con colágeno, verduras suaves al vapor o un poco de aguacate en raciones pequeñas.\n\n## 🛒 Electrolitos y caldos en Amazon\nPuedes encontrar sales minerales puras para ayuno y caldos de hueso orgánicos en Amazon:\n\n> 🛒 **[Ver Caldos de Hueso y Electrolitos en Amazon →](https://amzn.to/46PTWSA)**`,
        mechanisms:'Agotamiento total de glucógeno hepático, silenciamiento del eje IGF-1/PKA, autofagia profunda mediada por chaperonas, activación de células madre hematopoyéticas pluripotenciales.',
        clinical_status:'Supervisado en centros clínicos de ayuno médico (TrueNorth Health Center). Respaldado por estudios clínicos de intervención metabólica y longevidad celular.',
        pubmed_citations:JSON.stringify(['24905167','31881139','29534435']),status:'published'
      },
      {
        id:'wiki-beta-glucanos-hongos',slug:'beta-glucanos-inmunologia-reishi-cola-pavo',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Beta-Glucanos Inmunológicos: Polisacáridos de Hongos Medicinales, Células NK y Macrófagos',
        subtitle:'Polímeros de glucosa con enlaces beta-1,3/1,6 procedentes de Reishi, Shiitake y Cola de Pavo (Coriolus versicolor)',
        evidence_level:'Ensayos Clínicos Aleatorizados (Cancer Immunology Research 2022)',
        excerpt:'Los beta-glucanos con enlaces 1,3/1,6 procedentes de hongos medicinales como Reishi, Shiitake y Cola de Pavo activan los receptores dectina-1 y CR3 en el intestino, estimulando la vigilancia de macrófagos y células Natural Killer.',
        body:`## Qué son los beta-glucanos fúngicos\nLos beta-glucanos son polisacáridos complejos presentes en la pared celular de hongos macromicetos como *Ganoderma lucidum* (Reishi), *Lentinula edodes* (Shiitake) y *Trametes versicolor* (Cola de Pavo o Coriolus). A diferencia de los beta-glucanos solubles de los cereales como la avena, los de origen micológico tienen enlaces específicos beta-1,3/1,6-D-glucano, que son los que desencadenan la respuesta biológica en las defensas.\n\n## Cómo interactúan con el sistema inmune\n* **Reconocimiento en placas de Peyer:** Al ingerirse, pasan a las células M del intestino delgado y son captados por los macrófagos a través del receptor dectina-1 y el receptor de complemento 3 (CR3).\n* **Activación de células Natural Killer y linfocitos T:** Facilitan la liberación de perforinas y granzimas, dotando a las células NK de mayor capacidad para reconocer y destruir células anómalas.\n* **Orientación hacia una respuesta Th1:** Estimulan la síntesis de interferón gamma (IFN-γ) e interleucina 12, favoreciendo un perfil inmunitario orientado a la defensa antitumoral.\n\n## Recomendaciones de uso del Dr. Pete Sulack\n* **Dosis diaria habitual:** De 500 a 1.000 mg al día de extracto purificado o de un complejo que reúna Reishi, Shiitake y Cola de Pavo.\n* **Forma de tomarlo:** Tomar con un vaso de agua antes de una comida o en ayunas. Acompañarlo con un poco de vitamina C facilita la absorción y el reconocimiento por los receptores intestinales.\n\n## 🌿 Opciones con descuento en iHerb\nPuedes adquirir extractos de hongos medicinales con beta-glucanos estandarizados en iHerb con nuestro cupón de comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Beta-Glucanos en iHerb →](https://www.iherb.com/search?kw=beta%20glucans%20mushroom&rcode=wUt7svK8)**\n> *(Enlace directo: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Ligando selectivo de receptor dectina-1 y CR3, activación tirosina quinasa Syk, degranulación de células Natural Killer (NK), polarización inmunológica Th1 antitumoral.',
        clinical_status:'Extractos de beta-glucanos como PSK (Krestin) y Lentinan han sido aprobados como fármacos adyuvantes oncológicos oficiales por el Ministerio de Salud de Japón desde hace cuatro décadas.',
        pubmed_citations:JSON.stringify(['35086884','33574805','30806254']),status:'published'
      },
      {
        id:'wiki-calostro-factores-transferencia',slug:'calostro-bovino-factores-transferencia-galt',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Calostro Bovino y Factores de Transferencia: Inmunoglobulinas, Reparación Intestinal y GALT',
        subtitle:'Primera leche biológica rica en inmunoglobulinas IgG, lactoferrina y prolina para restaurar la barrera mucosal',
        evidence_level:'Ensayos Clínicos en Nutrición Inmunológica (Nutrients 2021)',
        excerpt:'El calostro bovino aporta inmunoglobulinas IgG, lactoferrina y polipéptidos ricos en prolina que reparan la permeabilidad intestinal, modulan el tejido linfoide GALT y reducen el paso de toxinas bacterianas hacia la sangre.',
        body:`## Qué aporta el calostro bovino\nEl calostro es el fluido concentrado producido por las vacas durante las primeras 48 a 72 horas tras el parto. Contiene una combinación única de inmunoglobulinas activas (principalmente IgG1, IgG2 e IgA), lactoferrina, lisozima y polipéptidos ricos en prolina (PRP), a menudo denominados factores de transferencia.\n\n## Beneficios para la mucosa y el tejido inmune intestinal\n* **Reparación de la barrera digestiva:** Sus factores de crecimiento (EGF, IGF-1 y TGF-β) estimulan la regeneración de los enterocitos y refuerzan las uniones estrechas celulares (claudinas y ocludinas), frenando la hiperpermeabilidad intestinal que suele alimentar la inflamación de bajo grado.\n* **Apoyo al tejido linfoide GALT:** Más del 70% de las defensas del organismo están asentadas a lo largo de la pared intestinal. Las inmunoglobulinas del calostro neutralizan antígenos directamente en la luz del tubo digestivo, aliviando la sobrecarga sobre el sistema inmune sistémico.\n* **Acción secuestradora de la lactoferrina:** Esta proteína fija el hierro libre en el intestino, privando de ese nutriente esencial a bacterias perjudiciales y células anómalas que dependen de él para multiplicarse.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis sugerida:** De 1 a 2 gramos diarios de calostro bovino puro desgrasado (en polvo para disolver en la boca o en cápsulas entéricas).\n* **Calidad del producto:** Buscar calostro recolectado en las primeras 24 horas tras el parto, proveniente de vacas alimentadas con pasto y secado a baja temperatura para no desnaturalizar las proteínas inmunes.\n\n## 🌿 Adquisición en iHerb con descuento\nPuedes adquirir calostro bovino de pastoreo en iHerb usando el cupón de nuestra comunidad: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Calostro Bovino en iHerb →](https://www.iherb.com/search?kw=colostrum%20transfer%20factors&rcode=wUt7svK8)**\n> *(Enlace directo: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Aporte oral de inmunoglobulinas IgG/IgA bioactivas, regeneración epitelial por EGF e IGF-1, quelación de hierro por lactoferrina, neutralización de endotoxinas LPS en lumen intestinal.',
        clinical_status:'Nutracéutico aprobado ampliamente para reparación de barrera digestiva y soporte inmune. Documentado en ensayos clínicos en prevención de toxicidad intestinal por tratamientos invasivos.',
        pubmed_citations:JSON.stringify(['34208468','33804860','28574925']),status:'published'
      },
      {
        id:'wiki-probioticos-microbioma-galt',slug:'probioticos-multicepa-microbioma-eje-inmune',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Probióticos Multicepa y Microbioma: Modulación del Eje Intestino-Inmune y Butirato en Cáncer',
        subtitle:'Bacterias comensales de alta potencia (10 a 20 mil millones UFC) para regenerar la diversidad de la flora y potenciar la inmunoterapia',
        evidence_level:'Ensayos Clínicos en Cell Host & Microbe 2021 y Science',
        excerpt:'Los probióticos multicepa ayudan a restaurar la flora intestinal dañada por tratamientos médicos, aumentan la producción de butirato (un inhibidor natural de HDAC) y mejoran la respuesta del sistema inmune ante terapias oncológicas.',
        body:`## La microbiota como aliada del tratamiento\nEl intestino humano alberga miles de millones de microorganismos. Publicaciones de primer nivel en revistas como *Science* y *Nature* han demostrado que la composición y variedad de estas bacterias influyen de forma directa en cómo el paciente responde a la quimioterapia y a la inmunoterapia moderna.\n\n## Qué hacen las cepas bacterianas en el organismo\n* **Producción de butirato:** Cepas de *Bifidobacterium* y *Lactobacillus* favorecen la formación de ácidos grasos de cadena corta, en particular el butirato. Este compuesto alimenta a las células del colon y actúa como un inhibidor natural de enzimas histonas desacetilasas (HDAC), favoreciendo la expresión de genes supresores de crecimiento tumoral.\n* **Protección frente a toxinas bacterianas:** Al colonizar la mucosa, impiden que bacterias oportunistas liberen lipopolisacáridos (LPS) hacia el torrente sanguíneo, cortando una fuente continua de inflamación sistémica.\n* **Entrenamiento de células inmunes:** Estimulan a las células dendríticas en los ganglios linfáticos del intestino para que presenten antígenos con mayor eficacia a los linfocitos T citotóxicos.\n\n## Recomendaciones del Dr. Pete Sulack\n* **Dosis diaria recomendada:** 1 cápsula al día de un complejo multicepa de amplio espectro que garantice entre 10 y 20 mil millones de UFC (unidades formadoras de colonias).\n* **Tipo de cápsula:** Es preferible elegir presentaciones con recubrimiento gastrorresistente (cápsulas DRcaps o de liberación retardada) para que las bacterias no mueran por la acción de los jugos del estómago.\n\n## 🌿 Fórmulas de calidad en iHerb\nEncuentra probióticos multicepa con protección gástrica en iHerb usando el cupón: **\`wUt7svK8\`**.\n\n> 🛒 **[Ver opciones recomendadas de Probióticos Multicepa en iHerb →](https://www.iherb.com/search?kw=probiotics%20multi%20strain&rcode=wUt7svK8)**\n> *(Enlace directo: [https://iherb.co/wUt7svK8](https://iherb.co/wUt7svK8))*.`,
        mechanisms:'Fermentación de fibra a butirato/acetato, mantenimiento de uniones estrechas intestinales, modulación de checkpoints inmunes y células dendríticas, exclusión de patógenos.',
        clinical_status:'Extensamente respaldado en la literatura médica. Ensayos clínicos en marcha demuestran que trasplantes de microbiota o cepas de Bifidobacterium revierten la resistencia a inhibidores de PD-1.',
        pubmed_citations:JSON.stringify(['34416041','29102798','31163624']),status:'published'
      },
      {
        id:'wiki-aceite-oliva-oleocantal',slug:'aceite-oliva-virgen-extra-oleocantal',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Aceite de Oliva Virgen Extra (AOVE): Oleocantal, Lisis Lisosomal Tumoral y Polifenoles',
        subtitle:'Compuesto fenólico secoridoide con capacidad de inducir apoptosis selectiva mediante permeabilización lisosomal',
        evidence_level:'Ensayos en Molecular & Cellular Oncology y Nutrients 2020',
        excerpt:'El oleocantal presente en el aceite de oliva virgen extra de cosecha temprana rompe selectivamente la membrana de los lisosomas en células cancerosas liberando sus propias enzimas digestivas, sin provocar daño en los tejidos sanos.',
        body:`## El compuesto responsable del picor en la garganta\nEl oleocantal es un polifenol presente exclusivamente en el aceite de oliva virgen extra (*EVOO*) de alta calidad. Es la sustancia que provoca un ligero picor característico al tragarlo. Químicamente comparte propiedades antiinflamatorias similares al ibuprofeno, pero con una excelente tolerancia celular.\n\n## La acción sobre los lisosomas de células anómalas\n* **Permeabilización lisosomal selectiva:** Un estudio de referencia del Hunter College y Rutgers University publicado en *Molecular & Cellular Oncology* mostró que el oleocantal debilita la pared de los lisosomas en células tumorales (que son más frágiles y grandes de lo normal). Al romperse, las enzimas digestivas internas se derraman dentro de la célula maligna y la descomponen en un lapso de 30 a 60 minutos.\n* **Respeto a las células sanas:** En las células normales, el oleocantal solo provoca una pausa temporal en el ciclo celular sin causar toxicidad; a las 24 horas reanudan su función normal.\n* **Efecto antiinflamatorio:** Inhibe las enzimas ciclooxigenasa-1 y 2 (COX-1 y COX-2), reduciendo prostaglandinas proinflamatorias como la PGE2.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Dosis diaria:** De 1 a 2 cucharadas soperas al día de aceite de oliva virgen extra crudo, preferiblemente en ayunas o integrado en la primera comida.\n* **Siempre en crudo:** No cocinar ni sobrecalentar este aceite para no degradar los polifenoles termolábiles. Usarlo sobre ensaladas, verduras cocidas al vapor o purés tibios.\n* **Sinergia hepática:** Tomarlo mezclado con unas gotas de zumo de limón fresco ayuda a estimular el flujo biliar y la motilidad de la vesícula.\n* **Criterio de compra:** Elegir aceites de cosecha temprana, prensados en frío y en botella oscura, con certificado de alto contenido en polifenoles (más de 300 mg/kg).\n\n## 🌿 Adquisición en iHerb y Amazon\nPuedes ver aceites de oliva virgen extra orgánicos y ricos en polifenoles en iHerb (código **\`wUt7svK8\`**) o en Amazon:\n\n> 🛒 **[Ver Opciones de Aceite de Oliva Rico en Polifenoles en iHerb →](https://www.iherb.com/search?kw=extra%20virgin%20olive%20oil%20organic&rcode=wUt7svK8)**\n> *(O explora en Amazon a través de nuestro enlace oficial: [https://amzn.to/46PTWSA](https://amzn.to/46PTWSA))*.`,
        mechanisms:'Permeabilización selectiva de membrana lisosomal tumoral (LMP), liberación de catepsinas hidrolíticas, inhibición COX-1/COX-2, modulación antioxidante de peroxidación lipídica.',
        clinical_status:'Alimento funcional terapéutico ampliamente estudiado en estudios epidemiológicos de la Dieta Mediterránea (ensayo PREDIMED) con reducción de recurrencias neoplásicas.',
        pubmed_citations:JSON.stringify(['26451384','32050854','30138241']),status:'published'
      },
      {
        id:'wiki-incienso-boswellia',slug:'aceite-esencial-incienso-boswellia-akba',category:'Suplementos y Nutracéuticos',category_id:catSuppId,
        title:'Incienso y Ácidos Boswélicos (Boswellia / AKBA): Inhibición de 5-LOX, Apoptosis y Desinflamación',
        subtitle:'Resina de Boswellia carterii y serrata estandarizada en ácido acetil-11-ceto-beta-boswélico (AKBA)',
        evidence_level:'Ensayos Clínicos y Revisiones en BMC Complementary Medicine & Molecules',
        excerpt:'El extracto de Boswellia serrata y su principio activo AKBA bloquean selectivamente la enzima 5-lipoxigenasa (5-LOX), frenando la formación de leucotrienos inflamatorios y ayudando a reducir el edema peritumoral sin los efectos secundarios de los corticoides.',
        body:`## Qué es la Boswellia y el incienso medicinal\nEl incienso se obtiene a partir de la resina de árboles del género *Boswellia* (*Boswellia serrata* y *Boswellia carterii*), originarios de Oriente Medio y la India, donde se conoce tradicionalmente como *Salai Guggal*. En su resina se encuentran los ácidos boswélicos, entre los que destaca el **AKBA** (ácido acetil-11-ceto-beta-boswélico), el compuesto con mayor actividad biológica documentada.\n\n## Cómo frena la inflamación celular\n* **Bloqueo directo de la 5-lipoxigenasa (5-LOX):** La mayoría de los antiinflamatorios comunes actúan sobre las enzimas COX. La Boswellia es uno de los pocos compuestos naturales que bloquea de forma específica a la 5-LOX, deteniendo la fabricación de leucotrienos (LTB4), sustancias que aumentan el edema, la permeabilidad vascular y la inflamación de los tejidos.\n* **Ayuda en el edema peritumoral:** Diversos ensayos clínicos han evaluado su uso en pacientes con tumores del sistema nervioso central o tras sesiones de radioterapia, mostrando que puede reducir la hinchazón cerebral y permitir pautas más bajas de dexametasona u otros corticoides.\n* **Inducción de apoptosis:** En modelos celulares de mama, colon y cerebro, el AKBA altera la membrana mitocondrial de células anómalas, provocando la activación de caspasas 3 y 8.\n\n## Pautas del protocolo del Dr. Pete Sulack\n* **Inhalación y difusión:** Difundir aceite esencial puro de incienso (*Boswellia carterii*) en la habitación para favorecer la relajación y el alivio respiratorio.\n* **Uso tópico:** Diluir unas gotas en un aceite base (jojoba o coco) y masajear suavemente la zona del cuello o las áreas de tensión.\n* **Vía oral estandarizada:** Para conseguir efectos sistémicos antiinflamatorios se recomienda extracto seco estandarizado de *Boswellia serrata* (con al menos un 30% de AKBA) tomado junto con una comida que contenga grasas saludables para mejorar su absorción.\n\n## 🌿 Boswellia y aceites esenciales en iHerb y Amazon\nPuedes conseguir extractos estandarizados de Boswellia en iHerb con el cupón **\`wUt7svK8\`** o aceites esenciales puros en Amazon:\n\n> 🛒 **[Ver Extracto de Boswellia Serrata en iHerb →](https://www.iherb.com/search?kw=boswellia%20akba&rcode=wUt7svK8)**\n> *(O busca aceites esenciales en Amazon mediante nuestro enlace oficial: [https://amzn.to/46PTWSA](https://amzn.to/46PTWSA))*.`,
        mechanisms:'Inhibición alostérica no redox de 5-lipoxigenasa (5-LOX), detención de síntesis de leucotrienos LTB4, activación caspasas 3 y 8, inhibición de topoisomerasas tumorales.',
        clinical_status:'Fitofármaco aprobado en monografías de la Agencia Europea del Medicamento (EMA) y farmacopea alemana. Investigado en ensayos clínicos para edema cerebral peritumoral.',
        pubmed_citations:JSON.stringify(['32505599','31284566','22505876']),status:'published'
      }
    ];
    for(const art of seedArticles){
      await query(`INSERT INTO wiki_articles(id,slug,category,category_id,title,subtitle,evidence_level,excerpt,body,mechanisms,clinical_status,pubmed_citations,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(slug) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, evidence_level=excluded.evidence_level, excerpt=excluded.excerpt, body=excluded.body, mechanisms=excluded.mechanisms, clinical_status=excluded.clinical_status, pubmed_citations=excluded.pubmed_citations WHERE wiki_articles.author_id IS NULL`,
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
    if(path.startsWith('wiki')||path.startsWith('admin')||path.startsWith('product')||path==='public'||path==='sitemap'||path==='preview'){await ensureWikiSchema();await ensureProductsSchema();}
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
        "@type": "CommunityOrganization",
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
          const pPubDate = p.updated_at ? new Date(p.updated_at).toISOString() : new Date('2026-09-28T00:00:00Z').toISOString();
          const pImg = image && !image.endsWith('.svg') ? image : origin() + '/logo.png';
          schemaJson=JSON.stringify({
            "@context":"https://schema.org",
            "@type":"Article",
            "headline":p.title,
            "description":desc,
            "image":[pImg],
            "datePublished":pPubDate,
            "dateModified":pPubDate,
            "author":orgPublisher,
            "publisher":orgPublisher,
            "mainEntityOfPage":{
              "@type":"WebPage",
              "@id":canonicalUrl
            },
            "articleSection":"Comunidad y Divulgación de Acompañamiento",
            "audience":{
              "@type":"Audience",
              "audienceType":"Pacientes oncológicos, familiares y comunidad de apoyo"
            }
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
              "@type":"CollectionPage",
              "headline":title,
              "description":desc,
              "about":"Divulgación de investigaciones y acompañamiento en oncología integrativa",
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
          "@type":"CollectionPage",
          "headline":title,
          "description":desc,
          "about":"Compendio de literatura científica y acompañamiento integrativo",
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
          "@type":"CollectionPage",
          "headline":title,
          "description":desc,
          "about":"Compendio de oncología metabólica y acompañamiento integrativo",
          "publisher":orgPublisher
        });
      }else if(type==='wiki'){
        const cats = (await query("SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC")) || [];
        const arts = (await query("SELECT id,slug,category,category_id,title,subtitle,evidence_level,excerpt,updated_at FROM wiki_articles WHERE status='published' ORDER BY title ASC")) || [];
        const wikiSidebarHtml = `<aside style="margin-bottom:20px;position:sticky;top:20px;">
          <details class="wiki-drawer" style="background:#fff;border-radius:12px;border:1px solid #dce8df;overflow:hidden;box-shadow:0 2px 8px rgba(18,61,57,0.04);">
            <summary style="padding:12px 16px;font-size:0.88rem;font-weight:700;color:#123d39;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;background:#fbfdfc;border-bottom:1px solid #eef3f0;user-select:none;">
              <span>📚 <span>Índice y temas (${arts.length})</span></span>
              <span style="font-size:0.78rem;color:#55726a;background:#eef4f0;padding:3px 9px;border-radius:12px;font-weight:600;">Desplegar ▾</span>
            </summary>
            <div style="padding:16px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px;">` +
          cats.map(c => {
            const catArts = arts.filter(a => a.category_id === c.id || a.category === c.name);
            return `<div>
              <div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#1e6b42;margin-bottom:6px;display:flex;align-items:center;gap:6px;"><span>${c.icon||'📚'}</span> ${escHtml(c.name)}</div>
              <ul style="list-style:none;margin:0;padding:0 0 0 8px;border-left:2px solid #e2ebe5;display:flex;flex-direction:column;gap:4px;">
                ${catArts.map(a => `<li style="margin:0;"><a href="${origin()}/wiki/${a.slug}" style="display:block;padding:4px 8px;font-size:0.84rem;color:${targetId===a.slug||targetId===a.id?'#1e6b42':'#27453f'};font-weight:${targetId===a.slug||targetId===a.id?'700':'400'};text-decoration:none;border-radius:5px;background:${targetId===a.slug||targetId===a.id?'#e8f4ec':'transparent'};">${escHtml(a.title)}</a></li>`).join('')}
                ${!catArts.length ? `<li style="font-size:0.75rem;color:#78938b;padding:2px 8px;">Próximamente</li>` : ''}
              </ul>
            </div>`;
          }).join('') + `</div></details></aside>`;

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
            image = origin()+'/logo.png';
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
              if(relatedVideos.length > 0){
                const topV = relatedVideos[0];
                if(topV.platform==='youtube'&&topV.external_id){
                  image = `https://i.ytimg.com/vi/${topV.external_id}/hqdefault.jpg`;
                }else if(topV.thumbnail && !topV.thumbnail.endsWith('.svg')){
                  image = topV.thumbnail;
                }
              }
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
            const pubDate = art.updated_at ? new Date(art.updated_at).toISOString() : new Date('2026-09-28T00:00:00Z').toISOString();
            schemaJson=JSON.stringify({
              "@context":"https://schema.org",
              "@type":"Article",
              "headline":art.title,
              "description":desc,
              "image":[image],
              "datePublished":pubDate,
              "dateModified":pubDate,
              "author":orgPublisher,
              "publisher":orgPublisher,
              "mainEntityOfPage":{
                "@type":"WebPage",
                "@id":canonicalUrl
              },
              "articleSection":"Biblioteca de Investigación y Acompañamiento",
              "about":art.title,
              "audience":{
                "@type":"Audience",
                "audienceType":"Pacientes, familias y comunidad de apoyo"
              },
              "citation":citations.map(c=>`https://pubmed.ncbi.nlm.nih.gov/${c}/`)
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
              "@type":"CommunityOrganization",
              "name":"Comunidad Sanantes",
              "alternateName":["El Podcast del Cáncer","Podcast del Cáncer","Sanantes"],
              "url":origin(),
              "logo":origin()+"/logo.png",
              "description":"Comunidad de acompañamiento, apoyo mutuo y divulgación científica sobre oncología integrativa para pacientes y familias.",
              "knowsAbout":["Acompañamiento a pacientes con cáncer","Oncología integrativa","Estrategia metabólica celular","Calidad de vida y bienestar"],
              "audience":{
                "@type":"Audience",
                "audienceType":"Pacientes oncológicos, familiares, cuidadores y comunidad de apoyo"
              },
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
      return res.end(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sTitle}</title><meta name="description" content="${sDesc}"><link rel="canonical" href="${sCanon}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/logo.png"><script async src="https://www.googletagmanager.com/gtag/js?id=G-JNXSFX7HF3"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-JNXSFX7HF3');</script><meta property="og:type" content="article"><meta property="og:site_name" content="Comunidad Sanantes"><meta property="og:title" content="${sTitle}"><meta property="og:description" content="${sDesc}"><meta property="og:image" content="${sImg}"><meta property="og:image:secure_url" content="${sImg}"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720"><meta property="og:url" content="${sCanon}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${sTitle}"><meta name="twitter:description" content="${sDesc}"><meta name="twitter:image" content="${sImg}"><style>.wiki-grid{display:grid;grid-template-columns:260px minmax(0,1fr) 220px;gap:32px;align-items:start;max-width:1440px;margin:28px auto;padding:0 20px}@media(max-width:1150px){.wiki-grid{grid-template-columns:240px minmax(0,1fr)}.wiki-right-col{display:none}}@media(max-width:768px){.wiki-grid{grid-template-columns:1fr}}</style>${type==='video'?`<script>location.replace(${JSON.stringify(targetUrl)});</script>`:''}${schemaJson?`<script type="application/ld+json">${schemaJson}</script>`:''}</head><body style="margin:0;padding:0;background:#f3f6f4;color:#18322d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><header style="background:#123d39;color:#fff;padding:14px 20px;"><div style="max-width:${type==='wiki'?'1440px':'860px'};margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 10px;"><a href="${origin()}/" style="color:#fff;text-decoration:none;font-weight:700;font-size:1.1rem;display:flex;align-items:center;gap:10px;"><img src="/favicon.svg" alt="Comunidad Sanantes" style="width:26px;height:26px;border-radius:6px;object-fit:contain;"> Comunidad Sanantes <span style="font-weight:400;opacity:0.85;font-size:0.9rem;">· El Podcast del Cáncer</span></a><a href="${sUrl}" style="background:#d65337;color:#fff;padding:7px 16px;border-radius:20px;text-decoration:none;font-size:0.85rem;font-weight:600;">Abrir en la app</a></div></header>${type==='wiki'?fullContentHtml:`<main style="max-width:860px;margin:32px auto;padding:0 16px;"><article style="background:#ffffff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(18,61,57,0.06);">${!type?`<div style="margin-bottom:16px;"><img src="/logo.png" alt="Comunidad Sanantes" style="height:54px;max-width:240px;object-fit:contain;display:block;"></div>`:''}${category?`<span style="display:inline-block;background:#e8f0ec;color:#123d39;padding:4px 12px;border-radius:12px;font-size:0.8rem;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">${escHtml(category)}</span>`:''}<h1 style="color:#123d39;font-size:1.75rem;margin:0 0 20px;line-height:1.35;letter-spacing:-0.3px;">${sTitle}</h1>${activeEmbed?`<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:10px;margin:0 0 24px;background:#000;"><iframe src="${activeEmbed}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`:`<div style="text-align:center;margin:0 0 24px;"><img src="${sImg}" alt="${sTitle}" style="max-width:100%;border-radius:10px;height:auto;"></div>`}<div style="background:#f7faf8;border-left:4px solid #123d39;padding:12px 18px;margin:20px 0;border-radius:0 8px 8px 0;font-size:0.85rem;color:#35534b;line-height:1.5;"><strong>Aviso médico informativo:</strong> Este contenido es de carácter divulgativo y de acompañamiento. No sustituye la consulta médica, el diagnóstico ni el tratamiento oncológico profesional.</div>${fullContentHtml}<div style="text-align:center;margin:36px 0 16px;padding-top:24px;border-top:1px solid #edf2ef;"><p style="color:#57746c;font-size:0.95rem;margin-bottom:14px;">Únete a la conversación, guarda tus favoritos y gana puntos en la comunidad.</p><a href="${sUrl}" style="display:inline-block;background:#d65337;color:#fff;font-weight:700;padding:13px 28px;border-radius:30px;text-decoration:none;font-size:1rem;box-shadow:0 3px 10px rgba(214,83,55,0.25);">Participar en Sanantes</a></div></article></main>`}<footer style="text-align:center;padding:24px 16px 40px;color:#6b877f;font-size:0.85rem;"><p style="margin:0 0 8px;">El Podcast del Cáncer · Un espacio de encuentro y esperanza.</p><p style="margin:0;"><a href="${origin()}/b/criterio-editorial" style="color:#1e6b42;font-weight:600;text-decoration:underline;">Criterio Editorial y Rigor Científico</a> &bull; <a href="${origin()}/wiki" style="color:#1e6b42;font-weight:600;text-decoration:none;">Wiki Sanantes</a> &bull; <a href="${origin()}/sitemap.xml" style="color:#6b877f;text-decoration:none;">Mapa del sitio</a> &bull; <a href="${origin()}/" style="color:#6b877f;text-decoration:none;">Inicio</a></p></footer></body></html>`);
    }
        if(path==='products'&&method==='GET'){return send(res,{ok:true,products:await query("SELECT * FROM products WHERE status='published' ORDER BY sort_order ASC, created_at DESC")});}
    if(path==='public'&&method==='GET'){
      const s=await settings();const [total]=await query('SELECT COALESCE(SUM(amount),0) total FROM donations');
      return send(res,{settings:s,donated:total.total,sources:await query('SELECT id,name,platform,url,own,last_sync FROM sources WHERE enabled=1'),videos:(await query("SELECT videos.*,sources.name source_name,sources.own FROM videos LEFT JOIN sources ON sources.id=videos.source_id WHERE videos.status='published' AND videos.kind IN ('video','live') ORDER BY featured DESC,published_at DESC LIMIT 300")).filter(v=>!exclusionReason(v)),posts:await query("SELECT * FROM posts WHERE status='published' ORDER BY updated_at DESC"),wikiCategories:await query("SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC"),wikiArticles:await query("SELECT id,slug,category,category_id,title,subtitle,evidence_level,excerpt,body,mechanisms,clinical_status,pubmed_citations,status,updated_at FROM wiki_articles WHERE status='published' ORDER BY title ASC"),products:await query("SELECT * FROM products WHERE status='published' ORDER BY sort_order ASC, created_at DESC"),me:await user(req),ranking:await getRanking()});
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
          return send(res,{isEditorOnly:true,role:'editor',wikiCategories:await query('SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC'),wikiArticles:await query('SELECT * FROM wiki_articles ORDER BY updated_at DESC'),products:await query('SELECT * FROM products ORDER BY sort_order ASC, updated_at DESC'),audit:await query("SELECT * FROM audit WHERE action LIKE 'Wiki%' ORDER BY created_at DESC LIMIT 30")});
        }
        return send(res,{role:'admin',wikiCategories:await query('SELECT * FROM wiki_categories ORDER BY sort_order ASC, name ASC'),wikiArticles:await query('SELECT * FROM wiki_articles ORDER BY updated_at DESC'),classifierReady:!!process.env.TYPESAFE_API_KEY,classifications:await query('SELECT * FROM classifications ORDER BY created_at DESC LIMIT 100'),sources:await query('SELECT * FROM sources ORDER BY own DESC,name'),videos:await query('SELECT videos.*,media_labels.relevance,media_labels.response editorial_response FROM videos LEFT JOIN media_labels ON videos.id=media_labels.video_id ORDER BY videos.published_at DESC LIMIT 1000'),posts:await query('SELECT * FROM posts ORDER BY updated_at DESC'),users:await query('SELECT users.id,users.email,users.name,users.role,users.created_at,COALESCE(SUM(points.amount),0) points FROM users LEFT JOIN points ON users.id=points.user_id GROUP BY users.id'),settings:await settings(),donations:await query('SELECT donations.*,users.name user_name,users.email user_email FROM donations LEFT JOIN users ON donations.user_id=users.id ORDER BY donations.created_at DESC'),products:await query('SELECT * FROM products ORDER BY sort_order ASC, updated_at DESC'),audit:await query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 50')});
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
            if(path==='admin/product'&&method==='POST'){
        const title=text(b.title,300),slug=text(b.slug,120);
        if(!title||!/^[-a-z0-9]+$/.test(slug)||!['draft','published'].includes(b.status))fail('Revisa el título, el slug y el estado del producto');
        const pId=b.id||id();
        const sortOrder=Number.isInteger(Number(b.sort_order))?Number(b.sort_order):0;
        await query(`INSERT INTO products(id,slug,category,title,subtitle,provider,affiliate_url,original_price,discount_code,image_url,badge,description,status,sort_order,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            slug=excluded.slug,category=excluded.category,title=excluded.title,subtitle=excluded.subtitle,provider=excluded.provider,
            affiliate_url=excluded.affiliate_url,original_price=excluded.original_price,discount_code=excluded.discount_code,
            image_url=excluded.image_url,badge=excluded.badge,description=excluded.description,status=excluded.status,sort_order=excluded.sort_order,updated_at=CURRENT_TIMESTAMP`,
          [pId,slug,text(b.category,80)||'Suplementos y Nutracéuticos',title,text(b.subtitle,300),text(b.provider,50)||'iHerb',text(b.affiliate_url,1000),text(b.original_price,40),text(b.discount_code,40)||'wUt7svK8',text(b.image_url,1000),text(b.badge,80),text(b.description,5000),b.status,sortOrder]
        );
        await audit(me.id,'Producto guardado: '+title);
        return send(res,{ok:true,id:pId});
      }
      if(path==='admin/product'&&method==='DELETE'){
        await query('DELETE FROM products WHERE id=?',[b.id]);
        await audit(me.id,'Producto eliminado: '+text(b.id,64));
        return send(res,{ok:true});
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
