import {geoOrthographic,geoPath,geoGraticule10,geoCentroid,geoArea} from '../assets/vendor/globe-geo.js';
const cache=new WeakMap();
export function globeCenter(value=[20,15]){if(!Array.isArray(value)||value.length!==2||!value.every(Number.isFinite))throw Error('Invalid globe center.');return [((value[0]+180)%360+360)%360-180,Math.max(-90,Math.min(90,value[1]))];}
export function rotateGlobe(center,longitude=0,latitude=0){if(!Number.isFinite(longitude)||!Number.isFinite(latitude))throw Error('Invalid globe rotation.');const current=globeCenter(center);return globeCenter([current[0]+longitude,current[1]+latitude]);}
export function atlasGeometry(feature){
 if(cache.has(feature))return cache.get(feature);const polygons=[];
 for(const match of feature.path.matchAll(/M([^Z]+)Z/g)){const points=[...match[1].matchAll(/(-?[0-9]+(?:\.[0-9]+)?),(-?[0-9]+(?:\.[0-9]+)?)/g)].map(m=>[Number(m[1]),Number(m[2])]);if(points.length<3)continue;const area=points.reduce((sum,p,i)=>{const next=points[(i+1)%points.length];return sum+p[0]*next[1]-next[0]*p[1];},0);const ring=points.map(p=>[p[0]*.36-180,90-p[1]*.36]);if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])ring.push([...ring[0]]);if(area>=0||!polygons.length)polygons.push([ring]);else polygons.at(-1).push(ring);}
 for(const rings of polygons){if(geoArea({type:'Polygon',coordinates:rings})>2*Math.PI)for(const ring of rings)ring.reverse();}
 const geometry={type:'MultiPolygon',coordinates:polygons};cache.set(feature,geometry);return geometry;
}
export function countryGlobeCenter(atlas,code){let largest=null,area=0;for(const feature of atlas.features.filter(f=>f.iso2===code))for(const rings of atlasGeometry(feature).coordinates){const geometry={type:'Polygon',coordinates:rings},current=geoArea(geometry);if(current>area){area=current;largest=geometry;}}return largest?globeCenter(geoCentroid(largest)):null;}
export function globeScene(atlas,center=[20,15]){
 const rotation=globeCenter(center),projection=geoOrthographic().rotate([-rotation[0],-rotation[1]]).translate([500,250]).scale(210).precision(.3),path=geoPath(projection).digits(2);
 return {center:rotation,sphere:path({type:'Sphere'}),grid:path(geoGraticule10()),features:atlas.features.map(feature=>({...feature,path:path(atlasGeometry(feature))||''})).filter(f=>f.path)};
}
