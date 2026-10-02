import test from 'node:test';import assert from 'node:assert/strict';
import {Vector3} from './vendor/three/three.module.js';import {fitBraceletPoint} from './datejust-bracelet.mjs';
test('bracelet fit preserves lug attachment and strap width while reducing side/depth gaps',()=>{
 const lug=new Vector3(.2,.56,.05);assert.deepEqual(fitBraceletPoint(lug,.85,1.1).toArray(),lug.toArray());
 const side=new Vector3(.2,1.075,-.6),fitted=fitBraceletPoint(side,.85,1.1);
 assert.equal(fitted.x,side.x);assert.ok(fitted.y<side.y&&fitted.z>side.z);assert.equal(side.y,1.075);
});
test('asset deformation remains finite, bounded and reproducible at fit limits',()=>{
 for(const ry of [.1,.8,1,4])for(const depth of [.1,1,4]){
  const source=new Vector3(.2,-1.075,-1.30),a=fitBraceletPoint(source,ry,depth),b=fitBraceletPoint(source,ry,depth);
  assert.ok(a.toArray().every(Number.isFinite));assert.ok(Math.abs(a.y)<=1.075*1.3+1e-8&&Math.abs(a.z)<=1.3*1.45+1e-8);assert.deepEqual(a.toArray(),b.toArray());
 }
});
