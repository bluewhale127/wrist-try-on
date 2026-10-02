import test from 'node:test';import assert from 'node:assert/strict';
import {Vector3,Quaternion} from './vendor/three/three.module.js';
import {WristCenterContinuation,cameraCenter} from './wrist-center-continuation.mjs';
const view={width:400,height:600,videoWidth:400,videoHeight:600};
const p=()=>({position:new Vector3(0,0,4),rotation:new Quaternion(),size:50,wristRadius:35});
const m=(time,x=200,score=.8)=>({time,width:400,height:600,pose:{accepted:score>=.55,x,y:300,score}});
test('wrist-only observations continue position without inventing axes or changing scale',()=>{
 const c=new WristCenterContinuation(),hand=p();c.update(hand,m(100),view,100,140);
 c.update(null,m(200,215),view,200,240);const pose=c.sample(250,view);
 assert.ok(pose.position.x>0&&pose.position.x<=15);assert.equal(pose.position.z,4);assert.ok(pose.rotation.equals(hand.rotation));assert.equal(pose.size,50);assert.equal(hand.position.x,0);
 for(let t=300;t<=5100;t+=100)c.update(null,m(t,215),view,t,t+30);
 assert.ok(c.sample(5130,view));assert.equal(c.diagnostic.orientation,'held');
});
test('center detection alone cannot initialize a 3D pose',()=>{
 const c=new WristCenterContinuation();c.update(null,m(100),view,100,140);
 assert.equal(c.diagnostic.state,'center-without-axes');assert.equal(c.sample(150,view),null);
});
test('missing observations and stale camera results never keep the watch displayed',()=>{
 const c=new WristCenterContinuation();c.update(p(),m(100),view,100,140);c.update(null,m(200),view,200,240);
 assert.equal(c.sample(421,view),null);c.update(null,m(450,200,.2),view,450,480);assert.equal(c.sample(490,view),null);
 c.update(null,m(500),view,500,800);assert.equal(c.sample(800,view),null);
});
test('remote peaks, different views and uncertain visible-hand axes stop continuation',()=>{
 for(const reason of ['jump','view','axes']){
  const c=new WristCenterContinuation();c.update(p(),m(100),view,100,140);
  c.update(null,m(200,reason==='jump'?390:200),reason==='view'?{...view,width:500}:view,200,240,false,reason!=='axes');
  assert.equal(c.sample(250,view),null,reason);
 }
});
test('returning hands replace the reference and front mirroring occurs exactly once',()=>{
 const c=new WristCenterContinuation();c.update(p(),m(100),view,100,140);c.update(null,m(200,210),view,200,240);
 const hand=p();hand.position.x=12;c.update(hand,m(300,212),view,300,340);assert.equal(c.sample(350,view),null);c.update(null,m(400,220),view,400,440);assert.ok(c.sample(450,view).position.x>12);
 assert.equal(cameraCenter(m(1,220),view,false).x,-cameraCenter(m(1,220),view,true).x);
 c.reset();assert.equal(c.sample(450,view),null);
});
