import { readFileSync } from 'node:fs';
import { AGRICULTURE_INDICATORS, STATISTICS_WINDOW, STATISTICS_LICENSE } from '../src/statistics.js';
const countries=JSON.parse(readFileSync(new URL('../catalog/countries.json',import.meta.url),'utf8')).entries;
export function statisticsRequest(url){
  if(url.hostname!=='api.worldbank.org')return null;
  const path=/^\/v2\/country\/([A-Z]{3})\/indicator\/([A-Z0-9.]+)$/.exec(url.pathname);
  const country=path&&countries.find(item=>item.iso3===path[1]),indicator=path&&AGRICULTURE_INDICATORS.find(item=>item.id===path[2]);
  const expected={format:'json',date:`${STATISTICS_WINDOW.start}:${STATISTICS_WINDOW.end}`,per_page:'12',source:'2'};
  if(!country||!indicator||url.hash||[...url.searchParams].length!==4||Object.entries(expected).some(([key,value])=>url.searchParams.get(key)!==value))throw new Error('Only registered annual World Bank agriculture series are supported.');
  return {country,indicator};
}
export function normalizeStatistics(raw,spec){
  let data;try{data=JSON.parse(raw);}catch{throw new Error('Statistical source is not valid JSON.');}
  const [metadata,rows]=Array.isArray(data)?data:[];
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!Array.isArray(data)||data.length!==2||!metadata||Number(metadata.page)!==1||Number(metadata.pages)!==1||Number(metadata.per_page)!==12||String(metadata.sourceid)!=='2'||!validDate(metadata.lastupdated)||!Array.isArray(rows)||rows.length<1||rows.length>12||Number(metadata.total)!==rows.length)throw new Error('Incomplete statistical page or dataset metadata.');
  const years=new Set(),points=rows.map(row=>{
    const year=Number(row.date);
    if(row.indicator?.id!==spec.indicator.id||row.countryiso3code!==spec.country.iso3||row.country?.id!==spec.country.iso2||typeof row.date!=='string'||!/^\d{4}$/.test(row.date)||year<STATISTICS_WINDOW.start||year>STATISTICS_WINDOW.end||years.has(year)||!(row.value===null||typeof row.value==='number'&&Number.isFinite(row.value)&&row.value>=0&&row.value<=100)||row.unit!==''||typeof row.obs_status!=='string'||!/^[-A-Za-z0-9 .]{0,20}$/.test(row.obs_status))throw new Error('Statistical record identity, year, unit or percentage is invalid.');
    years.add(year);return {year,value:row.value,observation_status:row.obs_status||null};
  }).sort((a,b)=>b.year-a.year);
  const series={country_code:spec.country.iso2,country_iso3:spec.country.iso3,country:spec.country.name,indicator:spec.indicator.id,name:spec.indicator.name,unit:spec.indicator.unit,publisher:spec.indicator.publisher,qualifier:spec.indicator.qualifier,dataset_updated:metadata.lastupdated,window:STATISTICS_WINDOW,points,license:STATISTICS_LICENSE,limitations:'Annual sector context only. Missing values are not zero. Dataset update is not a publication or observation date. Provider footnotes were not requested; inspect indicator metadata and country documentation before applying findings.'};
  const text=[`${series.country}: ${series.name}`,`Unit: ${series.unit}. Dataset updated: ${series.dataset_updated}.`,series.qualifier,...points.map(point=>`${point.year}: ${point.value===null?'missing':point.value}${point.observation_status?` (provider status ${point.observation_status})`:''}`),series.limitations].join('\n');
  return {title:`${series.country} · ${series.name}`,text,quote:null,location:`WDI source 2; ${series.country_iso3}/${series.indicator}; annual rows ${STATISTICS_WINDOW.start}–${STATISTICS_WINDOW.end}`,declared_published:null,structured_data:series};
}
