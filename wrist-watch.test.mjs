import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3} from './vendor/three/three.module.js';
import {DEFAULTS,sanitizeSettings,frontFacingSettings,manualPlacement,CenterObservation,TRACKING} from './wrist-watch-fit.mjs';
import {describeObservation,trackingMessage,diagnosticRecord} from './wrist-watch-diagnostics.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const portrait={videoWidth:406,videoHeight:720,width:500,height:600};
const valid={x:250,y:400,score:.8,accepted:true};

const acquire=(track,start=100)=>{track.update(valid,start,406,720,start+45);track.update(valid,start+60,406,720,start+105);};

test('two agreeing wrist-only frames attach without any hand calibration',()=>{
  const track=new CenterObservation();assert.equal(track.update(valid,100,406,720,140),false);
  assert.equal(track.sample(140),null);assert.equal(track.state(140).phase,'acquiring');
  assert.equal(track.update(valid,160,406,720,200),true);
  const fit=manualPlacement(track.sample(200),portrait,DEFAULTS);
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
test('brief score failure holds a fixed position, expires from last good capture and reacquires',()=>{
  const track=new CenterObservation();acquire(track);
  const initial={...track.sample(205)};
  for(const t of [220,280,340])assert.equal(track.update({...valid,score:.23,accepted:false},t,406,720,t+35),false);
  assert.deepEqual(track.sample(380),initial);assert.equal(track.state(375).phase,'holding');
  assert.equal(track.sample(381),null);
  assert.equal(track.update(valid,450,406,720,490),false);
  assert.equal(track.update(valid,510,406,720,550),true);assert.ok(track.sample(550));
  assert.equal(track.update({...valid,x:500},570,406,720,610),false);assert.equal(track.sample(610),null);
});
test('late, future and out-of-order observations cannot display a stale wrist',()=>{
  const track=new CenterObservation();assert.equal(track.update(valid,100,406,720,451),false);
  acquire(track,500);
  assert.equal(track.update({...valid,x:50},400,406,720,610),false);close(track.sample(610).x,250);
  assert.equal(track.update(valid,650,406,720,610),false);
  track.reset();assert.equal(track.sample(610),null);
  assert.equal(track.update(null,700,406,720),false);
});

test('low scores and isolated distant high scores never initialize a watch',()=>{
  const track=new CenterObservation();
  for(let t=100;t<=700;t+=60){track.update({...valid,score:.54,accepted:false},t,406,720,t+40);assert.equal(track.sample(t+40),null);}
  track.update(valid,800,406,720,840);
  track.update({...valid,x:40,y:50},860,406,720,900);
  assert.equal(track.sample(900),null);
});

test('nearby borderline detections bridge flicker but need renewed strong evidence',()=>{
  const track=new CenterObservation();acquire(track);
  for(let t=220;t<=760;t+=60){
    assert.equal(track.update({...valid,x:254,score:.49,accepted:false},t,406,720,t+45),true);
    assert.ok(track.sample(t+45));assert.equal(track.state(t+45).phase,'assisted');
  }
  assert.equal(track.update({...valid,score:.49,accepted:false},820,406,720,865),false);
  assert.ok(track.sample(980));assert.equal(track.sample(981),null);
  track.update({...valid,score:.49,accepted:false},1000,406,720,1045);assert.equal(track.sample(1045),null);
});

test('a weak candidate at another object cannot drag or sustain the watch',()=>{
  const track=new CenterObservation();acquire(track);
  assert.equal(track.update({...valid,x:20,score:.5,accepted:false},220,406,720,265),false);
  close(track.sample(265).x,250);
  track.update({...valid,x:20,score:.5,accepted:false},340,406,720,385);
  assert.equal(track.sample(385),null);
});

test('a high-score jump is held out and a confirmed new place reattaches after expiry',()=>{
  const track=new CenterObservation();acquire(track);
  const moved={...valid,x:35,y:90};
  track.update(moved,220,406,720,260);close(track.sample(260).x,250);
  track.update(moved,280,406,720,320);close(track.sample(320).x,250);
  assert.equal(track.sample(381),null);
  track.update(moved,400,406,720,440);close(track.sample(440).x,35);
});

test('a single spurious jump does not break nearby strong tracking',()=>{
  const track=new CenterObservation();acquire(track);
  track.update({...valid,x:30},220,406,720,265);
  assert.equal(track.update({...valid,x:255},280,406,720,325),true);
  assert.ok(track.sample(325).x>250&&track.sample(325).x<=255);
});

test('no-response timeout does not claim an expired watch is tracking',()=>{
  const track=new CenterObservation();acquire(track);
  assert.equal(track.sample(381),null);
  const message=trackingMessage(track.state(381),describeObservation(valid,40));
  assert.ok(!message.includes('추적 중'));
});

test('source dimensions and explicit resets discard old lock and acquisition candidates',()=>{
  const track=new CenterObservation();acquire(track);
  assert.equal(track.update(valid,220,720,1280,260),false);assert.equal(track.sample(260),null);
  track.reset();assert.equal(track.update(valid,280,720,1280,320),false);
  assert.equal(track.update(valid,340,720,1280,380),true);
});

test('same-keyframe duplicates, long gaps and dropped frames cannot complete acquisition',()=>{
  const track=new CenterObservation();track.update(valid,100,406,720,145);
  assert.equal(track.update(valid,100,406,720,155),false);assert.equal(track.sample(155),null);
  assert.equal(track.update(valid,350,406,720,395),false);assert.equal(track.sample(395),null);
  assert.equal(track.update(valid,410,406,720,700),false);assert.equal(track.sample(700),null);
});

test('smooth motion remains tracked at 10 and 16 FPS with realistic inference delay',()=>{
  for(const step of [60,100]){
    const track=new CenterObservation();
    for(let i=0;i<18;i++){
      const p={...valid,x:100+i*5},t=100+i*step;
      track.update(p,t,406,720,t+55);
      if(i){const shown=track.sample(t+55);assert.ok(shown);assert.ok(Math.abs(shown.x-p.x)<6);}
    }
  }
});

test('front-view action clears saved side angles without changing manual size or fit',()=>{
  const saved={...DEFAULTS,heading:37,roll:92,tilt:54,dial:15,scale:1.27,width:1.8};
  const face=frontFacingSettings(saved),horizontal=frontFacingSettings(saved,-90);
  assert.equal(face.roll,0);assert.equal(face.tilt,0);assert.equal(face.dial,90);assert.equal(face.heading,37);
  assert.equal(face.scale,1.27);assert.equal(face.width,1.8);assert.equal(saved.roll,92);assert.equal(horizontal.heading,-90);
  const fit=manualPlacement(valid,portrait,face),normal=new Vector3(0,0,1).applyQuaternion(fit.rotation);
  close(normal.x,0);close(normal.y,0);close(normal.z,1);
});

test('diagnostic records distinguish raw below-threshold scores from maintained tracking',()=>{
  const track=new CenterObservation();acquire(track);
  const p={...valid,score:.48,accepted:false};track.update(p,220,406,720,265);
  const record=diagnosticRecord({pose:p,time:220,width:406,height:720,inferenceMs:45},265,{tracking:track.state(265)});
  assert.equal(record.version,4);assert.equal(record.reason,'low-score');assert.equal(record.tracking.phase,'assisted');
  assert.equal(record.continuationThreshold,TRACKING.continueScore);
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
