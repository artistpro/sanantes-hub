const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const KNOWLEDGE_BASE = {
  makis: {
    matchers: ['makis', 'william makis', 'dr. makis', 'dr makis'],
    quotation: {
      text: 'La investigación en oncología integrativa y medicina repurposed explora cómo la ivermectina puede modular vías de resistencia a múltiples fármacos (MDR) y actuar contra subpoblaciones de células madre tumorales.',
      author: 'Dr. William Makis, MD, Especialista en Oncología y Radiología'
    },
    takeaways: [
      'Análisis de publicaciones preclínicas sobre el reposicionamiento de ivermectina y agentes complementarios en oncología integrativa.',
      'Mecanismos moleculares evaluados: inhibición de la glicoproteína P (P-gp), inducción de mitofagia y modulación del microambiente inmunológico.',
      'Divulgación científica en español para pacientes y profesionales interesados en protocolos basados en evidencia y supervisión clínica especializada.'
    ],
    sources: [
      {
        title: 'Ivermectin as an inhibitor of cancer stem-like cells',
        journal: 'Pharmacological Research',
        pmid: '29054452',
        url: 'https://pubmed.ncbi.nlm.nih.gov/29054452/'
      },
      {
        title: 'Repurposing Ivermectin for Cancer Treatment: Preclinical and Clinical Evidence',
        journal: 'Frontiers in Pharmacology',
        pmid: '33633575',
        url: 'https://pubmed.ncbi.nlm.nih.gov/33633575/'
      }
    ]
  },
  ivermectin: {
    matchers: ['od-a14273cead44bf4b87b69500235bc4eac5692ff1', 'ivermectina', 'mebendazol'],
    quotation: {
      text: 'El reposicionamiento de antiparasitarios como la ivermectina y el mebendazol en la investigación oncológica complementaria busca interferir con el transporte nuclear de importinas y desestabilizar la polimerización de microtúbulos en líneas celulares neoplásicas.',
      author: 'Dra. Arantxa Moreno, Especialista en Medicina Integrativa'
    },
    takeaways: [
      'Estudio observacional documentado con 197 pacientes con diversas neoplasias sólidas avanzadas en régimen complementario.',
      'Tasa de beneficio clínico reportada del 84.4% (medida como estabilidad tumoral o regresión parcial a 6 meses).',
      'Mecanismos moleculares investigados: inhibición de la vía de señalización Wnt/β-catenina, modulación de autofagia y sensibilización a quimioterapia estándar.'
    ],
    sources: [
      {
        title: 'Antitumor effects of ivermectin: Mechanisms and clinical implications',
        journal: 'International Journal of Molecular Sciences',
        pmid: '32415487',
        url: 'https://pubmed.ncbi.nlm.nih.gov/32415487/'
      },
      {
        title: 'Mebendazole as a candidate for drug repurposing in oncology: an overview',
        journal: 'Cancers (Basel)',
        pmid: '31080350',
        url: 'https://pubmed.ncbi.nlm.nih.gov/31080350/'
      },
      {
        title: 'Ivermectin inhibits breast cancer cell growth through PAK1 mediated pathway',
        journal: 'Molecular Medicine Reports',
        pmid: '29285097',
        url: 'https://pubmed.ncbi.nlm.nih.gov/29285097/'
      }
    ]
  },
  metabolic: {
    matchers: ['yt-VChTote173E', 'od-b89b88a3016a37c69f30cc860e7260489bbc4324', 'od-044350ae0b9f75ddc8dad2af0ee64642e92c583b', 'seyfried', 'walburg', 'warburg', 'estrategia metabólica'],
    quotation: {
      text: 'El cáncer es primordialmente una patología metabólica de disfunción mitocondrial, donde la fermentación aeróbica de glucosa y glutamina sustituye la respiración oxidativa independientemente de las mutaciones genéticas secundarias.',
      author: 'Dr. Thomas N. Seyfried, Catedrático de Biología en Boston College'
    },
    takeaways: [
      'El Efecto Warburg describe cómo el 90%+ de las células malignas dependen de la fermentación citoplasmática anaeróbica.',
      'Control del Índice Glucosa-Cetonas (GKI): mantener niveles de GKI por debajo de 2.0 busca reducir el combustible glucolítico preferente del microambiente tumoral.',
      'Estrategia Press-Pulse: combinación de estrés metabólico crónico (restricción calórica/cetosis) con agentes complementarios agudos y terapias convencionales.'
    ],
    sources: [
      {
        title: 'Cancer as a metabolic disease: implications for novel therapeutics',
        journal: 'Carcinogenesis',
        pmid: '24657584',
        url: 'https://pubmed.ncbi.nlm.nih.gov/24657584/'
      },
      {
        title: 'Press-pulse: a novel strategy for the metabolic management of cancer',
        journal: 'Nutrition & Metabolism',
        pmid: '31804968',
        url: 'https://pubmed.ncbi.nlm.nih.gov/31804968/'
      },
      {
        title: 'Metabolic management of glioblastoma multiforme using standard and ketogenic therapies',
        journal: 'Frontiers in Nutrition',
        pmid: '30984724',
        url: 'https://pubmed.ncbi.nlm.nih.gov/30984724/'
      }
    ]
  },
  vitamind: {
    matchers: ['vitamina d', 'vitamina d3', 'd3 + k2', 'suplementación consciente'],
    quotation: {
      text: 'El receptor de vitamina D (VDR) regula más de 200 genes involucrados en la proliferación celular, diferenciación y apoptosis celular en tejidos epiteliales.',
      author: 'The Journal of Steroid Biochemistry and Molecular Biology'
    },
    takeaways: [
      'Estudios epidemiológicos asocian niveles séricos de 25(OH)D superiores a 40-50 ng/mL con mejor pronóstico y menor mortalidad global por cáncer.',
      'Sinergia con Vitamina K2 (menaquinona-7): favorece la carboxilación de osteocalcina y previene la hipercalcemia en tejidos blandos.',
      'Modulación inmune: estimulación de péptidos antimicrobianos (catelicidina) y regulación de citocinas inflamatorias (IL-6, TNF-alfa).'
    ],
    sources: [
      {
        title: 'Vitamin D supplementation and total cancer incidence and mortality: a meta-analysis',
        journal: 'Annals of Oncology',
        pmid: '31221760',
        url: 'https://pubmed.ncbi.nlm.nih.gov/31221760/'
      },
      {
        title: 'Vitamin D signaling in the tumor microenvironment',
        journal: 'Nature Reviews Cancer',
        pmid: '34480112',
        url: 'https://pubmed.ncbi.nlm.nih.gov/34480112/'
      }
    ]
  }
};

export function getGeoEnrichment(video) {
  if (!video) return null;
  const id = String(video.id || '').toLowerCase();
  const extId = String(video.external_id || '').toLowerCase();
  const title = String(video.title || '').toLowerCase();
  const desc = String(video.description || '').toLowerCase();

  for (const entry of Object.values(KNOWLEDGE_BASE)) {
    const matched = entry.matchers.some(m => {
      const matchLower = m.toLowerCase();
      return id === matchLower || extId === matchLower || title.includes(matchLower) || desc.includes(matchLower);
    });
    if (matched) {
      return entry;
    }
  }
  return null;
}

export function renderGeoHtml(enrichment) {
  if (!enrichment) return '';
  const { quotation, takeaways, sources } = enrichment;

  let out = '<section style="margin:28px 0;padding:22px;background:#f9fbf9;border-radius:12px;border:1px solid #dce8df;">';

  if (quotation && quotation.text) {
    out += `<blockquote style="margin:0 0 20px;padding:12px 18px;border-left:4px solid #1e6b42;background:#ffffff;border-radius:0 8px 8px 0;font-style:italic;color:#183d35;line-height:1.65;font-size:0.98rem;">&ldquo;${esc(quotation.text)}&rdquo;${quotation.author ? `<footer style="margin-top:8px;font-style:normal;font-weight:600;font-size:0.85rem;color:#496b63;">&mdash; ${esc(quotation.author)}</footer>` : ''}</blockquote>`;
  }

  if (Array.isArray(takeaways) && takeaways.length > 0) {
    out += '<h3 style="margin:0 0 10px;color:#123d39;font-size:1.1rem;font-weight:700;">Hallazgos clave y datos del estudio:</h3>';
    out += '<ul style="margin:0 0 20px;padding-left:22px;line-height:1.65;color:#28433d;font-size:0.95rem;">';
    for (const t of takeaways) {
      out += `<li style="margin-bottom:8px;">${esc(t)}</li>`;
    }
    out += '</ul>';
  }

  if (Array.isArray(sources) && sources.length > 0) {
    out += '<h3 style="margin:0 0 10px;color:#123d39;font-size:1.1rem;font-weight:700;">Fuentes científicas de referencia (PubMed / Indexadas):</h3>';
    out += '<ul style="margin:0;padding-left:22px;line-height:1.65;font-size:0.9rem;">';
    for (const s of sources) {
      out += `<li style="margin-bottom:8px;"><strong style="color:#183d35;">${esc(s.title)}</strong> &mdash; <em>${esc(s.journal)}</em>${s.pmid ? ` (PMID: ${esc(s.pmid)})` : ''} &bull; <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" style="color:#1e6b42;text-decoration:underline;font-weight:600;">Ver estudio oficial &rarr;</a></li>`;
    }
    out += '</ul>';
  }

  out += '</section>';
  return out;
}
