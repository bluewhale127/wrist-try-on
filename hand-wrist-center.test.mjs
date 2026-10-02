import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3,Quaternion,Euler} from './vendor/three/three.module.js';
import {substituteWristCenter,HandWristCenter} from './hand-wrist-center.mjs';
import {defaultFit} from './fit-settings.js';
import {wristDimensions} from './wrist-rig.js';
const settings={...defaultFit(),offset:.5};
const view={width:400,height:600,videoWidth:1280,videoHeight:720};
function pose(){return {position:new Vector3(0,0,7),rotation:new Quaternion().setFromEuler(new Euler(.2,.3,.1)),size:100,wristRadius:45,imagePalm:[new Vector3(0,0),new Vector3(-30,100),new Vector3(0,120),new Vector3(10,110),new Vector3(30,100)]};}
const measurement={pose:{x:360,y:202.5,score:.8,accepted:true},width:720,height:405,time:100};
test('projected wearing surface uses model center once; depth, rotation, scale stay intact',()=>{
 const original=pose(),before=original.position.toArray(),r=substituteWristCenter(original,measurement,view,settings);
 assert.ok(r.used);assert.deepEqual(original.position.toArray(),before);
 const offset=new Vector3(0,0,wristDimensions(original.wristRadius/(.65*.46),settings['wrist-width'],settings['wrist-depth']).radiusZ).applyQuaternion(original.rotation);
 const target=r.pose.position.clone().add(offset);
 assert.ok(Math.abs(target.x)<1e-8&&Math.abs(target.y)<1e-8);
 assert.equal(r.pose.position.z,7);assert.strictEqual(r.pose.rotation,original.rotation);assert.equal(r.pose.size,100);assert.equal(r.pose.wristRadius,45);
});
test('front reflection and portrait cover crop map measurement consistently',()=>{
 const m={...measurement,pose:{...measurement.pose,x:370}};
 const back=substituteWristCenter(pose(),m,view,settings,false),front=substituteWristCenter(pose(),m,view,settings,true);
 assert.ok(back.used&&front.used);assert.equal(back.center[0],-front.center[0]);assert.equal(back.center[1],front.center[1]);
});
test('manual wearing offset still works after replacing geometric center rule',()=>{
 const base=substituteWristCenter(pose(),measurement,view,settings),shifted=substituteWristCenter(pose(),measurement,view,{...settings,offset:.7});
 assert.ok(shifted.used);assert.ok(shifted.pose.position.y<base.pose.position.y);
});
test('missing hand, low score, remote hand and outside-camera values never fabricate a pose',()=>{
 assert.equal(substituteWristCenter(null,measurement,view,settings).pose,null);
 for(const p of [{x:360,y:202.5,score:.2,accepted:false},{x:1,y:1,score:.99,accepted:true},{x:NaN,y:100,score:.99,accepted:true}]){
  const original=pose(),r=substituteWristCenter(original,{...measurement,pose:p},view,settings);assert.equal(r.used,false);assert.strictEqual(r.pose,original);
 }
});
const back={state:'tracking',surface:'back',surfaceConfirmed:true};
function fitted(){
 const f=new HandWristCenter(),p=pose();
 for(let t=100;t<=2100;t+=100)f.update(p,{...measurement,time:t},view,settings,t,t+40,false,back);
 return {f,p};
}
test('only consistent fresh dorsal observations can learn an offset',()=>{
 const f=new HandWristCenter(),p=pose();
 for(let t=100;t<=2000;t+=100){
  f.update(p,{...measurement,time:t-1},view,settings,t,t+40,false,back);assert.strictEqual(f.apply(p,t+50,view),p);
 }
 const {f:fit,p:original}=fitted();assert.ok(fit.binding);
 assert.notDeepEqual(fit.apply(original,2150,view).position.toArray(),original.position.toArray());
 assert.strictEqual(fit.apply(original,2150,{...view,width:401}),original);
 assert.strictEqual(fit.apply(null,2150,view),null);
});
test('misses, 140ms gaps and palm observations do not snap to the old geometric center',()=>{
 const {f,p}=fitted(),before=f.apply(p,2150,view).position.clone();
 f.update(p,null,view,settings,2200,2250,false,back);
 assert.deepEqual(f.apply(p,2250,view).position.toArray(),before.toArray());
 f.update(p,{...measurement,time:2300,pose:{...measurement.pose,x:390}},view,settings,2300,2340,false,{...back,surface:'palm'});
 assert.deepEqual(f.apply(p,2441,view).position.toArray(),before.toArray());
 for(let t=2400;t<=3000;t+=100)f.update(p,{...measurement,time:t,pose:{...measurement.pose,x:390}},view,settings,t,t+40,false,{...back,moving:true});
 assert.deepEqual(f.apply(p,3041,view).position.toArray(),before.toArray());
 assert.strictEqual(f.apply(p,4201,view),p);
});
test('the wearing offset follows hand rotation and scale without changing its axes',()=>{
 const {f,p}=fitted(),base=f.apply(p,2150,view).position.clone().sub(p.position);
 const rotation=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2).multiply(p.rotation);
 const turned={...p,rotation,wristRadius:p.wristRadius*2};
 f.update(turned,null,view,settings,2200,2250,false,{...back,surface:'edge'});
 const result=f.apply(turned,2250,view),actual=result.position.clone().sub(turned.position);
 const expected=base.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2)).multiplyScalar(2);
 assert.ok(actual.distanceTo(expected)<1e-8);assert.strictEqual(result.rotation,rotation);assert.equal(result.size,p.size);
});
test('long lost hands, explicit resets and changed camera views discard the stored fit',()=>{
 for(const change of ['loss','reset','view']){
  const {f,p}=fitted();
  if(change==='loss')f.update(null,null,view,settings,3500,3550);
  if(change==='reset')f.reset();
  if(change==='view')f.update(p,null,{...view,width:401},settings,2200,2250);
  assert.equal(f.binding,null);
 }
});
