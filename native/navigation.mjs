import {getWorldDefinition,walkable} from '../world.js';
import {sceneryBlocks} from '../src/footprints.js';
const offsets={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
export function nativeWorld(id){try{const d=getWorldDefinition(id);return d.columns<=96&&d.rows<=64&&d.columns>0&&d.rows>0}catch{return false}}
export function planNativeWalk(agent,view,input){
 const definition=getWorldDefinition(view.world),id=(x,y)=>x+','+y;
 const occupied=new Set([...(view.blocks||[]).filter(b=>b.type!=='path').map(b=>id(b.x,b.y)),...(view.objects||[]).filter(o=>sceneryBlocks(o.type)).map(o=>id(o.x,o.y)),...(view.participants||[]).filter(p=>p.id!==agent.id).map(p=>id(p.x,p.y))]);
 const clear=(x,y)=>walkable({x,y},definition)&&!occupied.has(id(x,y));
 let accepts,buildTarget=null,finish={};
 if(input.kind==='plot'){
  const plot=view.frontier?.my_plot;
  if(!plot||plot.world_id!==agent.world_id)throw Object.assign(new Error('Choose your free plot in this frontier area first.'),{status:409});
  const within=(x,y)=>x>=plot.x&&x<plot.x+6&&y>=plot.y&&y<plot.y+6;
  accepts=(x,y)=>{if(!within(x,y))return false;for(const [dx,dy] of Object.values(offsets)){if(within(x+dx,y+dy)&&clear(x+dx,y+dy)){buildTarget={x:x+dx,y:y+dy};return true}}return false};
 }else if(input.kind==='portal'){
  const portal=(view.portals||[]).find(p=>p.target_world_id===input.world_id);
  const gate=(view.frontier?.neighbors||[]).find(p=>p.target_world_id===input.world_id);
  if(!portal&&!gate)throw Object.assign(new Error('Choose an entrance in the current world.'),{status:403});
  const target=portal||gate;accepts=(x,y)=>Math.abs(x-target.x)+Math.abs(y-target.y)<=(gate?0:1);
  finish={world_id:input.world_id,...(gate?{direction:gate.direction,expand:!gate.exists}:{})};
 }else if(input.kind==='home'&&view.own_home?.id===input.world_id){return{world_id:agent.world_id,directions:[],finish:{world_id:input.world_id}}}
 else throw Object.assign(new Error('Choose your plot, home or an available entrance.'),{status:400});
 const origin={x:agent.x,y:agent.y},queue=[origin],seen=new Map([[id(origin.x,origin.y),null]]);let found;
 for(let i=0;i<queue.length&&i<6144;i++){
  const p=queue[i];if(accepts(p.x,p.y)){found=p;break}
  for(const [direction,[dx,dy]] of Object.entries(offsets)){
   const x=p.x+dx,y=p.y+dy,k=id(x,y);
   if(!seen.has(k)&&clear(x,y)){seen.set(k,{from:id(p.x,p.y),direction});queue.push({x,y})}
  }
 }
 if(!found)throw Object.assign(new Error('No clear walking route is available. Move around the obstruction and try again.'),{status:409});
 const directions=[];for(let k=id(found.x,found.y);seen.get(k);k=seen.get(k).from)directions.push(seen.get(k).direction);
 directions.reverse();return{world_id:agent.world_id,origin,goal:found,directions,build_target:buildTarget,finish};
}
