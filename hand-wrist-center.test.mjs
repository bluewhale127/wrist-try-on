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
test('only matching fresh frames can correct; correction expires and camera change clears usage',()=>{
 const f=new HandWristCenter(),original=pose();
 assert.equal(f.update(original,measurement,view,settings,100,130),true);
 assert.notDeepEqual(f.apply(original,140,view).position.toArray(),original.position.toArray());
 assert.strictEqual(f.apply(original,241,view),original);
 assert.strictEqual(f.apply(original,140,{...view,width:401}),original);
 assert.equal(f.update(original,{...measurement,time:100},view,settings,180,190),false);
 assert.strictEqual(f.apply(original,190,view),original);
 assert.equal(f.update(original,{...measurement,time:200},view,settings,200,450),false);
});
