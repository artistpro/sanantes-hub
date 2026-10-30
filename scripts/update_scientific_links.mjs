import fs from 'node:fs';
import path from 'node:path';

const apiFile = path.resolve('d:/Descargas 2/Antigravity/sananteshub/api/index.js');
let apiContent = fs.readFileSync(apiFile, 'utf8');

// 1. Add pubmedMetadata loader to api/index.js if not present
if (!apiContent.includes('pubmedMetadata')) {
  const targetImport = "import {classificationDefaults,classifierSettings,classify,classifyPending} from '../lib/classifier.mjs';";
  const replacementImport = `import {classificationDefaults,classifierSettings,classify,classifyPending} from '../lib/classifier.mjs';\r\nimport fs from 'node:fs';\r\nlet pubmedMetadata = {};\r\ntry {\r\n  pubmedMetadata = JSON.parse(fs.readFileSync(new URL('../lib/pubmed-metadata.json', import.meta.url), 'utf8'));\r\n} catch(e) {\r\n  pubmedMetadata = {};\r\n}`;
  apiContent = apiContent.replace(targetImport, replacementImport);
}

// 2. Correct /autores/william-makis citations in api/index.js
const oldMakisSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Ivermectin as an inhibitor of cancer stem-like cells</strong> &mdash; <em>Pharmacological Research</em> (PMID: 29054452) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/29054452/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Repurposing Ivermectin for Cancer Treatment: Preclinical and Clinical Evidence</strong> &mdash; <em>Frontiers in Pharmacology</em> (PMID: 33633575) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/33633575/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a candidate for drug repurposing in oncology</strong> &mdash; <em>Cancers</em> (PMID: 31080350) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31080350/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>`;

const newMakisSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Ivermectin as an inhibitor of cancer stem-like cells</strong> &mdash; <em>Molecular Medicine Reports (2018)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 29257278</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/29257278/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">The multitargeted drug ivermectin: from an antiparasitic agent to a repositioned cancer drug</strong> &mdash; <em>Pharmacological Research (2018)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 29511601</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/29511601/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a Candidate for Drug Repurposing in Oncology: An Extensive Review</strong> &mdash; <em>Cancers (2019)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 31480477</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31480477/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>`;

if (apiContent.includes(oldMakisSection)) {
  apiContent = apiContent.replace(oldMakisSection, newMakisSection);
  console.log('Updated /autores/william-makis citations');
} else {
  console.log('Makis section already updated or formatted differently');
}

// 3. Correct /temas/medicamentos-reposicionados citations in api/index.js
const oldRepSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Antitumor effects of ivermectin: Mechanisms and clinical implications</strong> &mdash; <em>IJMS</em> (PMID: 32415487) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/32415487/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 32415487 &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a candidate for drug repurposing in oncology</strong> &mdash; <em>Cancers</em> (PMID: 31080350) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31080350/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 31080350 &rarr;</a></li>`;

const newRepSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Antitumor effects of ivermectin at clinically feasible concentrations support its clinical development</strong> &mdash; <em>Cancer Chemotherapy and Pharmacology (2020)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 32474842</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/32474842/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Mebendazole as a Candidate for Drug Repurposing in Oncology: An Extensive Review</strong> &mdash; <em>Cancers (2019)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 31480477</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31480477/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>`;

if (apiContent.includes(oldRepSection)) {
  apiContent = apiContent.replace(oldRepSection, newRepSection);
  console.log('Updated /temas/medicamentos-reposicionados citations');
} else {
  console.log('Medicamentos reposicionados section already updated or formatted differently');
}

// 4. Correct /temas/estrategia-metabolica citations in api/index.js
const oldMetaSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Cancer as a metabolic disease: implications for novel therapeutics</strong> &mdash; <em>Carcinogenesis</em> (PMID: 24657584) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/24657584/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 24657584 &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Press-pulse: a novel strategy for the metabolic management of cancer</strong> &mdash; <em>Nutrition & Metabolism</em> (PMID: 31804968) &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/31804968/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">PubMed 31804968 &rarr;</a></li>`;

const newMetaSection = `<li style="margin-bottom:10px;"><strong style="color:#183d35;">Cancer as a metabolic disease: implications for novel therapeutics</strong> &mdash; <em>Carcinogenesis (2014)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 24343361</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/24343361/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\r\n            <li style="margin-bottom:10px;"><strong style="color:#183d35;">Press-pulse: a novel strategy for the metabolic management of cancer</strong> &mdash; <em>Nutrition & Metabolism (2017)</em> &bull; <span style="color:#496b63;font-size:0.9rem;">PMID: 28250801</span> &bull; <a href="https://pubmed.ncbi.nlm.nih.gov/28250801/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>`;

if (apiContent.includes(oldMetaSection)) {
  apiContent = apiContent.replace(oldMetaSection, newMetaSection);
  console.log('Updated /temas/estrategia-metabolica citations');
} else {
  console.log('Estrategia metabólica section already updated or formatted differently');
}

// 5. Enrich pubmedHtml in api/index.js
const oldPubmedHtmlCode = `            if(citations.length > 0){\r\n              pubmedHtml = \`<div id="referencias" style="margin:28px 0;background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:20px;">\r\n                <h3 style="color:#123d39;margin:0 0 14px;font-size:1.15rem;display:flex;align-items:center;gap:8px;">📚 Referencias y Evidencia en MEDLINE / PubMed</h3>\r\n                <ul style="margin:0;padding-left:20px;line-height:1.8;">\r\n                  \${citations.map(c => \`<li style="margin-bottom:8px;"><strong style="color:#183d35;">PMID: \${escHtml(c)}</strong> &mdash; <a href="https://pubmed.ncbi.nlm.nih.gov/\${encodeURIComponent(c)}/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\`).join('')}\r\n                </ul>\r\n              </div>\`;\r\n            }`;

const newPubmedHtmlCode = `            if(citations.length > 0){\r\n              pubmedHtml = \`<div id="referencias" style="margin:28px 0;background:#f8faf9;border:1px solid #dce8df;border-radius:10px;padding:20px;">\r\n                <h3 style="color:#123d39;margin:0 0 14px;font-size:1.15rem;display:flex;align-items:center;gap:8px;">📚 Referencias y Evidencia en MEDLINE / PubMed</h3>\r\n                <ul style="margin:0;padding-left:20px;line-height:1.8;">\r\n                  \${citations.map(c => {\r\n                    const meta = pubmedMetadata[c];\r\n                    return \`<li style="margin-bottom:12px;">\${meta ? \`<strong style="color:#183d35;">\${escHtml(meta.title)}</strong>\${meta.journal ? \` &mdash; <em>\${escHtml(meta.journal)}\${meta.year ? \` (\${escHtml(meta.year)})\` : ''}</em>\` : ''} &bull; \` : ''}<span style="color:#496b63;font-size:0.9rem;">PMID: \${escHtml(c)}</span> &mdash; <a href="https://pubmed.ncbi.nlm.nih.gov/\${encodeURIComponent(c)}/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio en PubMed &rarr;</a></li>\`;\r\n                  }).join('')}\r\n                </ul>\r\n              </div>\`;\r\n            }`;

if (apiContent.includes(oldPubmedHtmlCode)) {
  apiContent = apiContent.replace(oldPubmedHtmlCode, newPubmedHtmlCode);
  console.log('Enriched pubmedHtml rendering in api/index.js');
} else {
  console.log('pubmedHtml already updated or formatted differently');
}

// 6. Include pubmedMetadata in api/public response
const oldPublicSend = "me:await user(req),ranking:await getRanking()});";
const newPublicSend = "me:await user(req),ranking:await getRanking(),pubmedMetadata});";
if (apiContent.includes(oldPublicSend)) {
  apiContent = apiContent.replace(oldPublicSend, newPublicSend);
  console.log('Added pubmedMetadata to public endpoint response in api/index.js');
}

fs.writeFileSync(apiFile, apiContent, 'utf8');
console.log('Finished updating api/index.js');

// 7. Enrich public/app.js client-side rendering
const appFile = path.resolve('d:/Descargas 2/Antigravity/sananteshub/public/app.js');
let appContent = fs.readFileSync(appFile, 'utf8');

const oldAppPubmed = `pubmed.map(c=>\`<li><strong>PMID: \${esc(c)}</strong> &mdash; <a href="https://pubmed.ncbi.nlm.nih.gov/\${encodeURIComponent(c)}/" target="_blank" rel="noopener noreferrer">Ver estudio indexado en PubMed →</a></li>\`).join('')`;

const newAppPubmed = `pubmed.map(c=>{const meta=(data.pubmedMetadata||{})[c];return \`<li style="margin-bottom:12px;">\${meta?\`<strong style="color:#183d35;">\${esc(meta.title)}</strong>\${meta.journal?\` &mdash; <em>\${esc(meta.journal)}\${meta.year?\` (\${esc(meta.year)})\`:''}</em>\`:''} &bull; \`:''}<span style="color:#496b63;font-size:0.9rem;">PMID: \${esc(c)}</span> &mdash; <a href="https://pubmed.ncbi.nlm.nih.gov/\${encodeURIComponent(c)}/" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;font-weight:600;">Ver estudio indexado en PubMed →</a></li>\`;}).join('')`;

if (appContent.includes(oldAppPubmed)) {
  appContent = appContent.replace(oldAppPubmed, newAppPubmed);
  fs.writeFileSync(appFile, appContent, 'utf8');
  console.log('Enriched client-side citation rendering in public/app.js');
}

// 8. Update tests/seo.test.mjs assertions
const seoTestFile = path.resolve('d:/Descargas 2/Antigravity/sananteshub/tests/seo.test.mjs');
let seoTestContent = fs.readFileSync(seoTestFile, 'utf8');

seoTestContent = seoTestContent.replace(
  "assert.ok(html.includes('29054452') || html.includes('PubMed'), 'Debe citar papers indexados');",
  "assert.ok(html.includes('29257278') || html.includes('PubMed'), 'Debe citar papers indexados');"
);

seoTestContent = seoTestContent.replace(
  "assert.ok(html.includes('32415487') || html.includes('PubMed'), 'Debe incluir referencias PubMed');",
  "assert.ok(html.includes('32474842') || html.includes('PubMed'), 'Debe incluir referencias PubMed');"
);

fs.writeFileSync(seoTestFile, seoTestContent, 'utf8');
console.log('Updated tests/seo.test.mjs');
