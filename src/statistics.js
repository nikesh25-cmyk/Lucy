// A fixed, dated evidence window. Extending it requires a catalog and reader review.
export const STATISTICS_WINDOW = { start: 2015, end: 2026 };
export const AGRICULTURE_INDICATORS = [
  {id:'NV.AGR.TOTL.ZS',name:'Agriculture, forestry, and fishing, value added (% of GDP)',unit:'% of GDP',publisher:'World Bank WDI; national accounts and staff estimates',qualifier:'Sector value added includes forestry and fishing; it is not crop revenue or export earnings.'},
  {id:'SL.AGR.EMPL.ZS',name:'Employment in agriculture (% of total employment) (modeled ILO estimate)',unit:'% of total employment',publisher:'ILO modelled estimates, distributed through World Bank WDI',qualifier:'Modeled ILO estimate. It is not a count of farmers or a substitute for a national census.'},
  {id:'AG.LND.ARBL.ZS',name:'Arable land (% of land area)',unit:'% of land area',publisher:'FAO, distributed through World Bank WDI',qualifier:'Land classification is not evidence of available farmland, tenure, soil quality or irrigation.'},
].map(item=>({...item,definition_url:`https://data.worldbank.org/indicator/${item.id}`}));
export const ACCESS_INDICATORS = [
  {id:'EG.ELC.ACCS.ZS',name:'Access to electricity (% of population)',unit:'% of population',publisher:'World Bank SDG 7.1.1 Electrification Dataset, distributed through WDI',qualifier:'Population access measure from surveys and international sources. It does not establish reliability, affordability, generation capacity or a local project design.',goals:[7],metadata_url:'https://databank.worldbank.org/metadataglossary/world-development-indicators/series/EG.ELC.ACCS.ZS'},
  {id:'IT.NET.USER.ZS',name:'Individuals using the Internet (% of population)',unit:'% of population',publisher:'International Telecommunication Union (ITU), distributed through World Bank WDI',qualifier:'Individuals who used the Internet from any location in the last three months. Not subscriptions, broadband coverage, speed, affordability or digital skills. Cite ITU for third-party use.',goals:[17],metadata_url:'https://databank.worldbank.org/metadataglossary/world-development-indicators/series/IT.NET.USER.ZS'},
].map(item=>({...item,definition_url:`https://data.worldbank.org/indicator/${item.id}`}));
export const REGISTERED_INDICATORS = [...AGRICULTURE_INDICATORS,...ACCESS_INDICATORS];
export function accessSources(country){return ACCESS_INDICATORS.map(item=>({...item,url:statisticsUrl(country.iso3,item.id)}));}
export const STATISTICS_LICENSE = {name:'CC BY 4.0',url:'https://creativecommons.org/licenses/by/4.0/',terms:'https://data.worldbank.org/summary-terms-of-use',attribution:'World Bank, World Development Indicators; original providers identified per indicator.'};
export function statisticsUrl(iso3,indicator){
  if(!/^[A-Z]{3}$/.test(iso3)||!REGISTERED_INDICATORS.some(item=>item.id===indicator))throw new Error('Unknown statistical country or indicator.');
  return `https://api.worldbank.org/v2/country/${iso3}/indicator/${indicator}?format=json&date=${STATISTICS_WINDOW.start}:${STATISTICS_WINDOW.end}&per_page=12&source=2`;
}
export function agricultureSources(country){return AGRICULTURE_INDICATORS.map(item=>({...item,url:statisticsUrl(country.iso3,item.id)}));}
