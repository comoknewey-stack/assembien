import type {
  ResearchReportReadiness,
  WebPageFetchOutput,
  WebSearchResult
} from '@assem/shared-types';

export interface ResearchQualityFixtureCase {
  id: string;
  objective: string;
  searchResults: WebSearchResult[];
  pageFetchByUrl: Record<string, Partial<WebPageFetchOutput> | Error>;
  expected: {
    status: 'completed' | 'failed';
    reportReadiness?: ResearchReportReadiness;
    selectedAtLeast?: number;
    strongAtLeast?: number;
    tangentialAtLeast?: number;
    highQualityReadsAtLeast?: number;
    snippetDominant?: boolean;
    reportMustExist?: boolean;
    reportMustMention?: string[];
  };
}

const RETRIEVED_AT = '2026-04-24T08:00:00.000Z';

function result(
  title: string,
  url: string,
  snippet: string,
  source: string,
  publishedAt?: string
): WebSearchResult {
  return {
    title,
    url,
    snippet,
    source,
    publishedAt,
    retrievedAt: RETRIEVED_AT
  };
}

export const RESEARCH_QUALITY_FIXTURES: ResearchQualityFixtureCase[] = [
  {
    id: 'soft_drinks_usa',
    objective: 'Hazme un informe sobre el consumo de refrescos en USA',
    searchResults: [
      result(
        'Sugar-sweetened beverage consumption among US adults',
        'https://www.cdc.gov/nutrition/data-statistics/sugar-sweetened-beverages.html',
        'CDC data describes sugar-sweetened beverage consumption in the United States among adults and children using survey-based statistics.',
        'CDC'
      ),
      result(
        'Beverage intake in the United States: national survey findings',
        'https://www.nih.gov/news-events/beverage-intake-united-states',
        'NIH-backed survey findings discuss beverage intake patterns in the United States and include methodological caveats.',
        'NIH'
      ),
      result(
        'Packaging trends for soft drinks in North America',
        'https://www.packagingdive.com/news/soft-drink-packaging-trends',
        'Packaging trends for beverage brands in North America focus on containers, design and marketing shifts.',
        'Packaging Dive'
      )
    ],
    pageFetchByUrl: {
      'https://www.cdc.gov/nutrition/data-statistics/sugar-sweetened-beverages.html': {
        status: 'ok',
        readQuality: 'high',
        qualityScore: 0.88,
        textDensity: 0.38,
        linkDensity: 0.06,
        qualityNotes: ['readable_editorial_content'],
        title: 'CDC soft drink consumption',
        contentText:
          'CDC survey data describes how often US adults consume sugar-sweetened beverages, including frequency patterns by age and demographic groups. The page explains methodology limits and highlights repeated consumption across the population.',
        excerpt:
          'CDC survey data describes how often US adults consume sugar-sweetened beverages, including frequency patterns by age and demographic groups.'
      },
      'https://www.nih.gov/news-events/beverage-intake-united-states': {
        status: 'ok',
        readQuality: 'medium',
        qualityScore: 0.71,
        textDensity: 0.31,
        linkDensity: 0.11,
        qualityNotes: ['usable_but_partially_noisy_content'],
        title: 'NIH beverage intake findings',
        contentText:
          'NIH-backed researchers summarize beverage intake findings in the United States and note the survey frame, sample size and limitations. The article is readable and directly related to beverage consumption patterns.',
        excerpt:
          'NIH-backed researchers summarize beverage intake findings in the United States and note the survey frame, sample size and limitations.'
      },
      'https://www.packagingdive.com/news/soft-drink-packaging-trends': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.33,
        textDensity: 0.11,
        linkDensity: 0.38,
        qualityNotes: ['technical_noise_detected', 'low_quality_extraction'],
        title: 'Packaging trends',
        contentText:
          'Brand packaging trends and marketing discussion for beverage containers.',
        excerpt:
          'Brand packaging trends and marketing discussion for beverage containers.'
      }
    },
    expected: {
      status: 'completed',
      reportReadiness: 'solid',
      selectedAtLeast: 2,
      strongAtLeast: 1,
      tangentialAtLeast: 1,
      highQualityReadsAtLeast: 1,
      snippetDominant: false,
      reportMustExist: true,
      reportMustMention: ['## Nivel de evidencia', '## Cobertura de fuentes']
    }
  },
  {
    id: 'soft_drinks_spain',
    objective: 'Hazme un informe sobre el consumo de refrescos en Espana',
    searchResults: [
      result(
        'Encuesta de consumo alimentario en Espana',
        'https://www.mapa.gob.es/es/alimentacion/temas/consumo-tendencias/panel-de-consumo-alimentario/',
        'El panel de consumo alimentario recoge datos sobre bebidas refrescantes y otros productos en hogares espanoles.',
        'MAPA'
      ),
      result(
        'Refrescos en hogares espanoles: habitos y frecuencia',
        'https://www.ine.es/consumo/refrescos-hogares',
        'INE resume habitos de consumo en hogares espanoles con indicadores y contexto metodologico.',
        'INE'
      ),
      result(
        'Las mejores marcas de refrescos del verano',
        'https://www.ejemploblog.com/blog/mejores-refrescos-verano',
        'Ranking de marcas y recomendaciones de compra para el verano.',
        'Ejemplo Blog'
      )
    ],
    pageFetchByUrl: {
      'https://www.mapa.gob.es/es/alimentacion/temas/consumo-tendencias/panel-de-consumo-alimentario/': {
        status: 'ok',
        readQuality: 'high',
        qualityScore: 0.86,
        textDensity: 0.36,
        linkDensity: 0.08,
        qualityNotes: ['readable_editorial_content'],
        title: 'Panel de consumo alimentario',
        contentText:
          'El panel de consumo alimentario describe el consumo de bebidas refrescantes en hogares espanoles, con metodologia, alcance y series de seguimiento.',
        excerpt:
          'El panel de consumo alimentario describe el consumo de bebidas refrescantes en hogares espanoles, con metodologia y series de seguimiento.'
      },
      'https://www.ine.es/consumo/refrescos-hogares': {
        status: 'ok',
        readQuality: 'medium',
        qualityScore: 0.68,
        textDensity: 0.28,
        linkDensity: 0.12,
        qualityNotes: ['usable_but_partially_noisy_content'],
        title: 'INE refrescos hogares',
        contentText:
          'INE resume habitos de consumo de refrescos en hogares espanoles y enlaza tablas estadisticas relevantes para interpretar la categoria.',
        excerpt:
          'INE resume habitos de consumo de refrescos en hogares espanoles y enlaza tablas estadisticas relevantes.'
      }
    },
    expected: {
      status: 'completed',
      reportReadiness: 'solid',
      selectedAtLeast: 2,
      strongAtLeast: 1,
      highQualityReadsAtLeast: 1,
      reportMustExist: true
    }
  },
  {
    id: 'youtube_seniors',
    objective: 'Hazme un informe sobre el consumo de YouTube entre la gente mayor',
    searchResults: [
      result(
        'Older adults and YouTube usage',
        'https://www.pewresearch.org/internet/older-adults-youtube-usage/',
        'Pew Research summarizes how older adults use YouTube and how usage differs by age group.',
        'Pew Research Center'
      ),
      result(
        'Ofcom online nation older audiences',
        'https://www.ofcom.org.uk/online-nation/older-audiences-youtube',
        'Ofcom analysis covers online video usage, including YouTube among older audiences.',
        'Ofcom'
      ),
      result(
        'How brands reach seniors on YouTube',
        'https://www.marketingexample.com/brands-reach-seniors-youtube',
        'Marketing strategies for brands trying to reach seniors on YouTube.',
        'Marketing Example'
      )
    ],
    pageFetchByUrl: {
      'https://www.pewresearch.org/internet/older-adults-youtube-usage/': {
        status: 'ok',
        readQuality: 'high',
        qualityScore: 0.84,
        textDensity: 0.35,
        linkDensity: 0.07,
        qualityNotes: ['readable_editorial_content'],
        title: 'Pew older adults and YouTube',
        contentText:
          'Pew Research describes how older adults use YouTube, with age-group breakdowns and comparison against broader social media adoption.',
        excerpt:
          'Pew Research describes how older adults use YouTube, with age-group breakdowns and comparison against broader social media adoption.'
      },
      'https://www.ofcom.org.uk/online-nation/older-audiences-youtube': {
        status: 'ok',
        readQuality: 'medium',
        qualityScore: 0.67,
        textDensity: 0.26,
        linkDensity: 0.14,
        qualityNotes: ['usable_but_partially_noisy_content'],
        title: 'Ofcom older audiences',
        contentText:
          'Ofcom reports on online video usage and includes evidence about YouTube reach among older audiences, though some detail is broader than the exact question.',
        excerpt:
          'Ofcom reports on online video usage and includes evidence about YouTube reach among older audiences.'
      },
      'https://www.marketingexample.com/brands-reach-seniors-youtube': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.29,
        textDensity: 0.13,
        linkDensity: 0.34,
        qualityNotes: ['boilerplate_noise_detected', 'low_quality_extraction'],
        title: 'Brands reach seniors on YouTube',
        contentText:
          'Brand marketing ideas for campaigns aimed at senior audiences on YouTube.',
        excerpt: 'Brand marketing ideas for campaigns aimed at senior audiences on YouTube.'
      }
    },
    expected: {
      status: 'completed',
      reportReadiness: 'limited',
      selectedAtLeast: 2,
      tangentialAtLeast: 1,
      reportMustExist: true
    }
  },
  {
    id: 'blocked_pdf',
    objective: 'Hazme un informe sobre el consumo de refrescos en USA con las fuentes disponibles',
    searchResults: [
      result(
        'US beverage consumption report PDF',
        'https://www.usda.gov/reports/us-beverage-consumption.pdf',
        'Official PDF report on beverage consumption in the United States.',
        'USDA'
      ),
      result(
        'Top soda brands in the US',
        'https://www.example.com/top-soda-brands',
        'A ranking of soda brands in the United States.',
        'Example'
      )
    ],
    pageFetchByUrl: {
      'https://www.usda.gov/reports/us-beverage-consumption.pdf': {
        status: 'blocked',
        contentType: 'application/pdf',
        errorMessage: 'Unsupported content type: application/pdf'
      },
      'https://www.example.com/top-soda-brands': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.24,
        textDensity: 0.12,
        linkDensity: 0.29,
        qualityNotes: ['low_quality_extraction'],
        title: 'Top soda brands',
        contentText: 'Brand ranking and marketing copy.',
        excerpt: 'Brand ranking and marketing copy.'
      }
    },
    expected: {
      status: 'failed',
      reportReadiness: 'insufficient',
      snippetDominant: true,
      reportMustExist: false
    }
  },
  {
    id: 'noisy_html',
    objective: 'Hazme un informe sobre el consumo de refrescos en USA',
    searchResults: [
      result(
        'Soft drink consumption article shell',
        'https://www.noisy-example.com/consumption-shell',
        'Article page about soft drink consumption in the United States.',
        'Noisy Example'
      ),
      result(
        'Soft drink branding hub',
        'https://www.example.org/soft-drink-branding',
        'Brand storytelling and campaign ideas for soft drinks in the United States.',
        'Example Research'
      )
    ],
    pageFetchByUrl: {
      'https://www.noisy-example.com/consumption-shell': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.27,
        textDensity: 0.08,
        linkDensity: 0.42,
        qualityNotes: ['technical_noise_detected', 'boilerplate_noise_detected', 'low_quality_extraction'],
        title: 'Soft drink shell page',
        contentText:
          'display:flex; window.__DATA__ {"json":true} subscribe cookie policy more links more links more links',
        excerpt:
          'display:flex; window.__DATA__ {"json":true} subscribe cookie policy more links.'
      },
      'https://www.example.org/soft-drink-branding': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.34,
        textDensity: 0.17,
        linkDensity: 0.24,
        qualityNotes: ['low_quality_extraction'],
        title: 'Soft drink branding',
        contentText:
          'Brand positioning and campaign messaging with little or no direct soft drink consumption evidence.',
        excerpt:
          'Brand positioning and campaign messaging with little or no direct soft drink consumption evidence.'
      }
    },
    expected: {
      status: 'failed',
      reportReadiness: 'insufficient',
      reportMustExist: false
    }
  },
  {
    id: 'tangential_sources',
    objective: 'Hazme un informe sobre el consumo de refrescos en USA',
    searchResults: [
      result(
        'Packaging innovations in soda cans',
        'https://www.packagingworld.com/soda-can-innovations',
        'Packaging innovations in soda cans and beverage containers.',
        'Packaging World'
      ),
      result(
        'Soft drink marketing campaigns that worked',
        'https://www.adweek.com/soft-drink-marketing-campaigns',
        'Marketing campaigns and brand positioning in soft drinks.',
        'Adweek'
      ),
      result(
        'Retail promotions for soda season',
        'https://www.retailpromo.com/soda-season',
        'Retail promotions and in-store activation for soda season.',
        'Retail Promo'
      )
    ],
    pageFetchByUrl: {
      'https://www.packagingworld.com/soda-can-innovations': {
        status: 'ok',
        readQuality: 'medium',
        qualityScore: 0.58,
        textDensity: 0.23,
        linkDensity: 0.16,
        qualityNotes: ['usable_but_partially_noisy_content'],
        title: 'Packaging innovations',
        contentText:
          'Packaging article about cans, materials and branding, not about beverage consumption levels.',
        excerpt:
          'Packaging article about cans, materials and branding, not about beverage consumption levels.'
      }
    },
    expected: {
      status: 'failed',
      reportReadiness: 'insufficient',
      reportMustExist: false
    }
  },
  {
    id: 'insufficient_evidence',
    objective: 'Hazme un informe sobre el consumo de YouTube entre la gente mayor',
    searchResults: [
      result(
        'Social media trends 2026',
        'https://www.example.org/social-media-trends',
        'General social media trends mention video platforms in passing.',
        'Example Trends'
      ),
      result(
        'Video habits overview',
        'https://www.example.net/video-habits-overview',
        'Broad video habits overview with no clear focus on older people or YouTube specifically.',
        'Example Overview'
      )
    ],
    pageFetchByUrl: {
      'https://www.example.org/social-media-trends': {
        status: 'ok',
        readQuality: 'medium',
        qualityScore: 0.56,
        textDensity: 0.22,
        linkDensity: 0.17,
        qualityNotes: ['usable_but_partially_noisy_content'],
        title: 'Social media trends',
        contentText:
          'A broad trends article mentions several platforms but does not directly answer how older adults use YouTube.',
        excerpt:
          'A broad trends article mentions several platforms but does not directly answer how older adults use YouTube.'
      },
      'https://www.example.net/video-habits-overview': {
        status: 'ok',
        readQuality: 'low',
        qualityScore: 0.31,
        textDensity: 0.16,
        linkDensity: 0.19,
        qualityNotes: ['low_quality_extraction'],
        title: 'Video habits overview',
        contentText:
          'General video habits with indirect references and weak audience detail.',
        excerpt:
          'General video habits with indirect references and weak audience detail.'
      }
    },
    expected: {
      status: 'failed',
      reportReadiness: 'insufficient',
      reportMustExist: false
    }
  }
];
