import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3} from './vendor/three/three.module.js';
import {DEFAULTS,sanitizeSettings,manualPlacement,CenterObservation} from './wrist-watch-fit.mjs';
import {describeObservation,diagnosticRecord} from './wrist-watch-diagnostics.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const portrait={videoWidth:406,videoHeight:720,width:500,height:600};
const valid={x:250,y:400,score:.8,accepted:true};

test('wrist-only first frame immediately attaches without any hand calibration',()=>{
  const track=new CenterObservation();assert.equal(track.update(valid,100,406,720,140),true);
  const fit=manualPlacement(track.sample(140),portrait,DEFAULTS);
  assert.ok(fit);close(fit.caseSize,406*.24*600/720);
});
test('contain letterboxing and front reflection match video pixels',()=>{
  const a=manualPlacement(valid,portrait,DEFAULTS),b=manualPlacement(valid,portrait,DEFAULTS,true);
  close(a.target.x,47*600/720);close(a.target.y,-40*600/720);close(b.target.x,-a.target.x);close(b.target.y,a.target.y);
  const landscape={videoWidth:1280,videoHeight:720,width:360,height:640};
  const c=manualPlacement({x:960,y:180},landscape,DEFAULTS);
  close(c.target.x,90);close(c.target.y,50.625);
});
test('all manual rotations keep the case contact point on the learned centre',()=>{
  for(const heading of [-180,-90,0,90,180])for(const roll of [-160,0,75])for(const tilt of [-70,0,70]){
    const p=manualPlacement(valid,portrait,{...DEFAULTS,heading,roll,tilt,height:.23});
    const contact=new Vector3(0,0,p.dimensions.radiusZ+p.height*p.caseSize).applyQuaternion(p.rotation).add(p.position);
    close(contact.distanceTo(p.target),0);
  }
});
test('moving centre never invents a size or rotation measurement',()=>{
  const a=manualPlacement(valid,portrait,{...DEFAULTS,heading:38,roll:42});
  const b=manualPlacement({...valid,x:90,y:500},portrait,{...DEFAULTS,heading:38,roll:42});
  assert.deepEqual(a.rotation.toArray(),b.rotation.toArray());close(a.caseSize,b.caseSize);
  assert.notDeepEqual(a.position.toArray(),b.position.toArray());
});
test('resizing case does not resize the occlusion wrist',()=>{
  const a=manualPlacement(valid,portrait,DEFAULTS),b=manualPlacement(valid,portrait,{...DEFAULTS,scale:2});
  close(b.caseSize,2*a.caseSize);assert.deepEqual(a.dimensions,b.dimensions);
});
test('no fallback position is invented for invalid geometry',()=>{
  assert.equal(manualPlacement(null,portrait,DEFAULTS),null);
  assert.equal(manualPlacement(valid,{...portrait,videoWidth:0},DEFAULTS),null);
});
test('lost or stale wrist hides and reacquires on next valid wrist frame',()=>{
  const track=new CenterObservation();track.update(valid,10,406,720);
  assert.ok(track.sample(360));assert.equal(track.sample(361),null);
  assert.equal(track.update({...valid,score:.54},400,406,720),false);assert.equal(track.sample(400),null);
  assert.equal(track.update(valid,500,406,720),true);assert.ok(track.sample(500));
  assert.equal(track.update({...valid,x:500},600,406,720),false);assert.equal(track.sample(600),null);
});
test('late, future and out-of-order observations cannot display a stale wrist',()=>{
  const track=new CenterObservation();assert.equal(track.update(valid,100,406,720,451),false);
  track.update(valid,500,406,720,510);
  assert.equal(track.update({...valid,x:50},400,406,720,510),false);close(track.sample(510).x,250);
  assert.equal(track.update(valid,600,406,720,510),false);
  track.reset();assert.equal(track.sample(510),null);
  assert.equal(track.update(null,700,406,720),false);
});
test('saved settings are finite, bounded and isolated from unknown fields',()=>{
  const settings=sanitizeSettings({scale:99,heading:Infinity,tilt:-99,occlusion:false,width:NaN,unknown:1});
  assert.equal(settings.scale,2);assert.equal(settings.heading,0);assert.equal(settings.tilt,-80);
  assert.equal(settings.occlusion,false);assert.equal(settings.width,DEFAULTS.width);assert.equal(settings.unknown,undefined);
});
test('a fast low-score observation is reported as low-score rather than camera delay',()=>{
  assert.equal(describeObservation({...valid,score:.1,accepted:false},40).code,'low-score');
  assert.equal(describeObservation(valid,400).code,'stale');
  assert.equal(describeObservation({...valid,accepted:false},40).code,'outside');
  assert.equal(describeObservation(null,40).code,'invalid');
  assert.equal(describeObservation(valid,40).code,'accepted');
});
test('failed detection retains the raw model score, source size and timing for diagnosis',()=>{
  const record=diagnosticRecord({pose:{...valid,score:.1,accepted:false},time:100,width:720,height:1280,frameTime:10,inferenceMs:38},145,{sourceMode:'camera',mirror:false,capturePath:'video-imagebitmap',settings:DEFAULTS});
  assert.equal(record.reason,'low-score');assert.equal(record.candidate.score,.1);assert.equal(record.width,720);
  assert.equal(record.resultAgeMs,45);assert.equal(record.inferenceMs,38);assert.equal(record.threshold,.55);
  assert.equal(record.rgba,undefined);assert.equal(record.image,undefined);
});
