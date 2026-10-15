import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
test('native third-party textures match recorded CC0 provenance and content hashes',async()=>{
  const {assets}=JSON.parse(await readFile(new URL('./assets-manifest.json',import.meta.url)));
  assert.equal(assets.length,6);
  assert.equal(new Set(assets.map(a=>a.file)).size,assets.length);
  for(const asset of assets){
    assert.equal(asset.license,'CC0-1.0');
    assert.match(asset.file,/^nemoworld_game\/mods\/nemo\/textures\/nemo_cc0_[a-z]+\.jpg$/);
    assert.match(asset.source,/^https:\/\/ambientcg.com\/view\?id=/);
    const bytes=await readFile(new URL(asset.file,import.meta.url));
    assert.equal(bytes.length,asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.equal(bytes.readUInt16BE(0),0xffd8);
  }
});
