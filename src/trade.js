export const TRADE_TERMS='https://uncomtrade.org/docs/policy-on-comtrade-data-use/';
export function tradeUrl({reporter,partner,year,commodity,flow}){
 if(!/^[1-9]\d{0,2}$/.test(String(reporter))||!/^(0|[1-9]\d{0,2})$/.test(String(partner))||String(reporter)===String(partner)||!Number.isInteger(Number(year))||Number(year)<2015||Number(year)>2026||!/^\d{4}(?:\d{2})?$/.test(commodity)||Number(commodity.slice(0,2))<1||Number(commodity.slice(0,2))>24||!['M','X'].includes(flow))throw Error('Choose distinct reporter/partner codes, a year from 2015–2026, an agricultural HS4/HS6 code and imports or exports.');
 return 'https://comtradeapi.un.org/public/v1/preview/C/A/HS?'+new URLSearchParams({period:String(Number(year)),reporterCode:String(reporter),partnerCode:String(partner),cmdCode:commodity,flowCode:flow,maxRecords:'500',breakdownMode:'classic',includeDesc:'true'});
}

export function tradePairUrls({origin,destination,commodity,startYear,endYear}){
 if(!/^[1-9]\d{0,2}$/.test(String(origin))||!/^[1-9]\d{0,2}$/.test(String(destination))||String(origin)===String(destination)||!Number.isInteger(startYear)||!Number.isInteger(endYear)||endYear<startYear||endYear-startYear>4)throw Error('Paired collection needs distinct country codes (not World) and one to five integer years.');
 const queries=[];for(let year=startYear;year<=endYear;year++)for(const role of ['exporter','mirror-importer'])queries.push({year,role,url:tradeUrl({reporter:role==='exporter'?origin:destination,partner:role==='exporter'?destination:origin,year,commodity,flow:role==='exporter'?'X':'M'})});return queries;
}
