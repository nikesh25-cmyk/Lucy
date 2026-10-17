import test from 'node:test';
import assert from 'node:assert/strict';
import { cityLines } from '../src/veloren-ext/city-guide.js';
test('native guide reports saved city totals without exposing job tokens or claiming model reasoning',()=>{
 assert.match(cityLines({}).join(' '),/disabled/);
 const lines=cityLines({nativeCity:{overview:()=>({enabled:true,citizens:[{name:'Ada',stage:'adult',role:'build'}],marriages:[{}],births:[],reports:[{}],harvests:[],attendance:[],assessments:[],plans:[{id:'city-ada',target:'city-office',activity:'build',state:'issued',cmd_id:'private-command-marker'}]})}}).join(' ');
 assert.match(lines,/1 citizens/);assert.match(lines,/scripted/i);assert.match(lines,/Ada/);assert.doesNotMatch(lines,/private-command-marker/);
});
