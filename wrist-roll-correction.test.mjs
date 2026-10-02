import test from 'node:test';import assert from 'node:assert/strict';
import {Vector3,Quaternion} from './vendor/three/three.module.js';
import {WristRollCorrection} from './wrist-roll-correction.mjs';
const Y=new Vector3(0,1,0),Z=new Vector3(0,0,1),q=a=>new Quaternion().setFromAxisAngle(Y,a*Math.PI/180);
const pose=a=>({rotation:q(a),position:new Vector3(3,4,5),size:65,wristRadius:30});
function run(c,p,a,b,options={}){let out;for(let t=100;t<=1000;t+=50)out=c.update(p,{rotation:q(a),depthRotation:q(b)},t,{quality:1,...options});return out;}
test('side correction reduces consistent overrotation while preserving forearm axis, position and scale',()=>{
 const c=new WristRollCorrection(),p=pose(80),out=run(c,p,65,67);
 assert.ok(out.rotation.angleTo(q(66))<p.rotation.angleTo(q(66)));
 assert.ok(out.rotation.angleTo(p.rotation)<=.25);assert.ok(Y.clone().applyQuaternion(out.rotation).distanceTo(Y.clone().applyQuaternion(p.rotation))<1e-10);
 assert.ok(out.position.equals(p.position));assert.equal(out.size,p.size);assert.ok(p.rotation.angleTo(q(80))<1e-7);
});
test('frontal back and palm remain unchanged, and palm stays behind the wrist',()=>{
 for(const a of [0,180]){const p=pose(a),out=run(new WristRollCorrection(),p,a+10,a+12);assert.ok(out.rotation.angleTo(p.rotation)<1e-7);}
 const p=pose(140),out=run(new WristRollCorrection(),p,135,137);assert.ok(Z.clone().applyQuaternion(out.rotation).z<0);
});
test('conflicting depth, low quality and front camera cannot add roll',()=>{
 for(const [a,b,options] of [[20,80,{}],[65,67,{quality:.5}],[65,67,{mirror:true}]]){
  const p=pose(80),out=run(new WristRollCorrection(),p,a,b,options);assert.ok(out.rotation.angleTo(p.rotation)<1e-7);
 }
});
test('single observations and loss cannot carry a trusted correction into a new pose',()=>{
 const c=new WristRollCorrection(),p=pose(80);c.update(p,{rotation:q(65),depthRotation:q(67)},100,{quality:1});assert.equal(c.diagnostic.trusted,false);
 run(c,p,65,67);const out=c.update(p,{rotation:q(65),depthRotation:q(67)},2000,{quality:1});assert.equal(c.diagnostic.trusted,false);assert.ok(out.rotation.angleTo(p.rotation)<1e-7);
});
