// Country context is captured from the retained catalog; chatting never fetches data.
// Keep exact observations outside model prose so a draft cannot replace their values.
// Two format strings exist: 'nemoworld-mayor-country-v1' is the historical format stored before the
// country-ambassador migration and must stay readable; 'nemoworld-ambassador-country-v1' is the
// current format. Both describe the same fields, so record readers stay format-agnostic.
export const MAYOR_CONTEXT_FORMAT = 'nemoworld-mayor-country-v1';
export const AMBASSADOR_CONTEXT_FORMAT = 'nemoworld-ambassador-country-v1';

function countryContext(agriculture, access, capturedAt, format) {
  const sources = [agriculture, access].flatMap(evidence => evidence.routes.map(route => {
    const series = evidence.snapshot?.series.find(item => item.indicator === route.id);
    const points = [...(series?.points || [])].sort((a, b) => b.year - a.year);
    const observation = points.find(point => point.value !== null);
    return {
      sector: evidence.sector, indicator: route.id, name: route.name, unit: route.unit,
      publisher: series?.publisher || route.publisher, qualifier: series?.qualifier || route.qualifier,
      url: series?.url || route.url, definition_url: route.definition_url,
      metadata_url: route.metadata_url || null, status: series ? 'retained' : 'not_retained',
      latest_observation: observation ? { ...observation } : null,
      latest_record: points.length ? { ...points[0] } : null,
      observation_count: points.length, missing_values: points.filter(point => point.value === null).length,
      dataset_updated: series?.dataset_updated || null, retrieved_at: series?.retrieved_at || null,
      retrieved_on: series?.retrieved_on || null, sha256: series?.sha256 || null,
      license: { ...(series?.license || evidence.license) },
      limitations: [series?.limitations, evidence.metadata.limitations].filter(Boolean).join(' '),
      collection_gap: evidence.collection_gaps.find(gap => gap.indicator === route.id) || null,
    };
  })).map((source, index) => ({ number: index + 1, ...source }));
  return {
    format,
    country: { iso2: agriculture.country.iso2, iso3: agriculture.country.iso3, name: agriculture.country.name },
    captured_at: capturedAt, sources,
    limitations: 'A retained, dated national baseline for agriculture, electricity access and Internet use. Missing values are not zero. Dataset update, retrieval and observation dates have different meanings. This context does not establish current rules, crop demand, buyers, funding, project viability or completed work. Ambassador guidance is advisory and still requires independent human review.',
  };
}

export function mayorCountryContext(agriculture, access, capturedAt) {
  return countryContext(agriculture, access, capturedAt, MAYOR_CONTEXT_FORMAT);
}

export function ambassadorCountryContext(agriculture, access, capturedAt) {
  return countryContext(agriculture, access, capturedAt, AMBASSADOR_CONTEXT_FORMAT);
}

// A country context is valid for its own catalog entry only. A profile built with a mismatched
// context would let one ambassador speak for another country, so the check is explicit.
export function contextMatchesCountry(context, country) {
  const code = typeof country === 'string' ? country.toUpperCase() : String(country?.iso2 || country?.iso3 || '').toUpperCase();
  return Boolean(context) && (context.country.iso2.toUpperCase() === code || context.country.iso3.toUpperCase() === code);
}

// The model sees availability and qualitative scope, never the statistical values,
// observation years, source URLs or raw hashes displayed by the interface.
export function mayorModelCountryContext(context) {
  return {
    country: context.country,
    sources: context.sources.map(source => ({
      number: source.number, name: source.name, sector: source.sector,
      retained: source.status === 'retained', has_observation: source.latest_observation !== null,
      has_missing_values: source.missing_values > 0,
    })),
    limitations: 'National baseline context only; it does not establish local feasibility, current rules, buyers, funding or completed work. A missing observation is an evidence gap, never proof of absence.',
  };
}

export function mayorConversation(record) {
  return { ...record, country_context: record.country_context ? JSON.parse(record.country_context) : null,
    source_numbers: JSON.parse(record.source_numbers || '[]') };
}

// The ambassador conversation record has the same stored shape as the historical guide record, so
// one reader serves both stores and an old row survives the migration unchanged.
export const ambassadorConversation = mayorConversation;
export const ambassadorModelCountryContext = mayorModelCountryContext;
