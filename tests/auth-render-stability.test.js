import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture(name,end){
 const nodes=new Map(),inputs=[];
 const element=(tag,text)=>({tag,textContent:text||'',dataset:{},children:[],value:'',open:false,append(...items){this.children.push(...items)},replaceChildren(...items){this.children=[...items]},get firstChild(){return this.children[0]},setAttribute(){}});
 const $=id=>{if(!nodes.has(id))nodes.set(id,element('div'));return nodes.get(id)};
 const state={account:null,setup:false,authMode:'login',registrationOpen:true,gamePresentation:false,sessionEpoch:0};
 const append=(node,...items)=>{node.append(...items);return node};
 const field=(form,name,label,options={})=>{const input=element('input');input.name=name;input.value=options.value||'';inputs.push(input);form.append(input);return input};
 const env={state,$,element,append,field,button:(label,callback)=>element('button',label),card:()=>element('section'),paragraph:()=>element('p'),form:parent=>append(parent,element('form')).children.at(-1),renderEntryControls:()=>{},finishAuth:()=>{$('#auth-dialog').open=false}};
 const body=source.slice(source.indexOf(`function ${name}(`),source.indexOf(`function ${end}(`));
 const render=new Function(...Object.keys(env),`return (${body.trim()})`)(...Object.values(env));
 return{render,state,$,inputs};
}
test('background auth renders preserve the open form and typed credentials only in its current DOM',()=>{
 const f=fixture('renderAuth','renderTabs');f.render();const form=f.$('#auth-area').firstChild,password=f.inputs.find(i=>i.name==='password');password.value='disposable-password';f.$('#auth-dialog').open=true;
 for(let i=0;i<5;i++)f.render();
 assert.equal(f.$('#auth-area').firstChild,form);assert.equal(password.value,'disposable-password');
 f.$('#auth-dialog').open=false;f.render();assert.notEqual(f.$('#auth-area').firstChild,form);assert.ok(f.inputs.slice(-7).every(i=>i.name!=='password'||i.value===''));
});
test('changing auth mode or ending the session rebuilds forms without retaining another session credentials',()=>{
 const f=fixture('renderAuth','renderTabs');f.render();f.$('#auth-dialog').open=true;const initial=f.$('#auth-area').firstChild;
 f.state.authMode='register';f.render();assert.notEqual(f.$('#auth-area').firstChild,initial);
 f.state.account={id:'a',name:'Example',role:'member'};f.render();assert.equal(f.$('#auth-area').children.length,0);
 f.state.account=null;f.state.sessionEpoch++;f.render();assert.ok(f.$('#auth-area').firstChild);
});
test('session controls survive unrelated redraws but are replaced when identity or role changes',()=>{
 const f=fixture('renderSession','renderAuth');f.render();const signin=f.$('#session-bar').children[1];f.render();assert.equal(f.$('#session-bar').children[1],signin);
 f.state.account={id:'a',name:'Example',role:'member'};f.render();assert.notEqual(f.$('#session-bar').children[1],signin);const profile=f.$('#session-bar').children[1];f.render();assert.equal(f.$('#session-bar').children[1],profile);
 f.state.account.role='reviewer';f.render();assert.notEqual(f.$('#session-bar').children[1],profile);
});
