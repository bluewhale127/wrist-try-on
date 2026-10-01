import test from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from './vendor/three/three.module.js';
import {watchAxes,teacherAxesLabel} from './watch-teacher-axes.mjs';
const close=(a,b)=>assert.ok(new Vector3(...a).distanceTo(new Vector3(...b))<1e-8);
test('default dial puts twelve along -X and six along +X',()=>{
 const a=watchAxes(new Quaternion(),1);close(a.twelve,[-1,0,0]);close(a.six,[1,0,0]);close(a.front,[0,0,1]);close(a.back,[0,0,-1]);
});
test('handedness correction reverses clock direction without reversing face normal',()=>{
 const a=watchAxes(new Quaternion(),-1);close(a.twelve,[1,0,0]);close(a.front,[0,0,1]);
});
test('axes stay orthogonal and right handed throughout a wrist turn',()=>{
 for(let angle=-Math.PI;angle<=Math.PI;angle+=.1){
  const a=watchAxes(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),angle));
  const x=new Vector3(...a.three),y=new Vector3(...a.twelve),z=new Vector3(...a.front);
  assert.ok(Math.abs(y.dot(z))<1e-8);assert.ok(x.clone().cross(y).dot(z)>.999999);
  close(a.six,y.clone().negate().toArray());close(a.back,z.clone().negate().toArray());
 }
});
test('facing-away wrist has opposite normal without a camera-facing flip',()=>{
 const a=watchAxes(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI));close(a.front,[0,0,-1]);
});
test('uncalibrated and pending rotations never become approved axis labels',()=>{
 const base={rotation:new Quaternion(),watchSign:1,accepted:true,calibrated:true,diagnostic:{quality:.9,residual:.01},center:[100,120],width:60,frameTimeMs:1000};
 assert.ok(teacherAxesLabel(base));assert.equal(teacherAxesLabel({...base,calibrated:false}),null);
 assert.equal(teacherAxesLabel({...base,diagnostic:{quality:.9,residual:.01,turnPending:true}}),null);
 assert.equal(teacherAxesLabel({...base,rotation:new Quaternion(0,0,0,0)}),null);
});
