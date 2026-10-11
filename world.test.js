import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { move, landmarkAt, start } from './world.js';

test('movement reaches a landmark and respects map boundaries', () => {
  let position = start;
  for (let i = 0; i < 6; i++) position = move(position, 'left');
  for (let i = 0; i < 3; i++) position = move(position, 'up');
  strictEqual(landmarkAt(position)?.name, 'Climate Grove');
  for (let i = 0; i < 20; i++) position = move(position, 'left');
  deepStrictEqual(position, { x: 0, y: 3 });
  deepStrictEqual(move(position, 'unknown'), position);
});
