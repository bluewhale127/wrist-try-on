import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from './vendor/three/three.module.js';
import {FitSettings,defaultFit,sanitizeFit} from './fit-settings.js';
import {directWristPose,DirectWristTracker} from './direct-wrist-pose.js';
import {wristReprojectionError} from './wrist-detector.js';

test('wrist projection error uses current landmarks and camera geometry instead of a stale SDK score',()=>{
  const points=[[-2,-1,-1],[2,-1,-1],[-2,1,-1],[2,1,-1],[-2,-1,1],[2,-1,1],[-2,1,1],[2,1,1]];
  for(const angle of [0,.6,-1.2])for(const focal of [400,772]){
    const q=new Quaternion().setFromAxisAngle(new Vector3(1,2,3).normalize(),angle),translation=[3,-4,50];
    const columns=[[1,0,0],[0,1,0],[0,0,1]].map(p=>new Vector3(...p).applyQuaternion(q).toArray());
    const rotation=[0,1,2].map(i=>Float32Array.from([0,1,2].map(j=>columns[j][i]*(i===2?-1:1)*(j===2?-1:1))));
    const pixels=points.map(p=>{const v=new Vector3(...p).applyQuaternion(q).add(new Vector3(...translation));return [v.x*focal/v.z,v.y*focal/v.z];});
    const solved={ok:true,rotation,translation:Float32Array.from(translation),repError:10000};
    assert.ok(wristReprojectionError(points,pixels,solved,focal)<1e-5);
    const moved=pixels.map(p=>[p[0]+40,p[1]]);
    assert.ok(Math.abs(wristReprojectionError(points,moved,{...solved,repError:0},focal)-40)<1e-5);
    assert.equal(wristReprojectionError(points,pixels,{...solved,translation:[0,0,-50]},focal),Infinity);
  }
});

test('fit profiles persist independently by tracker and model; corrupt/blocked storage stays usable',()=>{
  let data;const storage={getItem:()=>data,setItem:(k,v)=>{data=v;}};
  const settings=new FitSettings(storage);
  settings.save('hand','sample',{scale:1.62,'wrist-width':1.8,occlusion:false});
  settings.save('wrist','sample',{scale:1.11});
  assert.equal(settings.load('hand','sample').scale,1.62);
  assert.equal(settings.load('hand','sample').occlusion,false);
  assert.equal(settings.load('wrist','sample').scale,1.11);
  assert.equal(settings.load('hand','new.glb').scale,defaultFit('hand').scale);
  data='{bad';assert.deepEqual(settings.load('hand'),defaultFit('hand'));
  assert.equal(new FitSettings({setItem(){throw Error();}}).save('hand','sample',{}),false);
  assert.equal(sanitizeFit({scale:NaN,'wrist-width':200,offset:'0.2'},'hand')['wrist-width'],2);
});
const result={solved:{ok:true,rotation:[[-1,0,0],[0,0,1],[0,1,0]],translation:[10,-20,100],repError:0.5},focal:500,modelWidth:6,width:640,height:480,landmarks:Array.from({length:8},()=>[0,0]),isRightHand:true};
test('direct wrist projection respects cover crop, mirror, fitting and corrupt PnP results',()=>{
  const view={width:400,height:600};
  const a=directWristPose(result,view),b=directWristPose(result,view,{mirror:true,scale:1.4,offset:0.7});
  assert.ok(a && b);assert.ok(Math.abs(a.rotation.length()-1)<1e-6);
  assert.ok(directWristPose({...result,solved:{...result.solved,rotation:result.solved.rotation.map(row=>Float32Array.from(row)),translation:Float32Array.from(result.solved.translation)}},view));
  assert.ok(Math.abs(b.size/a.size-1.4/1.2)<1e-6);
  const mirrored=directWristPose(result,view,{mirror:true});assert.equal(a.position.x,-mirrored.position.x);assert.equal(a.position.y,mirrored.position.y);
  for(const patch of [{ok:false},{translation:[0,0,-1]},{repError:10000},{rotation:[[NaN,0,0],[0,1,0],[0,0,1]]}])assert.equal(directWristPose({...result,solved:{...result.solved,...patch}},view),null);
});
const pose=(x=0,angle=0)=>({position:new Vector3(x,0,0),rotation:new Quaternion().setFromAxisAngle(new Vector3(0,1,0),angle),size:100,wristRadius:46,isRightHand:true,quality:0.9});
const warm=t=>{for(let time=0;time<=300;time+=60)t.update(pose(),time);};
test('direct tracker confirms acquisition, rejects an isolated flip, and expires absent wrists',()=>{
  const t=new DirectWristTracker();t.update(pose(),0);assert.equal(t.sample(0),null);warm(t);assert.ok(t.sample(300));
  t.update(pose(1,Math.PI),360);assert.ok(t.pose.rotation.angleTo(pose().rotation)<0.01);
  t.update(pose(2,0.1),420);assert.ok(t.sample(420));t.update(null,480);assert.equal(t.sample(641),null);
});
test('uncertain rotation does not freeze measured translation and prolonged uncertainty expires',()=>{
  const t=new DirectWristTracker();warm(t);
  for(let time=360;time<=780;time+=60)t.update(pose(2, time%120===0?2.3:-2.3),time);
  assert.ok(t.pose.position.x>1);assert.equal(t.sample(780),null);
});
test('a consistent real orientation change recovers without an unlimited orientation freeze',()=>{
  const t=new DirectWristTracker();warm(t);
  for(let time=360;time<=1560;time+=60)t.update(pose(0,1.6),time);
  assert.ok(t.sample(1560));assert.ok(t.pose.rotation.angleTo(pose(0,1.6).rotation)<0.1);
});
test('loss cannot transfer directly to a small background wrist or opposite hand',()=>{
  const t=new DirectWristTracker();warm(t);
  for(let time=900;time<=1500;time+=60)t.update({...pose(),wristRadius:10},time);
  assert.equal(t.sample(1500),null);
  for(let time=1560;time<=1860;time+=60)t.update({...pose(),isRightHand:false},time);
  assert.equal(t.sample(1860),null);
  for(let time=1920;time<=2220;time+=60)t.update(pose(),time);
  assert.ok(t.sample(2220));
});
