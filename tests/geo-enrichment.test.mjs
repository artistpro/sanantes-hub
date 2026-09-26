import test from 'node:test';
import assert from 'node:assert/strict';
import { getGeoEnrichment, renderGeoHtml } from '../lib/geo-enrichment.mjs';

test('GEO: getGeoEnrichment identifica videos clave y extrae citas y fuentes PubMed', () => {
  const vidIver = {
    id: 'od-a14273cead44bf4b87b69500235bc4eac5692ff1',
    title: '¿IVERMECTINA & MEBENDAZOL? El estudio que podría cambiar el cáncer para siempre',
    description: 'Estudio observacional...'
  };
  const enrichIver = getGeoEnrichment(vidIver);
  assert.ok(enrichIver, 'Debe encontrar enriquecimiento para ivermectina');
  assert.ok(enrichIver.quotation.text.length > 20, 'Debe incluir cita textual');
  assert.ok(enrichIver.sources.length >= 2, 'Debe incluir al menos 2 fuentes indexadas');
  assert.ok(enrichIver.sources[0].pmid || enrichIver.sources[0].url.includes('pubmed'), 'Debe referenciar PubMed');
  assert.ok(enrichIver.takeaways.length >= 2, 'Debe incluir puntos clave con datos');

  const html = renderGeoHtml(enrichIver);
  assert.ok(html.includes('<blockquote'), 'HTML debe renderizar blockquote para citaciones');
  assert.ok(html.includes('pubmed.ncbi.nlm.nih.gov'), 'HTML debe incluir enlaces a fuentes científicas');
  assert.ok(html.includes('Fuentes científicas de referencia'), 'HTML debe titular las referencias');
});

test('GEO: getGeoEnrichment identifica videos de estrategia metabólica y Dr. Seyfried', () => {
  const vidSeyfried = {
    id: 'yt-VChTote173E',
    title: 'Así Descubrí el SECRETO de la Estrategia Metabólica 😱',
    description: 'Efecto warburg y cetosis...'
  };
  const enrich = getGeoEnrichment(vidSeyfried);
  assert.ok(enrich, 'Debe encontrar enriquecimiento para estrategia metabólica');
  assert.ok(enrich.quotation.author.includes('Seyfried'), 'Debe citar al Dr. Seyfried');
  assert.ok(enrich.sources.some(s => s.title.includes('Seyfried') || s.url.includes('pubmed')), 'Debe tener fuente de Seyfried');
});

test('GEO: getGeoEnrichment identifica videos del Dr. William Makis y oncología integrativa', () => {
  const vidMakis = {
    id: 'a39c7bf6-a2a3-4565-8a82-0b52566e5d94',
    title: 'CÁNCER: El Fármaco que la CENSURA OCULTÓ (Dr. Makis) ⚠️',
    description: 'El Dr. William Makis profundiza en más de 100 publicaciones sobre ivermectina...'
  };
  const enrich = getGeoEnrichment(vidMakis);
  assert.ok(enrich, 'Debe encontrar enriquecimiento para Dr. Makis');
  assert.ok(enrich.quotation.author.includes('Makis'), 'Debe citar al Dr. William Makis');
  assert.ok(enrich.sources.some(s => s.title.includes('stem-like') || s.url.includes('pubmed')), 'Debe tener fuentes indexadas sobre células madre o drug repurposing');
  const html = renderGeoHtml(enrich);
  assert.ok(html.includes('William Makis'), 'HTML debe incluir al autor en la cita');
});

