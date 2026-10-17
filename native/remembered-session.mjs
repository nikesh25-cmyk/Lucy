// Local credential cache, deliberately outside Luanti world files and source backups.
import {mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,constants,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
export function rememberedSession(directory,api){
 const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
 const privateFile=path=>{const s=lstatSync(path);if(s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw new Error('Native saved connection must be private to this OS user.');return s};
 if(!privateFile(root).isDirectory())throw new Error('Invalid native connection directory.');
 const keyPath=join(root,'connection.nemo-key'),file=join(root,'remembered.nemoenc');
 try{const fd=openSync(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,randomBytes(32))}finally{closeSync(fd)}}catch(e){if(e.code!=='EEXIST')throw e}
 privateFile(keyPath);const key=readFileSync(keyPath);if(key.length!==32)throw new Error('Invalid native connection key.');
 const aad=Buffer.from('NemoWorld native connection v1\0'+api);
 const read=()=>{
  try{
   privateFile(file);const envelope=JSON.parse(readFileSync(file,'utf8'));
   if(envelope.version!==1)throw new Error('Invalid connection version');
   const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
   const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
   if(!/^[a-zA-Z0-9_-]{1,32}$/.test(value.player)||!/^[a-f0-9]{64}$/.test(value.token)||typeof value.agentId!=='string'||!Number.isSafeInteger(value.expires))throw new Error('Invalid connection');
   return value;
  }catch(e){if(e.code==='ENOENT')return null;throw new Error('Saved native connection is unreadable. Restore or remove the private connection cache, then sign in again.');}
 };
 // Authenticate at startup, so corrupt ciphertext is never silently replaced with a new identity.
 read();
 return {read,write(value){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  writeFileSync(temporary,JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600,flag:'wx'});
  try{renameSync(temporary,file)}finally{try{unlinkSync(temporary)}catch(e){if(e.code!=='ENOENT')throw e}}
 },clear(){try{unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}}};
}
