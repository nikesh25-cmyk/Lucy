import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge, localApiOrigin, nativeToNemo, nemoToNative} from './bridge.mjs';

const key = 'x'.repeat(64), token = 'a'.repeat(64);
test('operator token can only be forwarded to a literal local API origin', () => {
  assert.equal(localApiOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const api of [
    'http://example.com', 'https://example.com', 'http://localhost:3000',
    'http://127.0.0.1.example.com:3000', 'http://user@127.0.0.1:3000',
    'http://127.0.0.1:3000/elsewhere', 'http://127.0.0.1:3000/?next=remote',
  ]) {
    assert.throws(() => localApiOrigin(api), /literal http:\/\/127\.0\.0\.1/);
    let fetched = false;
    assert.throws(() => createBridge({api, modKey:key, fetcher:async () => { fetched = true; }}), /literal http:\/\/127\.0\.0\.1/);
    assert.equal(fetched, false);
  }
});
function fixture() {
  let revoked = false;
  let agentWorld = 'frontier:0:0';
  let heldOwner = null;
  const calls = [];
  let loginRequest;
  const fake = async (url, options) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    calls.push({path, method:options.method, payload:options.body && JSON.parse(options.body)});
    if (revoked) return new Response(JSON.stringify({error:'revoked'}), {status:401});
    if (path === '/auth/login') { loginRequest = options; return Response.json({token, expires_at:Date.now()+60000, account:{id:'operator-1'}}); }
    if (path === '/me') {
      if (heldOwner) { const held = heldOwner; heldOwner = null; held.enter(); await held.wait; }
      return Response.json({agents:[{id:'human-1',kind:'human',status:'active',world_id:agentWorld,x:24,y:24,z:0}]});
    }
    if (path === '/world') return Response.json({world:{id:agentWorld},blocks:[{id:'block-1',x:25,y:24,z:0,type:'stone'}],terrain:[],participants:[],camera:{x:0,y:0},frontier:{neighbors:[{direction:'right',x:46,y:24,target_world_id:'frontier:1:0',exists:true}]}});
    if (path === '/frontier/build') return Response.json({world_id:agentWorld, changed:true});
    if (path === '/move') return Response.json({x:25,y:24,z:0,world_id:agentWorld});
    return new Response('{}', {status:404});
  };
  const server = createBridge({fetcher:fake, modKey:key});
  return {server, calls, revoke:() => {revoked=true}, setWorld: value => {agentWorld=value}, loginRequest:() => loginRequest,
    holdNextOwner:() => {
      let enter, release;
      const entered = new Promise(resolve => {enter=resolve});
      const wait = new Promise(resolve => {release=resolve});
      heldOwner = {enter,wait};
      return {entered,release};
    }};
}
async function withServer(run) {
  const f = fixture();
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const pairIds = new Map();
  const post = async (path, body, auth=false, extraHeaders={}) => {
    const payload = path.startsWith('/native/') && path !== '/native/pair' && body.player ? {...body,pair_id:pairIds.get(body.player)} : body;
    const response = await fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json', ...(auth ? {'X-Nemo-Mod-Key':key} : {}), ...extraHeaders},body:JSON.stringify(payload)});
    const result = {status:response.status, body:await response.json()};
    if (path === '/native/pair' && result.status === 200) pairIds.set(body.player,result.body.pair_id);
    return result;
  };
  try {await run({...f, post, base})} finally {await new Promise(resolve => f.server.close(resolve))}
}

test('sector coordinates and finite block layers', () => {
  assert.deepEqual(nativeToNemo({x:47,y:7,z:0}), {x:47,y:0,z:7});
  assert.deepEqual(nemoToNative({x:47,y:0,z:7}), {x:47,y:7,z:0});
  for (const pos of [{x:48,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:8,z:0},{x:0,y:0,z:48}]) assert.throws(() => nativeToNemo(pos));
});
test('one-time pairing, native callback build, web projection, revocation and mod authentication', async () => withServer(async ({post,calls,revoke,base}) => {
  const issued = await post('/pair/start', {token,agent_id:'human-1'});
  assert.equal(issued.status,200);
  const code = issued.body.code;
  assert.equal((await post('/native/pair',{player:'Builder',code})).status,401);
  const paired = await post('/native/pair',{player:'Builder',code},true);
  assert.equal(paired.status,200);
  assert.equal((await post('/native/pair',{player:'Other',code},true)).status,401);
  const state = await post('/native/state',{player:'Builder'},true);
  assert.equal(state.status,200);
  assert.deepEqual(state.body.blocks, [{id:'block-1',x:25,y:24,z:0,type:'stone'}]);
  assert.equal(calls.filter(c=>c.path==='/world').length,12);
  const placed = await post('/native/action',{player:'Builder',action:'place',type:'wood',pos:{x:25,y:0,z:24}},true);
  assert.equal(placed.status,200);
  assert.deepEqual(calls.at(-1), {path:'/frontier/build',method:'POST',payload:{agent_id:'human-1',world_id:'frontier:0:0',x:25,y:24,z:0,type:'wood'}});
  assert.equal((await post('/native/action',{player:'Builder',action:'place',type:'wood',pos:{x:48,y:0,z:24}},true)).status,400);
  assert.equal((await post('/native/action',{player:'Builder',action:'move',direction:'right'},true)).status,200);
  const replacement = await post('/pair/start',{token,agent_id:'human-1'});
  assert.equal((await post('/native/pair',{player:'Builder',code:replacement.body.code},true)).status,200);
  const stale = await fetch(`${base}/native/action`,{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Mod-Key':key},body:JSON.stringify({player:'Builder',pair_id:paired.body.pair_id,action:'move',direction:'right'})});
  assert.equal(stale.status,401,'a callback from the previous pairing cannot act as the replacement avatar');
  assert.equal((await post('/native/state',{player:'Builder'},true)).status,200);
  revoke();
  assert.equal((await post('/native/action',{player:'Builder',action:'move',direction:'right'},true)).status,401);
}));

test('native state and builds follow the owned human into an opened adjacent sector', async () => withServer(async ({post,calls,setWorld}) => {
  const issued = await post('/pair/start', {token,agent_id:'human-1'});
  assert.equal((await post('/native/pair',{player:'Walker',code:issued.body.code},true)).status,200);
  setWorld('frontier:1:0');
  const moved = await post('/native/action',{player:'Walker',action:'move',direction:'right'},true);
  assert.equal(moved.status,200);
  assert.equal(moved.body.result.world_id,'frontier:1:0');
  const state = await post('/native/state',{player:'Walker'},true);
  assert.equal(state.status,200);
  assert.equal(state.body.world_id,'frontier:1:0');
  const build = await post('/native/action',{player:'Walker',action:'place',type:'wood',pos:{x:25,y:0,z:24}},true);
  assert.equal(build.status,200);
  assert.equal(calls.at(-1).payload.world_id,'frontier:1:0');
}));

test('a slower earlier pair response cannot replace the latest pairing', async () => withServer(async ({post,holdNextOwner}) => {
  const first = await post('/pair/start',{token,agent_id:'human-1'});
  const second = await post('/pair/start',{token,agent_id:'human-1'});
  const held = holdNextOwner();
  const earlier = post('/native/pair',{player:'Builder',code:first.body.code},true);
  await held.entered;
  const latest = await post('/native/pair',{player:'Builder',code:second.body.code},true);
  assert.equal(latest.status,200);
  held.release();
  assert.equal((await earlier).status,409);
  assert.equal((await post('/native/state',{player:'Builder'},true)).status,200);
}));

test('local browser sign-in returns only an in-memory handle and requires origin plus CSRF', async () => withServer(async ({post,calls,base,loginRequest}) => {
  assert.equal((await post('/pair/login',{email:'operator@example.org',password:'private-password'})).status,403);
  const page = await fetch(base + '/');
  const html = await page.text();
  const csrf = html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  const headers = {'Origin':base, 'X-CSRF-Token':csrf};
  const signedIn = await post('/pair/login',{email:'operator@example.org',password:'private-password'},false,headers);
  assert.equal(signedIn.status,200);
  assert.match(signedIn.body.login_id,/^[a-f0-9]{48}$/);
  assert.deepEqual(signedIn.body.agents,[{id:'human-1',name:'human-1',status:'active',world_id:'frontier:0:0'}]);
  assert.equal(loginRequest().headers['X-API-Client'],'operator');
  assert.equal(loginRequest().headers.Authorization,undefined);
  const started = await post('/pair/start',{login_id:signedIn.body.login_id,agent_id:'human-1'},false,headers);
  assert.equal(started.status,200);
  assert.equal('token' in started.body,false);
  assert.equal((await post('/pair/start',{login_id:signedIn.body.login_id,agent_id:'human-1'},false,headers)).status,401);
}));
