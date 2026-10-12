import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraWalkDirection} from '../src/camera-controls.js';
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
