import test from 'node:test';import assert from 'node:assert/strict';
import {Vector3,Quaternion} from './vendor/three/three.module.js';
import {FistSurfaceGuard} from './fist-surface-guard.mjs';
const Y=new Vector3(0,1,0),Z=new Vector3(0,0,1),q=a=>new Quaternion().setFromAxisAngle(Y,a*Math.PI/180);
const pose=a=>({rotation:q(a),position:new Vector3(2,3,4),size:65});
const fist={calibration:{closed:true,open:false,inFrame:true}},open={calibration:{open:true,inFrame:true}};
test('fist projection crossing through the wrist cannot put the dial behind the arm',()=>{
 const g=new FistSurfaceGuard();let time=0;
 for(const angle of [0,30,60,75,100,140,179,-179,-150]){
  const p=pose(angle),r=g.update(p,fist,time+=80);
  assert.ok(Z.clone().applyQuaternion(r.rotation).z>=Math.cos(70*Math.PI/180)-1e-8);
  assert.ok(Y.clone().applyQuaternion(r.rotation).distanceTo(Y.clone().applyQuaternion(p.rotation))<1e-8);
  assert.equal(r.position,p.position);assert.equal(r.size,p.size);
 }
});
test('frontal and moderate fist rotations remain unchanged in either direction',()=>{
 for(const a of [-60,-30,0,30,60]){const p=pose(a),r=new FistSurfaceGuard().update(p,fist,100);assert.equal(r,p);}
});
test('open hands can rotate fully and a confirmed palm remains on the palm side after closing',()=>{
 const g=new FistSurfaceGuard();for(const t of [100,180,260])g.update(pose(0),open,t);
 for(const [a,t] of [[80,340],[120,420],[180,500]]){const p=pose(a);assert.equal(g.update(p,open,t,{surface:'palm',surfaceConfirmed:a===180}),p);}
 const r=g.update(pose(50),fist,600);assert.ok(Z.clone().applyQuaternion(r.rotation).z<0);
 g.reset();assert.ok(Z.clone().applyQuaternion(g.update(pose(150),fist,700).rotation).z>0);
});
test('a single false open-hand observation cannot release fist rotation limits',()=>{
 const g=new FistSurfaceGuard();g.update(pose(60),fist,100);
 const out=g.update(pose(130),open,180);assert.ok(Z.clone().applyQuaternion(out.rotation).z>0);
 assert.ok(Z.clone().applyQuaternion(g.update(pose(140),fist,260).rotation).z>0);
});
test('unconfirmed or cropped open observations cannot overwrite the remembered surface',()=>{
 for(const obs of [open,{calibration:{open:true,inFrame:false}}]){
  const g=new FistSurfaceGuard();g.update(pose(180),obs,100,{surface:'palm',surfaceConfirmed:!obs.calibration.inFrame});
  assert.ok(Z.clone().applyQuaternion(g.update(pose(140),fist,200).rotation).z>0);
 }
});
