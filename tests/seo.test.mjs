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
  assert.ok(html.includes('29054452') || html.includes('PubMed'), 'Debe citar papers indexados');
  assert.ok(html.includes('"@type":"ProfilePage"'), 'Debe incluir ProfilePage Schema');
});

test('Landing Hubs: /temas/medicamentos-reposicionados renderiza compendio de ivermectina y mebendazol', async () => {
  const res = await fetch(`${base}/api/temas/medicamentos-reposicionados`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Medicamentos Reposicionados'), 'Debe titular el compendio');
  assert.ok(html.includes('Ivermectina') && html.includes('Mebendazol'), 'Debe detallar principios activos');
  assert.ok(html.includes('32415487') || html.includes('PubMed'), 'Debe incluir referencias PubMed');
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

