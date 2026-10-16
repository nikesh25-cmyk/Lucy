import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { createResources, cubeBatch, disposeBatch } from '../src/scene/batch.js';

const records = (batch) => {
  const matrix = new THREE.Matrix4(), colour = new THREE.Color(), output = [];
  for (const mesh of batch.group.children) for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, matrix);
    if (mesh.instanceColor) mesh.getColorAt(index, colour); else colour.set(0xffffff);
    colour.multiply(mesh.material.color);
    output.push({ matrix: [...matrix.elements], colour: colour.getHexString(), pick: mesh.userData.picks[index],
      style: mesh.userData.style, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow,
      transparent: mesh.material.transparent, opacity: mesh.material.opacity, depthWrite: mesh.material.depthWrite,
      emissive: mesh.material.emissive?.getHexString(), emissiveIntensity: mesh.material.emissiveIntensity });
  }
  return output.sort((a, b) => a.pick.id.localeCompare(b.pick.id));
};

test('opaque solid colour batching preserves each instance, pick, exact colour and material behavior', () => {
  const resources = createResources(), ordinary = cubeBatch(resources), combined = cubeBatch(resources, { instanceSolidColors: true });
  const parts = [
    [1, .5, 2, 1, 1, 1, '#397f79', { id: 'teal-ground' }, 'solid'],
    [3, .8, 4, .2, 1.6, .2, '#81664a', { id: 'tree-trunk' }, 'solid'],
    [5, 2.1, 6, 1.4, .7, 1.4, '#86b36f', { id: 'tree-crown' }, 'solid'],
    [7, 1, 8, .3, .4, .05, '#9bcfc4', { id: 'emissive-pane' }, 'glow'],
    [9, 1, 10, .3, .4, .05, '#d5e2e1', { id: 'glass-pane' }, 'glass'],
  ];
  for (const part of parts) { ordinary.add(...part); combined.add(...part); }
  const before = ordinary.finish(), after = combined.finish();
  assert.equal(before.batches, 5);
  assert.equal(after.batches, 3, 'three opaque colour batches become one; translucent and emissive styles remain independent');
  assert.equal(after.cubes, before.cubes);
  assert.deepEqual(records(after), records(before));
  assert.equal(after.group.children.filter((mesh) => mesh.instanceColor).length, 1);
  assert.ok(after.group.children.filter((mesh) => mesh.userData.style !== 'solid').every((mesh) => !mesh.instanceColor));
  disposeBatch(before); disposeBatch(after); resources.dispose();
});
