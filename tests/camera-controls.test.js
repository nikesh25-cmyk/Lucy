import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraWalkDirection,POINTER_DRAG_THRESHOLD,pointerGesture,WALK_KEYS,TURN_KEYS,keyIntent,controlIntent,createLookScheduler,facingLabel,reticleText} from '../src/camera-controls.js';
test('first-person walking follows the camera on all four sides of the world', () => {
  for (const [yaw, forward, right] of [[0,'up','right'],[Math.PI/2,'left','up'],[Math.PI,'down','left'],[-Math.PI/2,'right','down']]) {
    assert.equal(cameraWalkDirection('up',yaw),forward);
    assert.equal(cameraWalkDirection('right',yaw),right);
    const inverse={up:'down',down:'up',left:'right',right:'left'};
    assert.equal(cameraWalkDirection('down',yaw),inverse[forward]);
    assert.equal(cameraWalkDirection('left',yaw),inverse[right]);
  }
});
test('wrapped camera directions agree and malformed input cannot create a movement action',()=>{
  assert.equal(cameraWalkDirection('up',2*Math.PI+.2),cameraWalkDirection('up',.2));
  for(const [direction,yaw] of [['jump',0],['up',NaN],['left',Infinity]])assert.throws(()=>cameraWalkDirection(direction,yaw),TypeError);
});
test('one pointer gesture is either a look or a pick, never both',()=>{
  assert.equal(POINTER_DRAG_THRESHOLD,6);
  assert.equal(pointerGesture(0),'pick');
  assert.equal(pointerGesture(POINTER_DRAG_THRESHOLD),'pick','a click at the threshold is still a pick');
  assert.equal(pointerGesture(POINTER_DRAG_THRESHOLD+.01),'look');
  for(const distance of [-5,0,3,6,6.5,40,1e6])assert.ok(['look','pick'].includes(pointerGesture(distance)),'every measured distance resolves to one gesture');
  for(const distance of [NaN,Infinity,-Infinity,undefined,null,'6'])assert.equal(pointerGesture(distance),'pick','unusable distances cannot start a look drag');
});
test('keyboard controls keep walking, turning and frontier block selection working',()=>{
  assert.deepEqual({...WALK_KEYS},{ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',w:'up',a:'left',s:'down',d:'right'});
  assert.deepEqual({...TURN_KEYS.q},{yaw:.35,pitch:0});assert.deepEqual({...TURN_KEYS.e},{yaw:-.35,pitch:0});
  assert.deepEqual({...TURN_KEYS.r},{yaw:0,pitch:.25});assert.deepEqual({...TURN_KEYS.f},{yaw:0,pitch:-.25});
  for(const [key,direction] of Object.entries(WALK_KEYS))assert.deepEqual(keyIntent(key,{agent:true}),{kind:'walk',direction});
  assert.deepEqual(keyIntent('q',{agent:true}),{kind:'turn',yaw:.35,pitch:0});
  assert.deepEqual(keyIntent('3',{frontier:true,palette:['stone','wood','glass'],agent:true}),{kind:'build',type:'glass'});
  assert.equal(keyIntent('9',{frontier:true,palette:['stone'],agent:true}),null,'a digit outside the palette selects nothing');
  assert.equal(keyIntent('3',{frontier:false,palette:['stone','wood'],agent:true}),null,'block digits belong to the frontier');
  assert.equal(keyIntent('3',{frontier:true,palette:['stone','wood'],agent:false}),null,'a visitor cannot select blocks');
  for(const key of ['z','Enter',' ','Tab','1'])assert.equal(keyIntent(key,{agent:true}),null);
});
test('a turn issues a look, a walk issues a movement, and a look never carries a walking direction',()=>{
  const look=controlIntent('up',{lookMode:true});
  assert.deepEqual(look,{kind:'look',turn:'up'});assert.equal('direction' in look,false);
  for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2,2.4]){
    const move=controlIntent('up',{firstPerson:true,yaw});
    assert.deepEqual(move,{kind:'move',direction:cameraWalkDirection('up',yaw)});
    assert.ok(['up','down','left','right'].includes(move.direction));
  }
  assert.deepEqual(controlIntent('left',{firstPerson:false}),{kind:'move',direction:'left'},'the orbiting view walks the absolute cardinal');
  assert.deepEqual(controlIntent('left',{firstPerson:false,lookMode:true}),{kind:'look',turn:'left'},'turn mode rotates instead of walking');
  assert.deepEqual(controlIntent('down',{firstPerson:true,lookMode:true,keyboard:true,yaw:Math.PI/2}),{kind:'move',direction:cameraWalkDirection('down',Math.PI/2)},'WASD still walks in first person with turn mode on');
  assert.deepEqual(controlIntent('down',{firstPerson:true,lookMode:true,yaw:Math.PI/2}),{kind:'look',turn:'down'},'the on-screen buttons turn in first person');
});
test('the look scheduler coalesces a drag burst into one request and never sends movement',()=>{
  let now=1000,pending=null,canceled=0;const calls=[];
  const scheduler=createLookScheduler({send:(...args)=>calls.push(args),now:()=>now,
    schedule:(run,delay)=>{pending={run,at:now+delay};return pending;},cancel:()=>{canceled++;pending=null;},delay:150});
  const advance=ms=>{now+=ms;if(pending&&pending.at<=now){const run=pending.run;pending=null;run();}};
  assert.equal(scheduler.request(),'sent');assert.deepEqual(calls,[[]]);assert.equal(scheduler.pending,false);
  for(let index=0;index<12;index++)assert.equal(scheduler.request(),'queued','a burst inside the window queues instead of double-firing');
  assert.equal(calls.length,1);assert.equal(scheduler.pending,true);assert.equal(pending.at,1150,'one coalesced flush is scheduled for the end of the window');
  advance(149);assert.equal(calls.length,1,'nothing fires early');
  advance(1);assert.equal(calls.length,2);assert.equal(scheduler.pending,false);assert.deepEqual(calls[1],[]);
  assert.equal(scheduler.request(),'queued');scheduler.cancel();
  assert.equal(canceled,1);assert.equal(scheduler.pending,false);assert.equal(pending,null);
  advance(5000);assert.equal(calls.length,2,'a canceled look never fires on its own');
  now+=1000;assert.equal(scheduler.request(),'sent');assert.equal(calls.length,3);
  assert.ok(calls.every((args)=>args.length===0),'the scheduler hands the caller no direction, so a look cannot move a resident');
  assert.throws(()=>createLookScheduler({}),TypeError);
  assert.equal(createLookScheduler({send(){},delay:-1}).request(),'sent');
});
test('the aim line reads back the view, the elevation and the picked tile in plain text',()=>{
  assert.equal(facingLabel(0),'north');assert.equal(facingLabel(Math.PI/4),'north-west');assert.equal(facingLabel(Math.PI/2),'west');
  assert.equal(facingLabel(Math.PI),'south');assert.equal(facingLabel(-Math.PI/2),'east');assert.equal(facingLabel(3*Math.PI/4),'south-west');
  assert.equal(facingLabel(Infinity),'north');
  const first=reticleText({firstPerson:true,facing:{yaw:0,pitch:0},position:{x:10,y:6,z:0},selection:{x:11,y:6,z:0,type:'terrain'},blocked:false});
  assert.match(first,/First person/);assert.match(first,/facing north/);assert.match(first,/at 10, 6, layer 0/);assert.match(first,/aimed at ground 11, 6 · walkable/);assert.match(first,/WASD walks the way you face/);
  const solid=reticleText({firstPerson:true,facing:{yaw:Math.PI/2},position:{x:1,y:2},selection:{x:2,y:2,type:'object'},blocked:true});
  assert.match(solid,/facing west/);assert.match(solid,/aimed at scenery 2, 2 · solid, walk around it/);
  const orbiting=reticleText({facing:{yaw:-Math.PI/2},position:{x:3,y:4}});
  assert.match(orbiting,/Orbiting view/);assert.match(orbiting,/facing east/);assert.match(orbiting,/no tile picked yet/);assert.match(orbiting,/click open ground to walk/);
  for(const text of [first,solid,orbiting])assert.equal(/[<>]/.test(text),false,'the aim line is text, never markup');
});
