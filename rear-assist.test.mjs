import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vector3,Quaternion} from './vendor/three/three.module.js';
import {pyramid,wristFeatures,trackWrist,robustMotion} from './wrist-flow.js';
import {RearWristAssist,rearObservation} from './rear-assist.js';
import {estimateWristPose,WristPoseTracker} from './pose.js';

// Analytic textured surface, independently rendered at each transform. There
// is no AR watch and no reuse of estimated motion to create the next frame.
function frame({dx=0,dy=0,scale=1,angle=0,blank=false,cut=false}={}){
  const width=240,height=240,data=new Uint8Array(width*height),c=Math.cos(angle),s=Math.sin(angle);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const xx=(x-120-dx)/scale,yy=(y-120-dy)/scale;
    const u=xx*c+yy*s,v=-xx*s+yy*c;
    data[y*width+x]=blank?128:cut?Math.round(128+45*Math.sin(u*.79)*Math.cos(v*.63)+30*Math.cos(u*.51-v*.19)):Math.round(128+34*Math.sin(u*.38)*Math.cos(v*.29)+24*Math.cos(u*.18+v*.37)+18*Math.sin(u*.63-v*.46));
  }
  return {width,height,data};
}
const roi={x:120,y:120,rx:38,ry:38};
const view={width:240,height:240,videoWidth:240,videoHeight:240};
const pose=()=>({position:new Vector3(),rotation:new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3),size:80,wristRadius:46});

test('pixel flow follows translation, approach zoom and image rotation',()=>{
  const a=frame(),points=wristFeatures(a,roi);assert.ok(points.length>=15);
  const b=frame({dx:5,dy:-4,scale:1.07,angle:.035}),motion=trackWrist(pyramid(a),pyramid(b),points);
  assert.ok(motion);
  const x=motion.a*120-motion.b*120+motion.tx,y=motion.b*120+motion.a*120+motion.ty;
  assert.ok(Math.abs(x-125)<.5&&Math.abs(y-116)<.5);
  assert.ok(Math.abs(motion.scale-1.07)<.015);
  assert.ok(Math.abs(motion.angle-.035)<.015);
});
test('textureless images, a cut, and disappearing wrist cannot provide motion',()=>{
  const a=frame(),points=wristFeatures(a,roi);
  assert.equal(wristFeatures(frame({blank:true}),roi).length,0);
  assert.equal(trackWrist(pyramid(a),pyramid(frame({blank:true})),points),null);
  assert.equal(trackWrist(pyramid(a),pyramid(frame({cut:true})),points),null);
});
test('motion consensus rejects clustered support, mostly wrong matches and excessive scale',()=>{
  const pairs=Array.from({length:30},(_,i)=>({p:{x:40+i%6*10,y:50+Math.floor(i/6)*10},q:{x:43+i%6*10,y:48+Math.floor(i/6)*10}}));
  assert.ok(robustMotion(pairs));
  assert.equal(robustMotion(pairs.map(r=>({p:r.p,q:{x:r.p.x*2,y:r.p.y*2}}))),null);
  assert.equal(robustMotion(pairs.map((r,i)=>i<10?r:{...r,q:{x:i*11,y:i*i*3}})),null);
  assert.equal(robustMotion(pairs.map((r,i)=>({p:{x:i,y:10},q:{x:i+2,y:12}}))),null);
});
function armed(){
  const assist=new RearWristAssist();
  for(let i=0;i<=3;i++){assist.advance(frame(),view,i*50);assist.correct(pose(),i*50);}
  return assist;
}
test('rear close-up bridge updates position/scale, preserving last out-of-plane rotation',()=>{
  const assist=armed(),original=pose().rotation;
  for(let i=1;i<=8;i++){
    const t=150+i*50;assist.advance(frame({dx:i*2,dy:-i,scale:1+i*.025}),view,t);
    assert.ok(assist.fallback(t,'no-hand'));
    const p=assist.sample(t);assert.ok(p);
    assert.ok(Math.abs(p.position.x-i*2)<1.5&&Math.abs(p.position.y-i)<1.5);
    assert.ok(Math.abs(p.size/80-(1+i*.025))<.04);
    assert.ok(p.rotation.angleTo(original)<.04);
  }
});
test('flow cannot renew the one-second deadline, survive stale frames or reset',()=>{
  const assist=armed();
  for(let t=200;t<=1150;t+=50){assist.advance(frame(),view,t);assert.ok(assist.fallback(t,'missing'));}
  assert.equal(assist.sample(1151),null);
  assist.advance(frame(),view,1200);assert.equal(assist.fallback(1200,'missing'),false);
  const stale=armed();stale.advance(frame(),view,200);stale.fallback(200,'missing');assert.equal(stale.sample(341),null);
  stale.reset();assert.equal(stale.sample(220),null);
});
test('blank cut ends fallback immediately and cannot self-reseed',()=>{
  const assist=armed();assist.advance(frame({dx:2}),view,200);assert.ok(assist.fallback(200,'missing'));
  assist.advance(frame({blank:true}),view,250);assert.equal(assist.fallback(250,'missing'),false);assert.equal(assist.sample(250),null);
  assist.advance(frame(),view,300);assert.equal(assist.fallback(300,'missing'),false);
});
test('reacquired hand blends back and view changes invalidate optical history',()=>{
  const assist=armed();assist.advance(frame({dx:4}),view,200);assist.fallback(200,'missing');const before=assist.sample(200).position.clone();
  const hand=pose();hand.position.x=15;assist.correct(hand,200);
  assert.ok(assist.sample(200).position.distanceTo(before)<1e-8);
  for(let t=250;t<=400;t+=50){assist.advance(frame({dx:4}),view,t);assist.correct(hand,t);}
  assert.equal(assist.sample(400),null); // ordinary hand tracker takes over
  assist.advance(frame(),{...view,width:300},450);assert.equal(assist.fallback(450,'missing'),false);
});
test('rear geometry guard rejects collapsed longitudinal geometry and cropped palm',()=>{
  const landmarks=Array.from({length:21},()=>({x:.5,y:.5,z:0}));
  for(const [i,x,y] of [[0,.5,.7],[5,.63,.4],[9,.55,.4],[13,.46,.4],[17,.37,.4]])landmarks[i]={x,y,z:0};
  for(const base of [5,9,13,17])for(let j=1;j<=3;j++)landmarks[base+j]={x:landmarks[base].x,y:.4-j*.055,z:0};
  landmarks[1]={x:.62,y:.6,z:0};landmarks[2]={x:.66,y:.5,z:0};
  const world=landmarks.map(p=>({x:(p.x-.5)*.2,y:(p.y-.5)*.2,z:0}));
  const tracker=new WristPoseTracker();
  const full=()=>estimateWristPose(landmarks,view,{worldLandmarks:world});
  for(let t=0;t<=1800;t+=50)tracker.update(full(),t);
  assert.ok(tracker.template);assert.equal(rearObservation(full(),landmarks,tracker).allowed,true);
  const compressed=landmarks.map(p=>({...p,y:.6+(p.y-.6)*.25}));
  assert.equal(rearObservation(estimateWristPose(compressed,view,{worldLandmarks:world}),compressed,tracker).reason,'foreshortened');
  const cropped=landmarks.map(p=>({...p,x:p.x+.6}));
  assert.equal(rearObservation(estimateWristPose(cropped,view,{worldLandmarks:world}),cropped,tracker).reason,'cropped-palm');
});

test('bridge shares portrait cover coordinates with the camera and ends on missing pixels',()=>{
  const assist=new RearWristAssist(),portrait={...view,width:180,height:320};
  for(let i=0;i<4;i++){assist.advance(frame(),portrait,i*50);assist.correct(pose(),i*50);}
  assist.advance(frame({dx:6,dy:3}),portrait,200);assert.ok(assist.fallback(200,'missing'));
  const p=assist.sample(200);assert.ok(Math.abs(p.position.x-8)<1&&Math.abs(p.position.y+4)<1);
  assist.advance(null,portrait,250);assert.equal(assist.sample(250),null);
});
test('unsupported cumulative image turn ends fallback instead of inventing a full 3D roll',()=>{
  const assist=armed();
  for(let i=1;i<=12;i++){assist.advance(frame({angle:i*.045}),view,150+i*33);assist.fallback(150+i*33,'missing');}
  assert.equal(assist.sample(546),null);
});
