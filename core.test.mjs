import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateWristPose, coverTransform, landmarkPoint, smoothingAlpha, WristPoseTracker, wristSurfacePosition, watchRotationDegrees } from './pose.js';
import { Quaternion, Vector3 } from './vendor/three/three.module.js';
import { palmTemplate, fitPalmProjection } from './palm-projection.js';
import { HandTarget } from './hand-target.js';
import { inspectGLB } from './watch.js';
import { WristRig, wristDimensions, fitStrapPositions } from './wrist-rig.js';

const view = { videoWidth: 1280, videoHeight: 720, width: 400, height: 600 };
const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
landmarks[0] = { x: 0.5, y: 0.7, z: 0 };
landmarks[5] = { x: 0.42, y: 0.45, z: 0 };
landmarks[9] = { x: 0.5, y: 0.4, z: 0 };
landmarks[13] = { x: 0.54, y: 0.43, z: 0 };
landmarks[17] = { x: 0.58, y: 0.47, z: 0 };

test('portrait cover cropping shares the video center with the overlay', () => {
  const fit = coverTransform(1280, 720, 400, 600);
  assert.equal(fit.cropY, 0);
  assert.ok(fit.cropX > 300);
  const center = landmarkPoint({ x: 0.5, y: 0.5, z: 0 }, view);
  assert.ok(Math.abs(center.x) < 1e-8 && Math.abs(center.y) < 1e-8);
});
test('front camera mirroring negates X without flipping Y', () => {
  const p = { x: 0.6, y: 0.4, z: -0.02 };
  const back = landmarkPoint(p, view), front = landmarkPoint(p, view, true);
  assert.equal(back.x, -front.x); assert.equal(back.y, front.y); assert.equal(back.z, front.z);
});
test('watch offset points away from fingers and scale is monotonic', () => {
  const near = estimateWristPose(landmarks, view, { offset: 0.1 });
  const far = estimateWristPose(landmarks, view, { offset: 0.9, scale: 1.5 });
  assert.ok(far.position.y < near.position.y);
  assert.ok(Math.abs(far.size / near.size - 1.5) < 1e-8);
  assert.ok(Math.abs(near.rotation.length() - 1) < 1e-8);
});
test('invalid and collapsed hand detections are rejected', () => {
  assert.equal(estimateWristPose([], view), null);
  assert.equal(estimateWristPose(Array.from({length:21},()=>({x:0.5,y:0.5,z:0})), view), null);
  const bad = structuredClone(landmarks); bad[5].x = NaN;
  assert.equal(estimateWristPose(bad, view), null);
});
test('smoothing depends on elapsed time and remains bounded after backgrounding', () => {
  const a = smoothingAlpha(1 / 60), b = smoothingAlpha(1 / 30);
  assert.ok(Math.abs((1 - a) ** 2 - (1 - b)) < 1e-10);
  assert.equal(smoothingAlpha(5), smoothingAlpha(0.1));
  assert.equal(smoothingAlpha(-1), 0);
});

test('edge-on and noisy normalized depth do not hide or invert a visible wrist', () => {
  const poses = [-2, -0.4, 0, 0.4, 2].map(z => {
    const points = structuredClone(landmarks); points[5].z = z; points[17].z = -z;
    return estimateWristPose(points, view);
  });
  for (const pose of poses) {
    assert.ok(pose);
    assert.ok(pose.rotation.angleTo(poses[0].rotation) < 1e-6);
    assert.ok(Math.abs(pose.size - poses[0].size) < 1e-8);
  }
});

const rotationView = {width:1000,height:1000,videoWidth:1000,videoHeight:1000};
function rotatedHand(angle, right = false) {
  const local = Array.from({length:21}, () => new Vector3());
  for (const [id,x,y] of [[0,0,-0.04],[1,0.025,-0.022],[2,0.04,0],[5,0.035,0.04],[9,0.012,0.04],[13,-0.012,0.04],[17,-0.035,0.04]]) local[id].set(right?-x:x,y,0);
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0,1,0),angle);
  const points = local.map(p=>p.applyQuaternion(turn));
  return {
    landmarks:points.map(p=>({x:0.5+p.x*3,y:0.5-p.y*3,z:-p.z*3})),
    world:points.map(p=>({x:p.x,y:-p.y,z:-p.z})),
    turn,
  };
}
function rotationPose(angle, {right=false,mirror=false,scale=1}={}) {
  const hand=rotatedHand(angle,right);
  return estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world,mirror,scale});
}
test('thumb and pinky bases retain signed rotation through both side views and a full turn', () => {
  let previous;
  for(let degrees=-180;degrees<=180;degrees+=5){
    const radians=degrees*Math.PI/180, pose=rotationPose(radians);
    const expected=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),radians);
    assert.ok(pose.thumbUsed);
    assert.ok(pose.rotationQuality>0.5);
    assert.ok(pose.rotation.angleTo(expected)<1e-6,`angle ${degrees}`);
    if(previous)assert.ok(pose.rotation.angleTo(previous)<0.1);
    previous=pose.rotation;
  }
});
test('finger tip movement cannot masquerade as forearm rotation', () => {
  const hand=rotatedHand(0.7), before=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  for(const id of [3,4,6,7,8,10,11,12,14,15,16,18,19,20]){
    hand.world[id]={x:0.12,y:-0.2,z:0.18};hand.landmarks[id]={x:0.9,y:0.9,z:0.8};
  }
  const after=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  assert.ok(before.rotation.angleTo(after.rotation)<1e-6);
});
test('a tucked or unreliable thumb falls back to knuckles without freezing rotation', () => {
  const hand=rotatedHand(1.4), before=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  hand.world[1]={...hand.world[17]};hand.world[2]={...hand.world[17]};
  hand.world[1].x-=0.08;hand.world[2].x-=0.08;
  const after=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  assert.ok(after.rotationQuality>=0.5);
  assert.ok(after.rotation.angleTo(before.rotation)<0.05);
});
test('left/right hands and front-camera mirroring keep the physical rotation direction', () => {
  for(const right of [false,true])for(const mirror of [false,true]){
    const tracker=new WristPoseTracker();tracker.update(rotationPose(0,{right,mirror}),0);
    for(let i=1;i<=90;i++)tracker.update(rotationPose(i*Math.PI/180,{right,mirror}),i*33);
    const normal=new Vector3(0,0,1).applyQuaternion(tracker.pose.rotation);
    assert.ok(mirror?normal.x< -0.95:normal.x>0.95);
    assert.ok(Math.abs(normal.z)<0.15);
  }
});
test('side-view rotation keeps moving and does not reset its sign after a detection gap', () => {
  const tracker=new WristPoseTracker();tracker.update(rotationPose(0),0);
  for(let i=1;i<=140;i++)tracker.update(rotationPose(i*Math.PI/180),i*33);
  assert.ok(new Vector3(0,0,1).applyQuaternion(tracker.pose.rotation).z< -0.65);
  tracker.update(null,4800);assert.equal(tracker.sample(4900),null);
  tracker.update(rotationPose(150*Math.PI/180),5000);
  assert.equal(tracker.sample(5000),null);
  tracker.update(rotationPose(150*Math.PI/180),5033);
  tracker.update(rotationPose(150*Math.PI/180),5066);
  assert.ok(new Vector3(0,0,1).applyQuaternion(tracker.pose.rotation).z< -0.8);
});
test('an isolated 180-degree landmark glitch does not turn the watch over', () => {
  const tracker=new WristPoseTracker();
  for(let t=-600;t<=0;t+=50)tracker.update(rotationPose(0),t);
  assert.ok(tracker.orientationSign);
  tracker.update(rotationPose(Math.PI),33);
  assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<1e-6);
  tracker.update(rotationPose(0),66);
  assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<1e-6);
});
test('calibration needs elapsed stable time, a frontal view, and restarts after a gap', () => {
  const tracker=new WristPoseTracker();
  for(let i=0;i<4;i++)tracker.update(rotationPose(Math.PI/2),i*33);
  assert.equal(tracker.orientationSign,0);
  for(let i=4;i<7;i++)tracker.update(rotationPose(0),i*33);
  assert.equal(tracker.orientationSign,0);
  tracker.update(rotationPose(0),900);
  assert.equal(tracker.orientationSign,0);
  for(let t=950;t<=1500;t+=50)tracker.update(rotationPose(0),t);
  assert.equal(tracker.orientationSign,1);
  tracker.reset();assert.equal(tracker.orientationSign,0);assert.equal(tracker.template,null);
});

function calibratedTracker(options={}) {
  const tracker=new WristPoseTracker();
  for(let t=-600;t<=0;t+=50)tracker.update(rotationPose(0,options),t);
  assert.ok(tracker.orientationSign);return tracker;
}
test('projected palm fitting recovers rotations about multiple axes',()=>{
  const hand=rotatedHand(0), base=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  const template=palmTemplate(base.imagePalm,base.rotation);
  for(const axis of [new Vector3(1,0,0),new Vector3(0,1,0),new Vector3(1,2,3).normalize()])for(const angle of [-2.5,-1.5,-0.5,0.5,1.5,2.5]){
    const q=new Quaternion().setFromAxisAngle(axis,angle);
    const projected=template.map(p=>p.clone().applyQuaternion(q).multiplyScalar(220).add(new Vector3(32,-40,0)).setZ(0));
    const fitted=fitPalmProjection(template,projected);
    assert.ok(fitted.residual<1e-10);
    assert.ok(Math.min(...fitted.rotations.map(r=>r.angleTo(q)))<1e-6);
  }
});
test('wrong world-depth orientation cannot override a clear image palm plane',()=>{
  const tracker=calibratedTracker();
  const observed=rotatedHand(0.7), wrong=rotatedHand(2.7);
  for(let t=33;t<=330;t+=33)tracker.update(estimateWristPose(observed.landmarks,rotationView,{worldLandmarks:wrong.world}),t);
  const normal=new Vector3(0,0,1).applyQuaternion(tracker.pose.rotation);
  assert.ok(Math.abs(normal.z-Math.cos(0.7))<0.02);
  assert.equal(tracker.diagnostics.state,'corrected');
});
test('image-guided rotation permits a full turn in either direction for both mirrored hands',()=>{
  for(const right of [false,true])for(const mirror of [false,true])for(const direction of [-1,1]){
    const tracker=calibratedTracker({right,mirror});
    for(let degrees=3;degrees<=360;degrees+=3){
      const angle=direction*degrees*Math.PI/180;
      tracker.update(rotationPose(angle,{right,mirror}),degrees*11);
      const expected=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),mirror?-angle:angle);
      assert.ok(tracker.pose.rotation.angleTo(expected)<0.16,`${right}/${mirror}/${direction}/${degrees}`);
    }
  }
});

test('6 oclock stays toward thumb and 12 toward pinky for both hands, cameras and full turns',()=>{
  for(const right of [false,true])for(const mirror of [false,true])for(const direction of [-1,1]){
    const tracker=calibratedTracker({right,mirror}), sign=tracker.orientationSign;
    for(let degrees=0;degrees<=360;degrees+=3){
      const raw=rotationPose(direction*degrees*Math.PI/180,{right,mirror});
      tracker.update(raw,33+degrees*22);
      const caseRotation=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),watchRotationDegrees(90,tracker.watchOrientationSign)*Math.PI/180);
      const six=new Vector3(0,-1,0).applyQuaternion(caseRotation).applyQuaternion(tracker.pose.rotation);
      const twelve=new Vector3(0,1,0).applyQuaternion(caseRotation).applyQuaternion(tracker.pose.rotation);
      const towardThumb=new Vector3(1,0,0).applyQuaternion(raw.rotation);
      assert.ok(six.dot(towardThumb)>0.98,`${right}/${mirror}/${direction}/${degrees}`);
      assert.ok(twelve.dot(towardThumb)<-0.98);
      assert.equal(tracker.orientationSign,sign);
    }
  }
  // Keep the user's model correction as an offset, including imported GLBs.
  assert.equal(watchRotationDegrees(105,-1)-watchRotationDegrees(90,-1),15);
  assert.equal(watchRotationDegrees(90,1),90);
});
test('inconsistent palm geometry expires rotation even while landmarks keep arriving',()=>{
  const tracker=calibratedTracker(), hand=rotatedHand(0);
  hand.landmarks[9].y+=0.45;
  const bad=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  for(let t=33;t<=330;t+=33)tracker.update(bad,t);
  assert.equal(tracker.diagnostics.state,'uncertain');assert.equal(tracker.sample(330),null);
  for(let t=363;t<=660;t+=33)tracker.update(rotationPose(0),t);
  assert.ok(tracker.sample(660));
});
test('calibrated image scale resists changing inferred bone lengths while respecting zoom and user size',()=>{
  const tracker=calibratedTracker(), original=tracker.pose.size, originalRadius=tracker.pose.wristRadius;
  const hand=rotatedHand(0);
  for(const p of hand.world)p.x*=0.35;
  for(let t=33;t<=990;t+=33)tracker.update(estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world}),t);
  assert.ok(Math.abs(tracker.pose.size-original)<0.01);
  for(let t=1023;t<=1980;t+=33)tracker.update(estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world,scale:1.5}),t);
  assert.ok(Math.abs(tracker.pose.size/original-1.5)<0.02);
  assert.ok(Math.abs(tracker.pose.wristRadius-originalRadius)<0.01);
  for(const p of hand.landmarks){p.x=0.5+(p.x-0.5)*1.25;p.y=0.5+(p.y-0.5)*1.25;}
  for(let t=2013;t<=2970;t+=33)tracker.update(estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world,scale:1.5}),t);
  assert.ok(Math.abs(tracker.pose.size/original-1.875)<0.03);
});
test('out-of-order results are discarded and capture age determines expiry',()=>{
  const tracker=calibratedTracker();tracker.update(rotationPose(0.5),33);
  const rotation=tracker.pose.rotation.clone();
  assert.equal(tracker.update(rotationPose(-0.5),20),false);
  assert.ok(tracker.pose.rotation.angleTo(rotation)<1e-6);
  assert.equal(tracker.sample(254),null);
});

test('short loss retains the depth branch despite reversed world depth on return',()=>{
  for(const right of [false,true])for(const mirror of [false,true])for(const sign of [-1,1]){
    const options={right,mirror}, tracker=calibratedTracker(options);
    for(let i=1;i<=20;i++)tracker.update(rotationPose(sign*i*0.04,options),i*33);
    tracker.update(null,800);assert.equal(tracker.sample(1000),null);
    const hand=rotatedHand(sign*0.95,right), wrong=rotatedHand(-sign*0.95,right);
    const returned=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:wrong.world,mirror});
    tracker.update(returned,1100);assert.equal(tracker.sample(1100),null);
    tracker.update(returned,1133);assert.equal(tracker.sample(1133),null);
    tracker.update(returned,1166);
    const expected=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),(mirror?-1:1)*sign*0.95);
    assert.ok(tracker.sample(1166));assert.ok(tracker.pose.rotation.angleTo(expected)<0.02);
  }
});
test('long loss needs a stable back-of-hand view instead of guessing an unseen turn',()=>{
  const tracker=calibratedTracker();
  for(let i=1;i<=30;i++)tracker.update(rotationPose(i*0.03),i*33);
  for(let t=3000;t<=3300;t+=50)tracker.update(rotationPose(2.5),t);
  assert.equal(tracker.sample(3300),null);assert.equal(tracker.diagnostics.state,'reorient');
  for(let t=3400;t<=3650;t+=50)tracker.update(rotationPose(0),t);
  assert.ok(tracker.sample(3650));assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<0.01);
});
test('motion memory permits real reversals at the palm-facing turning point',()=>{
  for(const direction of [-1,1]){
    const tracker=calibratedTracker();let time=0;
    const sequence=[...Array.from({length:60},(_,i)=>(i+1)*3),...Array.from({length:60},(_,i)=>177-i*3)];
    for(const degrees of sequence){
      time+=33;tracker.update(rotationPose(direction*degrees*Math.PI/180),time);
      assert.ok(tracker.pose.rotation.angleTo(rotationPose(direction*degrees*Math.PI/180).rotation)<0.6,`reversal at ${degrees}, time ${time}`);
    }
    assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<0.16);
    assert.ok(tracker.sample(time));
  }
});
test('long-loss recovery accepts the original tilted calibration view',()=>{
  const tracker=new WristPoseTracker();
  for(let t=-600;t<=0;t+=50)tracker.update(rotationPose(0.5),t);
  assert.ok(tracker.orientationSign);
  for(let t=2000;t<=2300;t+=50)tracker.update(rotationPose(0.5),t);
  assert.ok(tracker.sample(2300));
  assert.ok(tracker.pose.rotation.angleTo(rotationPose(0.5).rotation)<0.05);
});

test('initial world-axis inversion cannot reverse 6 and 12 relative to observed thumb',()=>{
  for(const right of [false,true])for(const mirror of [false,true]){
    const observed=rotatedHand(0,right),wrong=rotatedHand(0,!right),tracker=new WristPoseTracker();
    const pose=()=>estimateWristPose(observed.landmarks,rotationView,{mirror,worldLandmarks:wrong.world});
    for(let t=-600;t<=0;t+=50)tracker.update(pose(),t);
    assert.ok(tracker.orientationSign);
    assert.ok(tracker.template[1].x<tracker.template[4].x);
    const six=new Vector3(0,-1,0).applyAxisAngle(new Vector3(0,0,1),watchRotationDegrees(90,tracker.watchOrientationSign)*Math.PI/180).applyQuaternion(tracker.pose.rotation).setZ(0).normalize();
    const radial=pose().imagePalm[1].clone().sub(pose().imagePalm[4]).setZ(0).normalize();
    assert.ok(six.dot(radial)>0.99);
  }
});

test('a stable palm-facing surface restores pose after long loss on both hands and cameras',()=>{
  for(const right of [false,true])for(const mirror of [false,true]){
    const options={right,mirror},tracker=calibratedTracker(options),template=tracker.template,sign=tracker.orientationSign;
    const palm=()=>{const pose=rotationPose(Math.PI,options);pose.position.add(new Vector3(90,35,0));return pose;};
    tracker.update(null,1800);
    for(let t=2000;t<2300;t+=50){tracker.update(palm(),t);assert.equal(tracker.sample(t),null);}
    tracker.update(palm(),2300);assert.ok(tracker.sample(2300));assert.ok(tracker.diagnostics.surfaceConfirmed);
    assert.equal(tracker.diagnostics.surface,'palm');assert.equal(tracker.orientationSign,sign);assert.equal(tracker.template,template);
    assert.ok(new Vector3(0,0,1).applyQuaternion(tracker.pose.rotation).z<-.99);
    assert.ok(wristSurfacePosition(tracker.pose.position,tracker.pose.rotation,30).z< -29);
    assert.ok(tracker.pose.position.distanceTo(palm().position)<1e-6);
  }
});

test('side views, inconsistent depth and alternating surfaces cannot trigger palm recovery',()=>{
  const palmHand=rotatedHand(Math.PI),wrong=rotatedHand(0);
  for(const kind of ['side','depth','alternating']){
    const tracker=calibratedTracker();tracker.update(null,1800);
    for(let t=2000;t<=2800;t+=50){
      const pose=kind==='depth'?estimateWristPose(palmHand.landmarks,rotationView,{worldLandmarks:wrong.world}):rotationPose(kind==='side'?2.1:Math.floor(t/100)%2?Math.PI:0);
      tracker.update(pose,t);assert.equal(tracker.sample(t),null,`${kind}/${t}`);assert.ok(!tracker.diagnostics.surfaceConfirmed);
    }
  }
});

test('clear sustained surface evidence can repair a stuck depth branch without a visible snap',()=>{
  for(const mirror of [false,true]){
    const tracker=calibratedTracker({mirror});let time=0;
    for(let i=1;i<=15;i++){time+=50;tracker.update(rotationPose(i*.03,{mirror}),time);}
    let confirmed=false;
    for(let i=1;i<=16;i++){
      time+=50;const before=tracker.pose.rotation.clone();tracker.update(rotationPose(-.45,{mirror}),time);
      confirmed ||= tracker.diagnostics.surfaceRealigned;
      assert.ok(before.angleTo(tracker.pose.rotation)<.33,'bounded visible correction');
    }
    assert.ok(confirmed);assert.ok(tracker.pose.rotation.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),mirror?.45:-.45))<.12);
  }
});

test('a missing frame cancels accumulated surface confirmation',()=>{
  const tracker=calibratedTracker();tracker.update(null,1800);
  for(let t=2000;t<=2250;t+=50)tracker.update(rotationPose(Math.PI),t);
  tracker.update(null,2300);
  for(let t=2350;t<2650;t+=50){tracker.update(rotationPose(Math.PI),t);assert.equal(tracker.sample(t),null);}
  tracker.update(rotationPose(Math.PI),2650);assert.ok(tracker.sample(2650));
});

function detectedHands(...hands) {
  return {landmarks:hands.map(h=>h.points),handedness:hands.map(h=>[{categoryName:h.side||'Left',score:0.98}])};
}
function targetHand(x=0.5,y=0.5,scale=1,side='Left') {
  return {points:rotatedHand(0).landmarks.map(p=>({...p,x:x+(p.x-0.5)*scale,y:y+(p.y-0.5)*scale})),side};
}
function lockedTarget(hand=targetHand()) {
  const target=new HandTarget();for(let t=0;t<=150;t+=50)target.select(detectedHands(hand),rotationView,t);
  assert.equal(target.state,'locked');return target;
}
test('hand identity follows spatial continuity when detector ordering changes',()=>{
  const main=targetHand(), background=targetHand(0.15,0.8,0.3), target=lockedTarget(main);
  assert.equal(target.select(detectedHands(background,main),rotationView,183),1);
  assert.equal(target.select(detectedHands(main,background),rotationView,216),0);
});
test('loss cannot attach the watch to a smaller background hand, even after seconds',()=>{
  const target=lockedTarget(), background=targetHand(0.25,0.75,0.27);
  for(const time of [183,216,500,1500,4000])assert.equal(target.select(detectedHands(background),rotationView,time),null);
  assert.equal(target.state,'lost');
  assert.equal(target.select(detectedHands(targetHand(0.52,0.51)),rotationView,4100),0);
});
test('nearby opposite hand after loss needs explicit target reset',()=>{
  const target=lockedTarget(), opposite=targetHand(0.51,0.5,1,'Right');
  target.select(detectedHands(),rotationView,300);
  assert.equal(target.select(detectedHands(opposite),rotationView,500),null);
  target.reset();for(let t=600;t<=750;t+=50)target.select(detectedHands(opposite),rotationView,t);
  assert.equal(target.state,'locked');assert.equal(target.target.side,'Right');
});
test('target association allows gradual motion, size change, side views and noisy handedness',()=>{
  const target=lockedTarget();
  for(let i=1;i<=20;i++){
    const hand=targetHand(0.5+i*0.003,0.5,1+i*0.01,i===10?'Right':'Left');
    assert.equal(target.select(detectedHands(hand),rotationView,150+i*33),0);
  }
  for(let i=1;i<=30;i++){
    const points=rotatedHand(i*Math.PI/60).landmarks.map(p=>({...p,x:0.56+(p.x-0.5)*1.2,y:0.5+(p.y-0.5)*1.2}));
    assert.equal(target.select(detectedHands({points}),rotationView,810+i*33),0);
  }
});
test('ambiguous overlapping hands and invalid or stale observations do not update the target',()=>{
  const target=lockedTarget(), previous=target.target;
  assert.equal(target.select(detectedHands(targetHand(0.49),targetHand(0.51)),rotationView,183),null);
  assert.equal(target.target,previous);
  assert.equal(target.select(detectedHands(targetHand()),rotationView,180),null);
  const bad=targetHand();bad.points[5].x=NaN;
  assert.equal(target.select(detectedHands(bad),rotationView,216),null);
});

test('front camera reacquires a stable same-side hand at a new bounded location',()=>{
  const target=lockedTarget(), moved=targetHand(0.77), options={allowRelocation:true};
  target.select(detectedHands(),rotationView,400,options);
  for(const t of [500,600,700,800]){
    assert.equal(target.select(detectedHands(moved),rotationView,t,options),null);
    assert.equal(target.state,'recovering');
  }
  assert.equal(target.select(detectedHands(moved),rotationView,900,options),0);
  assert.equal(target.state,'reacquired');
  assert.equal(target.select(detectedHands(moved),rotationView,1000,options),0);
  assert.equal(target.state,'locked');
});

test('front relocation rejects other-side, unknown-side, tiny, far and ambiguous hands',()=>{
  const unknown=targetHand(0.77), unknownResult=detectedHands(unknown);unknownResult.handedness[0][0].score=0.7;
  for(const result of [detectedHands(targetHand(0.77,0.5,1,'Right')),unknownResult,detectedHands(targetHand(0.77,0.5,0.4)),detectedHands(targetHand(1.2)),detectedHands(targetHand(0.76),targetHand(0.78))]){
    const target=lockedTarget();
    for(let t=500;t<3000;t+=100)assert.equal(target.select(result,rotationView,t,{allowRelocation:true}),null);
  }
});

test('front relocation needs consecutive stable observations and cannot change rear-camera gates',()=>{
  const rear=lockedTarget(), front=lockedTarget(), moved=targetHand(0.77);
  for(let t=500;t<=2000;t+=100){
    assert.equal(rear.select(detectedHands(moved),rotationView,t),null);
    const result=t%300===0?detectedHands():detectedHands(moved);
    assert.equal(front.select(result,rotationView,t,{allowRelocation:true}),null);
  }
  front.reset();assert.equal(front.relocation,null);
});
test('case revolves around a fixed wrist centre with radius independent of watch size', () => {
  const center=new Vector3(23,45,0), radius=30;
  for(const angle of [0,Math.PI/2,Math.PI,-Math.PI/2]){
    const pose=rotationPose(angle), surface=wristSurfacePosition(center,pose.rotation,radius);
    assert.ok(Math.abs(surface.distanceTo(center)-radius)<1e-8);
    const occluderCenter=new Vector3(0,0,-radius).applyQuaternion(pose.rotation).add(surface);
    assert.ok(occluderCenter.distanceTo(center)<1e-8);
  }
  assert.equal(rotationPose(0,{scale:0.6}).wristRadius,rotationPose(0,{scale:1.6}).wristRadius);
});

test('brief gaps are held, a missing hand expires, and reacquisition resets', () => {
  const tracker = new WristPoseTracker(), pose = estimateWristPose(landmarks, view);
  tracker.update(pose, 1000); tracker.update(null, 1100);
  assert.ok(tracker.sample(1200)); assert.equal(tracker.sample(1221), null);
  const moved = { ...pose, position: pose.position.clone().addScalar(200) };
  tracker.update(moved, 1400);
  assert.equal(tracker.sample(1400).position.distanceTo(moved.position), 0);
  tracker.reset(); assert.equal(tracker.sample(1401), null);
});

test('an isolated position jump is rejected, real sustained movement is reacquired', () => {
  const tracker = new WristPoseTracker(), pose = estimateWristPose(landmarks, view);
  tracker.update(pose, 0);
  const bad = { ...pose, position: pose.position.clone().add(new Vector3(pose.size*0.8, 0, 0)) };
  assert.equal(tracker.update(bad, 33), false);
  assert.equal(tracker.sample(33).position.distanceTo(pose.position), 0);
  assert.equal(tracker.update(pose, 66), true);
  assert.equal(tracker.update(bad, 99), false);
  assert.equal(tracker.update(bad, 132), false);
  assert.equal(tracker.update(bad, 165), true);
  assert.ok(tracker.sample(165).position.x > pose.position.x);
  assert.ok(tracker.sample(165).position.x < pose.position.x+pose.size*0.4);
  for(let t=198;t<=594;t+=33)tracker.update(bad,t);
  assert.ok(tracker.pose.position.distanceTo(bad.position)<pose.size*0.05);
});

test('adaptive position filter reduces stationary jitter without lagging sustained motion', () => {
  const tracker = new WristPoseTracker(), pose = estimateWristPose(landmarks, view);
  let energy = 0;
  for (let i = 0; i < 90; i++) {
    const p = { ...pose, position: pose.position.clone().add(new Vector3(i % 2 ? 3 : -3, 0, 0)) };
    tracker.update(p, i * 33);
    if (i >= 30) energy += (tracker.sample(i * 33).position.x - pose.position.x) ** 2;
  }
  assert.ok(Math.sqrt(energy / 60) < 1.5);
  for (let i = 0; i < 30; i++) {
    tracker.update({ ...pose, position: pose.position.clone().add(new Vector3(i * 12, 0, 0)) }, (90 + i) * 33);
  }
  assert.ok(Math.abs(tracker.pose.position.x - pose.position.x - 348) < 15);
});

test('one-frame moderate position and rotation spikes cannot kick the watch',()=>{
  const tracker=calibratedTracker(), base=tracker.pose.position.clone(), size=tracker.pose.size;
  const bad=rotationPose(0.65);bad.position.add(new Vector3(size*0.5,0,0));
  assert.equal(tracker.update(bad,66),false);
  assert.ok(tracker.pose.position.distanceTo(base)<1e-8);
  assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<0.01);
  tracker.update(rotationPose(0),132);
  assert.ok(tracker.sample(132));assert.ok(tracker.pose.position.distanceTo(base)<1e-8);
});
test('bad geometry holds the entire pose instead of mixing in its raw scale and anchor',()=>{
  const tracker=calibratedTracker(), before={position:tracker.pose.position.clone(),size:tracker.pose.size,radius:tracker.pose.wristRadius};
  const hand=rotatedHand(0);hand.landmarks[9].y+=0.45;
  const bad=estimateWristPose(hand.landmarks,rotationView,{worldLandmarks:hand.world});
  for(const t of [66,132,198])assert.equal(tracker.update(bad,t),false);
  assert.equal(tracker.pose.size,before.size);assert.equal(tracker.pose.wristRadius,before.radius);
  assert.ok(tracker.pose.position.distanceTo(before.position)<1e-8);assert.equal(tracker.sample(221),null);
});
test('a depth-angle spike cannot boost its own visible rotation step',()=>{
  const tracker=calibratedTracker();tracker.update(rotationPose(0.95),66);
  assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<0.21);
  for(let t=132;t<=330;t+=66)tracker.update(rotationPose(0),t);
  assert.ok(tracker.sample(330));assert.ok(tracker.pose.rotation.angleTo(rotationPose(0).rotation)<0.03);
});
test('continuous rotation at phone inference cadence stays visible and follows both directions',()=>{
  for(const sign of [-1,1]){
    const tracker=calibratedTracker();
    for(let t=66;t<=2640;t+=66){
      const angle=sign*t/1000*1.5;tracker.update(rotationPose(angle),t);
      assert.ok(tracker.sample(t),`visible at ${t}`);
      assert.ok(tracker.pose.rotation.angleTo(rotationPose(angle).rotation)<0.2);
    }
  }
});
test('one wrist cylinder defines case contact and fitted strap across watch sizes',()=>{
  const dimensions=wristDimensions(100), rig=new WristRig();
  rig.caseMount.rotation.z=Math.PI/2;
  for(const caseSize of [36,65,105]){
    rig.fit({...dimensions,caseSize,sample:true});
    assert.equal(rig.caseMount.position.z,dimensions.radiusZ);
    assert.equal(rig.occluder.position.length(),0);
    assert.equal(rig.occluder.scale.x,dimensions.radiusX);
    assert.equal(rig.occluder.scale.z,dimensions.radiusZ);
    const points=rig.strap.geometry.attributes.position.array, factor=rig.strap.scale.x, clearance=0.012*caseSize;
    for(let i=12;i<=68;i++)for(let j=0;j<2;j++){
      const k=i*12+j*3,x=points[k]*factor,z=points[k+2]*factor;
      assert.ok(Math.abs((x/(dimensions.radiusX+clearance))**2+(z/(dimensions.radiusZ+clearance))**2-1)<1e-5);
    }
    const start=new Vector3().fromArray(points,0).add(new Vector3().fromArray(points,3)).multiplyScalar(factor/2);
    const lug=new Vector3(0,-0.56,0.015).applyQuaternion(rig.caseMount.quaternion).multiplyScalar(caseSize).add(new Vector3(0,0,dimensions.radiusZ));
    assert.ok(start.distanceTo(lug)<1e-5);
  }
  rig.fit({...dimensions,caseSize:65,sample:false,guide:true});
  assert.equal(rig.strap.visible,false);assert.equal(rig.guide.visible,true);
});
test('strap leaves the case downward and meets the wrist tangentially without a floating shelf',()=>{
  const points=new Float32Array(81*12), dimensions=wristDimensions(100,1.3,1.4),caseSize=87.75;
  const caseRotation=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),Math.PI/2);
  fitStrapPositions(points,{...dimensions,caseSize,caseRotation});
  const center=i=>new Vector3().fromArray(points,i*12).add(new Vector3().fromArray(points,i*12+3)).multiplyScalar(.5);
  const rx=dimensions.radiusX+.012*caseSize,rz=dimensions.radiusZ+.012*caseSize;
  for(const [lugIndex,joinIndex,direction] of [[0,8,1],[80,72,-1]]){
    const lug=center(lugIndex),join=center(joinIndex),descent=join.clone().sub(lug);
    assert.ok(descent.z < -dimensions.radiusZ*.5,'connector turns down beside the case');
    assert.ok(Math.abs((join.x/rx)**2+(join.z/rz)**2-1)<1e-6,'contact is on the wrist');
    const normal=new Vector3(join.x/(rx*rx),0,join.z/(rz*rz)).normalize();
    assert.ok(Math.abs(descent.clone().normalize().dot(normal))<1e-5,'no sharp kink at contact');
    for(let step=1;step<8;step++){
      const p=center(lugIndex+direction*step);
      assert.ok(p.distanceTo(lug.clone().lerp(join,step/8))<1e-5,'no raised shelf between lug and contact');
      assert.ok((p.x/rx)**2+(p.z/rz)**2>=1-1e-6,'strap does not cut through the wrist');
    }
  }
});
test('wrist width/depth adjustments preserve a finite strap attached to tilted case lugs',()=>{
  const points=new Float32Array(81*12);
  for(const width of [0.65,1,1.45])for(const depth of [0.6,1,1.5]){
    const dimensions=wristDimensions(100,width,depth);
    const q=new Quaternion().setFromAxisAngle(new Vector3(1,2,3).normalize(),1.2);
    fitStrapPositions(points,{...dimensions,caseSize:65,caseRotation:q,lift:4});
    assert.ok([...points].every(Number.isFinite));
    const a=new Vector3().fromArray(points,0).add(new Vector3().fromArray(points,3)).multiplyScalar(0.5);
    const b=new Vector3().fromArray(points,960).add(new Vector3().fromArray(points,963)).multiplyScalar(0.5);
    const ends=[-1,1].map(sign=>new Vector3(0,sign*0.56,0.015).applyQuaternion(q).multiplyScalar(65).add(new Vector3(0,0,dimensions.radiusZ+4)));
    assert.ok(Math.min(a.distanceTo(ends[0]),a.distanceTo(ends[1]))<1e-5);
    assert.ok(Math.min(b.distanceTo(ends[0]),b.distanceTo(ends[1]))<1e-5);
  }
});
function glb(json) {
  let text = JSON.stringify(json); text += ' '.repeat((4 - new TextEncoder().encode(text).length % 4) % 4);
  const encoded = new TextEncoder().encode(text), buffer = new ArrayBuffer(20 + encoded.length), data = new DataView(buffer);
  [0x46546c67, 2, buffer.byteLength, encoded.length, 0x4e4f534a].forEach((value, i) => data.setUint32(i * 4, value, true));
  new Uint8Array(buffer, 20).set(encoded); return buffer;
}
test('GLB validation accepts embedded assets and rejects missing external textures', () => {
  assert.equal(inspectGLB(glb({asset:{version:'2.0'}})).asset.version, '2.0');
  assert.throws(() => inspectGLB(glb({ images: [{ uri: 'https://example.com/texture.jpg' }] })), /포함/);
  assert.throws(() => inspectGLB(glb({ extensionsRequired: ['KHR_texture_basisu'] })), /KTX2/);
  assert.throws(() => inspectGLB(new ArrayBuffer(24)), /GLB/);
});

