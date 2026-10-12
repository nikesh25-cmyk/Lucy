import {walkable} from '../world.js';
// Navigation follows known terrain. Every step is still checked by the server.
export function planWalk(definition,start,target,{objects=[],blocks=[],maxSteps=192,maxVisited=8192}={}){
 if(!start||!target||![start.x,start.y,target.x,target.y].every(Number.isInteger)||maxSteps<1||maxVisited<1)return null;
 const solid=new Set([...objects.filter(item=>['cottage','tree','pond','fountain'].includes(item.type||item.kind)),...blocks.filter(item=>item.z===0&&item.type!=='path')].map(item=>`${item.x},${item.y}`));
 const key=point=>`${point.x},${point.y}`;const end=key(target);if(!walkable(target,definition)||solid.has(end))return null;
 const queue=[{x:start.x,y:start.y}],previous=new Map([[key(start),null]]),directions=new Map();let cursor=0;
 while(cursor<queue.length&&previous.size<=maxVisited){const current=queue[cursor++],currentKey=key(current);if(currentKey===end){const route=[];let path=end;while(previous.get(path)!==null){route.push(directions.get(path));path=previous.get(path);}route.reverse();return route.length<=maxSteps?route:null;}
  for(const [direction,dx,dy]of[['up',0,-1],['right',1,0],['down',0,1],['left',-1,0]]){const next={x:current.x+dx,y:current.y+dy},nextKey=key(next);if(previous.has(nextKey)||solid.has(nextKey)||!walkable(next,definition))continue;previous.set(nextKey,currentKey);directions.set(nextKey,direction);queue.push(next);}
 }
 return null;
}
