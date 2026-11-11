import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

process.env.LOCAL_DATABASE_PATH = ':memory:';
process.env.DEV_AUTH = '1';
process.env.ADMIN_EMAIL = 'admin@example.test';
delete process.env.TURSO_DATABASE_URL;
delete process.env.VERCEL;

const {initialize} = await import('../scripts/init.mjs');
await initialize();

const {default: handler} = await import('../api/index.js');
const {query} = await import('../lib/db.mjs');

const server = createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.APP_ORIGIN = 'http://127.0.0.1:' + server.address().port;
const base = process.env.APP_ORIGIN;

after(() => server.close());

test('SEO: /robots.txt incluye Content-Signal y referencia al sitemap', async () => {
  const res = await fetch(`${base}/api/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const text = await res.text();
  assert.ok(text.includes('User-agent: *'));
  assert.ok(text.includes('Allow: /'));
  assert.ok(text.includes('Content-Signal: search=yes, ai-input=yes, ai-train=no'));
  assert.ok(text.includes('/sitemap.xml'));
});

test('SEO: /sitemap.xml genera sitemap con extensión de Google Video', async () => {
  const res = await fetch(`${base}/api/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const xml = await res.text();
  assert.ok(xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  assert.ok(xml.includes('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'));
  assert.ok(xml.includes('<video:video>'));
  assert.ok(xml.includes('<video:title>'));
  assert.ok(xml.includes('<video:thumbnail_loc>'));
  assert.ok(xml.includes('<loc>'));
});

test('SEO & GEO: /v/:id y /b/:slug inyectan Schema.org JSON-LD (VideoObject y Article)', async () => {
  const [vid] = await query("SELECT id FROM videos WHERE status='published' LIMIT 1");
  assert.ok(vid, 'Debe haber al menos un video publicado');

  const vRes = await fetch(`${base}/api/v/${vid.id}`);
  assert.equal(vRes.status, 200);
  const vHtml = await vRes.text();
  assert.ok(vHtml.includes('application/ld+json'));
  assert.ok(vHtml.includes('"@type":"VideoObject"'));
  assert.ok(vHtml.includes('"name":'));
  assert.ok(vHtml.includes('Comunidad Sanantes'));
  assert.ok(vHtml.includes('<article'));
  assert.ok(vHtml.includes('<h1'));
  assert.ok(vHtml.includes('Aviso médico informativo:'));

  // Insert a test published post if none exists
  await query("INSERT INTO posts(id,slug,title,excerpt,body,status,image) VALUES('seo-post','seo-post','Post SEO','Resumen SEO','Cuerpo informativo sobre oncologia','published','https://images.unsplash.com/photo-1') ON CONFLICT(id) DO NOTHING");
  const bRes = await fetch(`${base}/api/b/seo-post`);
  assert.equal(bRes.status, 200);
  const bHtml = await bRes.text();
  assert.ok(bHtml.includes('application/ld+json'));
  assert.ok(bHtml.includes('"@type":"Article"'));
  assert.ok(bHtml.includes('Comunidad y Divulgación de Acompañamiento'));
  assert.ok(bHtml.includes('Cuerpo informativo sobre oncologia'));
});

test('Etapa 5: Página institucional E-E-A-T /b/criterio-editorial activa con rigor científico', async () => {
  const res = await fetch(`${base}/api/b/criterio-editorial`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Criterio Editorial'), 'Debe titular Criterio Editorial');
  assert.ok(html.includes('PubMed'), 'Debe mencionar PubMed como fuente');
  assert.ok(html.includes('Aviso médico informativo:'), 'Debe incluir disclaimer YMYL');
  assert.ok(html.includes('"@type":"Article"'), 'Debe incluir esquema Article');
});

test('Etapa 5: Malla de clústeres temáticos enlazada en /v/:id', async () => {
  const [vid] = await query("SELECT id FROM videos WHERE status='published' LIMIT 1");
  const res = await fetch(`${base}/api/v/${vid.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('aria-label="Contenidos relacionados"'), 'Debe incluir bloque de contenidos relacionados');
  assert.ok(html.includes('Investigaciones y contenidos relacionados'), 'Debe titular la sección de clúster');
});

test('Landing Hubs: /autores/william-makis renderiza monografía E-E-A-T y ProfilePage Schema', async () => {
  const res = await fetch(`${base}/api/autores/william-makis`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Dr. William Makis en Español'), 'Debe incluir título especializado');
  assert.ok(html.includes('McGill University'), 'Debe detallar credenciales médicas');
  assert.ok(html.includes('29257278') || html.includes('PubMed'), 'Debe citar papers indexados');
  assert.ok(html.includes('"@type":"ProfilePage"'), 'Debe incluir ProfilePage Schema');
});

test('Landing Hubs: /temas/medicamentos-reposicionados renderiza compendio de ivermectina y mebendazol', async () => {
  const res = await fetch(`${base}/api/temas/medicamentos-reposicionados`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Medicamentos Reposicionados'), 'Debe titular el compendio');
  assert.ok(html.includes('Ivermectina') && html.includes('Mebendazol'), 'Debe detallar principios activos');
  assert.ok(html.includes('32474842') || html.includes('PubMed'), 'Debe incluir referencias PubMed');
});

test('SEO: sitemap.xml incluye landing hubs de autores y temas con alta prioridad', async () => {
  const res = await fetch(`${base}/api/sitemap.xml`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.ok(xml.includes('/autores/william-makis'), 'Sitemap debe listar /autores/william-makis');
  assert.ok(xml.includes('/temas/medicamentos-reposicionados'), 'Sitemap debe listar /temas/medicamentos-reposicionados');
  assert.ok(xml.includes('/temas/estrategia-metabolica'), 'Sitemap debe listar /temas/estrategia-metabolica');
});

test('SEO Técnico: SSR incluye favicon, apple-touch-icon, logo en Organization Schema y longitudes óptimas', async () => {
  // Test a wiki article
  await query("INSERT INTO wiki_articles(id,slug,category,title,subtitle,excerpt,body,status) VALUES('test-art','test-art','Suplementos','Título de Prueba para Monografía Científica','Subtítulo','Breve resumen de prueba para verificar longitudes y metadatos','Cuerpo de la monografía','published') ON CONFLICT(id) DO NOTHING");
  const res = await fetch(`${base}/api/wiki/test-art`);
  assert.equal(res.status, 200);
  const html = await res.text();

  // 1. Favicon & Apple Touch Icon
  assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'), 'Debe incluir favicon SVG');
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/logo.png">'), 'Debe incluir apple-touch-icon');

  // 2. Organization Schema with Logo
  assert.ok(html.includes('"publisher":{'), 'Debe incluir publisher');
  assert.ok(html.includes('"@type":"CommunityOrganization"'), 'Publisher debe ser CommunityOrganization');
  assert.ok(html.includes('"logo":{'), 'Organization debe incluir logo requerido');
  assert.ok(html.includes('/logo.png'), 'Logo debe apuntar a /logo.png');

  // 3. Length checks
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(titleMatch, 'Debe haber etiqueta <title>');
  assert.ok(titleMatch[1].length <= 60, `Título (${titleMatch[1].length}) no debe exceder 60 caracteres`);

  const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
  // 4. Article Schema Completeness (Google Rich Results / GSC Wizard)
  assert.ok(html.includes('"@type":"Article"'), 'Debe ser schema Article');
  assert.ok(html.includes('"datePublished":'), 'Debe incluir datePublished');
  assert.ok(html.includes('"dateModified":'), 'Debe incluir dateModified');
  assert.ok(html.includes('"author":{'), 'Debe incluir author');
  assert.ok(html.includes('"image":['), 'Debe incluir image array');
  assert.ok(html.includes('"mainEntityOfPage":{'), 'Debe incluir mainEntityOfPage');
});

test('SEO Técnico Sprint 1: player_loc en sitemap, títulos sin "...", un H1 en Makis y redirects 301', async () => {
  const smRes = await fetch(`${base}/api/sitemap.xml`);
  assert.equal(smRes.status, 200);
  const smXml = await smRes.text();
  const blocks = [...smXml.matchAll(/<video:video>([\s\S]*?)<\/video:video>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, 'Debe haber videos en sitemap');
  for (const b of blocks) {
    assert.match(b, /<video:player_loc>https:\/\/[^<]+<\/video:player_loc>/, 'Cada video en sitemap debe incluir player_loc');
  }

  const makisRes = await fetch(`${base}/api/autores/william-makis`);
  assert.equal(makisRes.status, 200);
  const makisHtml = await makisRes.text();
  const makisTitle = makisHtml.match(/<title>([^<]+)<\/title>/)?.[1] || '';
  assert.ok(!makisTitle.endsWith('...'), 'Título de Makis no debe truncarse con ...');
  assert.equal([...makisHtml.matchAll(/<h1[^>]*>/gi)].length, 1, 'Makis debe tener exactamente un <h1>');

  const longTitle = '¿IVERMECTINA & MEBENDAZOL? El estudio clínico observacional completo sobre cáncer';
  await query("INSERT INTO wiki_articles(id,slug,category,title,subtitle,excerpt,body,status) VALUES('test-long','test-long','Medicamentos Reposicionados',?,'Sub','Resumen','Cuerpo','published') ON CONFLICT(id) DO NOTHING", [longTitle]);
  const longRes = await fetch(`${base}/api/wiki/test-long`);
  assert.equal(longRes.status, 200);
  const longHtml = await longRes.text();
  const rawTitle = longHtml.match(/<title>([^<]+)<\/title>/)?.[1] || '';
  const renderedTitle = rawTitle.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  assert.ok(!renderedTitle.endsWith('...'), 'Título largo no debe terminar en ...');
  assert.ok(renderedTitle.length <= 60, `Título <title> de wiki debe medir <= 60 chars, midió ${renderedTitle.length}`);
  assert.ok(longHtml.includes('cáncer</h1>') || longHtml.includes('sobre cáncer'), 'H1 editorial debe conservar el título completo');

  const { readFileSync } = await import('node:fs');
  const vercelCfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const wikiSlash = vercelCfg.redirects?.find(r => r.source === '/wiki/');
  assert.deepEqual(wikiSlash, { source: '/wiki/', destination: '/wiki', statusCode: 301 }, 'Debe existir redirect 301 de /wiki/ a /wiki');
});

test('SEO Técnico Sprint 2: HTTP 404 real y noindex en rutas inexistentes (sin Soft 404)', async () => {
  const notFoundPaths = [
    '/api/index?route=preview&notfound=1',
    '/api/v/video-inexistente-xyz',
    '/api/b/post-inexistente-xyz',
    '/api/wiki/articulo-inexistente-xyz',
    '/api/autores/autor-inexistente-xyz',
    '/api/temas/tema-inexistente-xyz'
  ];
  for (const p of notFoundPaths) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, `${p} debe devolver HTTP 404`);
    const html = await r.text();
    assert.ok(html.includes('<meta name="robots" content="noindex, follow">'), `${p} debe incluir noindex`);
    assert.ok(!html.includes('<link rel="canonical"'), `${p} no debe emitir canonical a la home`);
    assert.ok(html.includes('Página no encontrada (404)'), `${p} debe mostrar mensaje 404`);
  }

  const { readFileSync } = await import('node:fs');
  const vercelCfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rootRewrite = vercelCfg.rewrites?.find(r => r.source === '/');
  const catchAll = vercelCfg.rewrites?.[vercelCfg.rewrites.length - 1];
  assert.deepEqual(rootRewrite, { source: '/', destination: '/index.html' }, 'La raíz / debe servir /index.html');
  assert.equal(catchAll?.destination, '/api/index?route=preview&notfound=1', 'El catch-all debe devolver preview 404');
});

test('SEO Técnico Sprint 3: Deduplicación od/yt, BreadcrumbList y autor Person E-E-A-T', async () => {
  await query("INSERT INTO sources(id,name,platform,url,own) VALUES('src-yt-dup','YT','youtube','https://youtube.com/@test',1),('src-od-dup','OD','odysee','https://odysee.com/@test',1) ON CONFLICT(id) DO NOTHING");
  await query("INSERT INTO videos(id,source_id,platform,external_id,title,description,url,published_at,kind,status) VALUES('yt-dup-test','src-yt-dup','youtube','ytDup123','Episodio Duplicado Estrategia Metabólica 🌿🕊️','Desc YT','https://youtube.com/watch?v=ytDup123','2026-09-10T10:00:00Z','video','published'),('od-dup-test','src-od-dup','odysee','odDup123','Episodio Duplicado Estrategia Metabólica 🌿🤍','Desc OD','https://odysee.com/@test/ep:1','2026-09-10T10:00:00Z','video','published') ON CONFLICT(id) DO NOTHING");

  const smXml = await (await fetch(`${base}/api/sitemap.xml`)).text();
  assert.ok(smXml.includes('/v/yt-dup-test'), 'Sitemap debe incluir versión YouTube canónica');
  assert.ok(!smXml.includes('/v/od-dup-test'), 'Sitemap debe omitir espejo duplicado Odysee');

  const odRes = await fetch(`${base}/api/v/od-dup-test`, { redirect: 'manual' });
  assert.equal(odRes.status, 301, 'Espejo duplicado Odysee debe redirigir con 301 al YouTube ganador');
  assert.equal(odRes.headers.get('location'), `${base}/v/yt-dup-test`, 'Location 301 debe apuntar al vídeo canónico');

  for (const p of ['/api/v/yt-dup-test', '/api/b/seo-post', '/api/wiki/test-art', '/api/autores/william-makis', '/api/temas/medicamentos-reposicionados']) {
    const html = await (await fetch(`${base}${p}`)).text();
    assert.ok(html.includes('"@type":"BreadcrumbList"'), `${p} debe incluir BreadcrumbList`);
  }

  const wikiHtml = await (await fetch(`${base}/api/wiki/test-art`)).text();
  assert.ok(wikiHtml.includes('"author":{"@type":"Person"'), 'Article.author debe ser Person');
  assert.ok(wikiHtml.includes('/b/criterio-editorial'), 'Autor Person debe enlazar a criterio-editorial');
});

test('SEO Técnico Sprint 4: Directorios SSR /podcast y /blog anti-huérfanas y optimización de /api/public', async () => {
  const catRes = await fetch(`${base}/api/index?route=preview&type=catalog`);
  assert.equal(catRes.status, 200);
  const catHtml = await catRes.text();
  assert.ok(catHtml.includes(`<link rel="canonical" href="${base}/podcast">`));
  assert.ok(catHtml.includes('/v/yt-dup-test'), '/podcast debe enlazar episodios canónicos');
  assert.ok(!catHtml.includes('/v/od-dup-test'), '/podcast no debe enlazar espejos duplicados');
  assert.ok(catHtml.includes('"@type":"BreadcrumbList"'));

  const blogRes = await fetch(`${base}/api/index?route=preview&type=bloghub`);
  assert.equal(blogRes.status, 200);
  const blogHtml = await blogRes.text();
  assert.ok(blogHtml.includes(`<link rel="canonical" href="${base}/blog">`));
  assert.ok(blogHtml.includes('/b/seo-post'), '/blog debe enlazar entradas publicadas');
  assert.ok(blogHtml.includes('/b/criterio-editorial'));

  const smXml = await (await fetch(`${base}/api/sitemap.xml`)).text();
  assert.ok(smXml.includes(`<loc>${base}/podcast</loc>`));
  assert.ok(smXml.includes(`<loc>${base}/blog</loc>`));

  await query("INSERT INTO posts(id,slug,title,excerpt,body,status,image) VALUES('img-post','img-post','Post Base64','Resumen','Cuerpo','published','data:image/png;base64,iVBORw0KGgo=') ON CONFLICT(id) DO NOTHING");
  const pubRes = await fetch(`${base}/api/public`);
  assert.equal(pubRes.status, 200);
  assert.match(pubRes.headers.get('cache-control') || '', /public, max-age=30/);
  assert.match(pubRes.headers.get('vary') || '', /Cookie/i);
  const pubJson = await pubRes.json();
  const imgPost = pubJson.posts.find(p => p.slug === 'img-post');
  assert.equal(imgPost?.image, '/b/img-post/image', '/api/public debe servir URL /b/:slug/image en lugar de base64 inline');
});

test('SEO Técnico Sprint 5: <title> <= 60 sin elipsis vs H1 íntegro, dimensiones CLS, fuente externa en /v/ y /blog >= 300 palabras', async () => {
  await query("INSERT INTO videos(id,external_id,platform,title,description,url,thumbnail,kind,category,status,published_at) VALUES('vid-ellipsis-s5','vid-ellipsis-s5','odysee','Experta oncóloga: Cada día la gente se alimenta peor y no me gusta nada...','Resumen de entrevista sobre nutrición y estrategia metabólica.','https://odysee.com/@Sanantes:1/experta-oncologa','https://thumbnails.lbry.com/test123','video','Oncología','published','2026-11-11T10:00:00Z') ON CONFLICT(id) DO NOTHING");
  const vRes = await fetch(`${base}/api/v/vid-ellipsis-s5`);
  assert.equal(vRes.status, 200);
  const vHtml = await vRes.text();
  const vTitle = vHtml.match(/<title>(.*?)<\/title>/)?.[1] || '';
  assert.ok(vTitle.length > 0 && vTitle.length <= 60, `title de /v/ debe medir <= 60 chars, midió ${vTitle.length}: ${vTitle}`);
  assert.ok(!/(\.\.\.|…)$/.test(vTitle) && !vTitle.includes('...'), 'title no debe contener elipsis literal ...');
  assert.ok(vHtml.includes('<h1'), 'Debe renderizar H1');
  assert.ok(vHtml.includes('Experta oncóloga: Cada día la gente se alimenta peor y no me gusta nada</h1>'), 'H1 debe conservar título completo limpio');
  assert.ok(vHtml.includes('href="https://odysee.com/@Sanantes:1/experta-oncologa"'), 'Ficha /v/ debe incluir enlace externo visible a la fuente');
  assert.ok(vHtml.includes('rel="noopener noreferrer"'), 'Enlace externo en /v/ debe incluir rel="noopener noreferrer"');

  const homeHtml = await (await fetch(`${base}/api/index?route=preview`)).text();
  const homeTitle = homeHtml.match(/<title>(.*?)<\/title>/)?.[1] || '';
  assert.ok(homeTitle.length > 0 && homeTitle.length <= 60, `Home title <= 60 chars: ${homeTitle.length}`);
  assert.ok(homeHtml.includes('width="240" height="54"'), 'Logo principal debe tener width y height');
  assert.ok(homeHtml.includes('width="480" height="360" loading="lazy"'), 'Tarjetas deben tener dimensiones y loading="lazy"');

  const blogHtml = await (await fetch(`${base}/api/index?route=preview&type=bloghub`)).text();
  const mainBlock = (blogHtml.match(/<main[\s\S]*?<\/main>/)?.[0] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = mainBlock.split(' ').filter(Boolean);
  assert.ok(words.length >= 300, `/blog debe tener >= 300 palabras para evitar contenido fino, tiene ${words.length}`);

  const { readFileSync } = await import('node:fs');
  const shellHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const shellTitle = shellHtml.match(/<title>(.*?)<\/title>/)?.[1] || '';
  assert.ok(shellTitle.length > 0 && shellTitle.length <= 60, `public/index.html title <= 60 chars: ${shellTitle.length}`);
  assert.ok(shellHtml.includes('width="240" height="54"'), 'public/index.html logo debe tener width y height');
  assert.ok(shellHtml.includes('width="480" height="360" loading="lazy" decoding="async"'), 'public/index.html tarjetas deben tener width, height y loading="lazy"');
});

test('SEO Técnico Sprint 6 - Frente 1: /api/public aligerado sin body/descripción larga y endpoints de detalle bajo demanda', async () => {
  const longText = 'A'.repeat(1200);
  await query("INSERT INTO videos(id,external_id,platform,title,description,url,thumbnail,kind,category,status,published_at) VALUES('vid-heavy-s6','vid-heavy-s6','youtube','Video Pesado S6',?,'https://youtube.com/watch?v=vid-heavy-s6','','video','Investigación','published','2026-11-11T12:00:00Z') ON CONFLICT(id) DO NOTHING", [longText]);
  await query("INSERT INTO posts(id,slug,title,excerpt,body,status) VALUES('post-heavy-s6','post-heavy-s6','Post Pesado S6','Resumen corto',?,'published') ON CONFLICT(id) DO NOTHING", [longText]);
  await query("INSERT INTO wiki_articles(id,slug,category,title,subtitle,excerpt,body,mechanisms,clinical_status,status) VALUES('wiki-heavy-s6','wiki-heavy-s6','Terapias','Wiki Pesada S6','Sub','Resumen corto',?,'Mecanismos completos','Estado clínico','published') ON CONFLICT(id) DO NOTHING", [longText]);

  const pubRes = await fetch(`${base}/api/public`);
  assert.equal(pubRes.status, 200);
  const pubJson = await pubRes.json();

  const pubVid = pubJson.videos.find(v => v.id === 'vid-heavy-s6');
  assert.ok(pubVid, 'Video S6 debe existir en /api/public');
  assert.ok(pubVid.description.length <= 245, `/api/public debe recortar descripción larga, midió ${pubVid.description.length}`);

  const pubPost = pubJson.posts.find(p => p.slug === 'post-heavy-s6');
  assert.ok(pubPost, 'Post S6 debe existir en /api/public');
  assert.equal(pubPost.body, undefined, '/api/public no debe incluir posts.body');

  const pubWiki = pubJson.wikiArticles.find(w => w.slug === 'wiki-heavy-s6');
  assert.ok(pubWiki, 'Wiki S6 debe existir en /api/public');
  assert.equal(pubWiki.body, undefined, '/api/public no debe incluir wikiArticles.body');

  const detVid = await (await fetch(`${base}/api/public/video?id=vid-heavy-s6`)).json();
  assert.equal(detVid.video?.description?.length, 1200, 'Detalle /api/public/video debe devolver descripción íntegra');

  const detPost = await (await fetch(`${base}/api/public/post?slug=post-heavy-s6`)).json();
  assert.equal(detPost.post?.body?.length, 1200, 'Detalle /api/public/post debe devolver body íntegro');

  const detWiki = await (await fetch(`${base}/api/public/wiki?slug=wiki-heavy-s6`)).json();
  assert.equal(detWiki.article?.body?.length, 1200, 'Detalle /api/public/wiki debe devolver body íntegro');
  assert.equal(detWiki.article?.mechanisms, 'Mecanismos completos');
});

test('SEO Técnico Sprint 6 - Frente 2: Legibilidad móvil >= 14px y targets táctiles >= 36-44px', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('min-height:40px'), 'styles.css móvil debe definir min-height:40px para targets táctiles');
  assert.ok(css.includes('min-width:44px;min-height:44px'), 'Botón menú móvil debe medir >= 44x44px');
  assert.ok(css.includes('font-size:0.875rem'), 'styles.css móvil debe elevar textos secundarios a >= 0.875rem (14px)');

  const homeHtml = await (await fetch(`${base}/api/index?route=preview`)).text();
  assert.ok(homeHtml.includes('min-height:40px'), 'SSR debe incluir reglas móviles con min-height:40px en enlaces');
  assert.ok(homeHtml.includes('font-size:0.9375rem'), 'SSR debe elevar tipografía móvil a >= 15px (0.9375rem)');
});

test('SEO Técnico Sprint 6 - Frente 3: Cabeceras HSTS y Content-Security-Policy válidas en vercel.json', async () => {
  const { readFileSync } = await import('node:fs');
  const vercelCfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const globalHeaders = vercelCfg.headers?.[0]?.headers || [];
  const csp = globalHeaders.find(h => h.key === 'Content-Security-Policy')?.value || '';
  const hsts = globalHeaders.find(h => h.key === 'Strict-Transport-Security')?.value || '';
  assert.ok(hsts.includes('max-age=63072000'), 'Debe incluir HSTS >= 2 años');
  assert.ok(csp.includes("default-src 'self'"), 'Debe incluir CSP default-src self');
  assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP debe impedir clickjacking');
  assert.ok(csp.includes('youtube-nocookie.com') && csp.includes('odysee.com'), 'CSP debe permitir embeds de video');
});

test('SEO Técnico Sprint 6 - Frente 4: Backfill de duration para los 4 vídeos de YouTube sin duración en sitemap', async () => {
  await query("INSERT INTO videos(id,platform,external_id,title,description,url,thumbnail,kind,category,status,duration,published_at) VALUES('vid-nodur-s6','youtube','b3jwbY2MAQA','Cáncer, Arte y Ciencia','Desc','https://www.youtube.com/watch?v=b3jwbY2MAQA','','video','Investigación','published',0,'2026-11-11T11:00:00Z') ON CONFLICT(id) DO UPDATE SET duration=0");
  const smXml = await (await fetch(`${base}/api/sitemap.xml`)).text();
  const block = smXml.split('<url>').find(u => u.includes('/v/vid-nodur-s6')) || '';
  assert.ok(block.includes('<video:duration>1699</video:duration>'), 'Sitemap debe resolver y emitir video:duration=1699 para b3jwbY2MAQA');
  const pubJson = await (await fetch(`${base}/api/public`)).json();
  const v = pubJson.videos.find(x => x.id === 'vid-nodur-s6');
  assert.equal(v?.duration, 1699, '/api/public debe devolver duration resuelta (1699)');
});

