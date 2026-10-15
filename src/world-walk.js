import {walkable} from '../world.js';
import {blockLayers, canStep, surfaceAt} from './elevation.js';
import {blockOccupiesTile, solidTileKeys} from './footprints.js';

// Navigation follows known terrain and the shared footprint table. Every step is still checked by the server.
export function planWalk(definition,start,target,{objects=[],blocks=[],maxSteps=192,maxVisited=8192}={}){
 if(!start||!target||![start.x,start.y,target.x,target.y].every(Number.isInteger)||maxSteps<1||maxVisited<1)return null;
 // Solid scenery comes from one table for authored and saved objects alike, plus every solid block
 // layer on the ground; decorative scenery and the thin `path` surface stay passable.
 const solid=solidTileKeys([...(definition?.objects||[]),...objects]);
 const blocked=new Set(solid);
 for(const item of blocks)if(Number.isInteger(item?.x)&&Number.isInteger(item?.y)&&item.z===0&&blockOccupiesTile(item.type))blocked.add(`${item.x},${item.y}`);
 const key=point=>`${point.x},${point.y}`;const end=key(target);if(!walkable(target,definition)||blocked.has(end))return null;
 const queue=[{x:start.x,y:start.y}],previous=new Map([[key(start),null]]),directions=new Map();let cursor=0;
 while(cursor<queue.length&&previous.size<=maxVisited){const current=queue[cursor++],currentKey=key(current);if(currentKey===end){const route=[];let path=end;while(previous.get(path)!==null){route.push(directions.get(path));path=previous.get(path);}route.reverse();return route.length<=maxSteps?route:null;}
  for(const [direction,dx,dy]of[['up',0,-1],['right',1,0],['down',0,1],['left',-1,0]]){const next={x:current.x+dx,y:current.y+dy},nextKey=key(next);if(previous.has(nextKey)||blocked.has(nextKey)||!walkable(next,definition))continue;previous.set(nextKey,currentKey);directions.set(nextKey,direction);queue.push(next);}
 }
 return null;
}

/** Steps of a journey walked before the route is planned again from where the resident now stands. */
export const JOURNEY_LEG_STEPS = 64;
/** The longest journey on the global map, in steps: a corner of the map to the opposite one with room to spare. */
export const JOURNEY_MAX_STEPS = 900;

/**
 * A route that may cross many worlds of the global map. `planWalk` is limited to one viewport's worth of
 * route (192 steps, 8,192 tiles searched); a journey searches the whole stitched map and returns the whole
 * route, which the caller walks in legs of `JOURNEY_LEG_STEPS`, planning again between legs so a route that
 * crossed a stretch known only from terrain is corrected by what the next window shows.
 * Returns `{route, legs}` (legs are consecutive slices of the route), or null when there is no known route.
 */
export function planJourney(definition,start,target,{objects=[],blocks=[],legSteps=JOURNEY_LEG_STEPS,maxSteps=JOURNEY_MAX_STEPS}={}){
 if(!Number.isInteger(legSteps)||legSteps<1)return null;
 const maxVisited=Math.max(8192,(definition?.columns||0)*(definition?.rows||0)+1);
 const route=planWalk(definition,start,target,{objects,blocks,maxSteps,maxVisited});
 if(!route)return null;
 const legs=[];for(let index=0;index<route.length;index+=legSteps)legs.push(route.slice(index,index+legSteps));
 return {route,legs};
}

/**
 * The tiles a walking resident can leave: every column whose resident has a legal route back to the
 * world's shared arrival, following one-layer step-up and descent through authored columns. Edges are
 * walked in reverse, so a resident standing on a high roof counts as able to descend to a road even
 * when a road resident could not climb up in one step.
 *
 * Frontier placement, frontier removal and garden placement all consult this one search, so a
 * placement anywhere in the world cannot strand a resident away from the shared passage.
 */
export function escapeColumns(definition,blocks=[],objects=[]){
 // Authored scenery and saved objects resolve through the same table, so a caller cannot forget one.
 const all=[...(definition?.objects||[]),...objects];
 const layers=blockLayers(blocks),context={walkable,definition,layers,solidTiles:solidTileKeys(all)};
 const queue=[definition.start],seen=new Set([`${definition.start.x},${definition.start.y}`]);
 for(let index=0;index<queue.length;index++)for(const [dx,dy,direction]of[[0,-1,'down'],[0,1,'up'],[-1,0,'right'],[1,0,'left']]){
  const position={x:queue[index].x+dx,y:queue[index].y+dy},key=`${position.x},${position.y}`;
  if(seen.has(key)||!walkable(position,definition))continue;
  const step=canStep({...position,z:surfaceAt(position.x,position.y,layers)},direction,context,{allowAuthoredStepUp:true});
  if(!step.blocked){seen.add(key);queue.push(position);}
 }
 return seen;
}

/** The nearest clear tile to `position`: a diamond search, cardinals before diagonals, then null. */
export function nearestClearTile(definition,position,objects=[],radius=8){
 const solid=solidTileKeys([...(definition?.objects||[]),...objects]);
 const offsets=[];
 for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)if(Math.abs(dx)+Math.abs(dy)<=radius)offsets.push([dx,dy]);
 offsets.sort((a,b)=>(Math.abs(a[0])+Math.abs(a[1]))-(Math.abs(b[0])+Math.abs(b[1]))
  ||Math.abs(a[0])-Math.abs(b[0])||a[1]-b[1]||a[0]-b[0]);
 for(const [dx,dy] of offsets){
  const tile={x:position.x+dx,y:position.y+dy};
  if(walkable(tile,definition)&&!solid.has(`${tile.x},${tile.y}`))return tile;
 }
 return null;
}
