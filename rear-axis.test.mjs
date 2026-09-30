import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from './vendor/three/three.module.js';
import {estimateWristPose,WristPoseTracker,watchRotationDegrees} from './pose.js';
import {RearPalmAxis} from './rear-axis.js';

const X=new Vector3(1,0,0),Y=new Vector3(0,1,0),Z=new Vector3(0,0,1);
const view={width:360,height:640,videoWidth:720,videoHeight:1280};
const q=(heading,pitch=0,roll=0)=>new Quaternion().setFromAxisAngle(Z,heading)
  .multiply(new Quaternion().setFromAxisAngle(X,pitch)).multiply(new Quaternion().setFromAxisAngle(Y,roll));
const pitchOf=rotation=>Math.asin(Math.max(-1,Math.min(1,Y.clone().applyQuaternion(rotation).z)));
const headingOf=rotation=>{const y=Y.clone().applyQuaternion(rotation);return Math.atan2(-y.x,y.y);};
const wrap=angle=>Math.atan2(Math.sin(angle),Math.cos(angle));
function observed(heading=0,pitch=0,roll=0,{mirror=false,right=false}={}){
  const local=Array.from({length:21},()=>new Vector3());
  for(const[i,x,y]of [[0,0,-.04],[1,.025,-.022],[2,.04,0],[3,.052,.022],[4,.06,.038],[5,.035,.04],[9,.012,.04],[13,-.012,.04],[17,-.035,.04]])local[i].set(right?-x:x,y,0);
  for(const b of [5,9,13,17])for(let j=1;j<=3;j++)local[b+j].set(local[b].x,.04+j*.02,0);
  const points=local.map(p=>p.applyQuaternion(q(heading,pitch,roll)));
  return estimateWristPose(points.map(p=>({x:.5+p.x*4,y:.5-p.y*4*720/1280,z:-p.z*4})),view,
    {mirror,worldLandmarks:points.map(p=>({x:p.x,y:-p.y,z:-p.z}))});
}
function calibrated(options={},heading=-Math.PI/2){const tracker=new WristPoseTracker();for(let t=-2000;t<=0;t+=100)tracker.update(observed(heading,0,0,options),t);assert.ok(tracker.orientationSign);return tracker;}

test('visible rear palm corrects a biased longitudinal template at every screen heading',()=>{
  for(const right of [false,true])for(const heading of [-Math.PI/2,0,Math.PI/2,Math.PI]){
    const options={right},tracker=calibrated(options,heading),axis=new RearPalmAxis();
    // Known shape error: the reference palm is 25% too long. This makes the
    // planar solver invent depth even though the observed hand is frontal.
    for(const p of tracker.template)p.y*=1.25;
    let displayed;
    for(let t=100;t<=2500;t+=100){const next=observed(heading,0,.2,options);if(tracker.update(next,t))displayed=axis.update(tracker.pose,next,tracker.template,t);}
    assert.ok(Math.abs(pitchOf(tracker.pose.rotation))>.5,'fixture reproduces false forearm tilt');
    assert.ok(Math.abs(pitchOf(displayed.rotation))<.04,`display follows the known frontal longitudinal axis: ${JSON.stringify({right,heading,pitch:pitchOf(displayed.rotation),diagnostic:axis.diagnostics})}`);
    assert.ok(Math.abs(wrap(headingOf(displayed.rotation)-headingOf(tracker.pose.rotation)))<1e-8);
    assert.deepEqual(displayed.position.toArray(),tracker.pose.position.toArray());
    assert.equal(displayed.size,tracker.pose.size);assert.equal(displayed.wristRadius,tracker.pose.wristRadius);
    const six=new Vector3(0,-1,0).applyAxisAngle(Z,watchRotationDegrees(90,tracker.watchOrientationSign)*Math.PI/180).applyQuaternion(displayed.rotation);
    const radial=nextRadial(heading,options);
    assert.ok(six.dot(radial)>.9,'6 oclock remains on the same radial side');
  }
});
function nextRadial(heading,options){return X.clone().applyQuaternion(observed(heading,0,.2,options).rotation);}

test('horizontal to vertical motion and real pitch retain screen direction at phone cadences',()=>{
  for(const dt of [33,77,100]){
    const tracker=calibrated(),axis=new RearPalmAxis();
    for(let i=1;i<=Math.ceil(3000/dt);i++){
      const t=i*dt,heading=-Math.PI/2+Math.PI/2*Math.min(1,t/2000),tilt=.2*Math.sin(t/1000),next=observed(heading,tilt,.2);
      assert.ok(tracker.update(next,t));const displayed=axis.update(tracker.pose,next,tracker.template,t);
      assert.ok(Math.abs(wrap(headingOf(displayed.rotation)-heading))<.09);
      assert.ok(Math.abs(pitchOf(displayed.rotation)-tilt)<.09);
      assert.ok(axis.sample(t));
    }
  }
});

test('rear display correction cannot feed back into branch selection or raw pose',()=>{
  const tracker=calibrated(),axis=new RearPalmAxis();
  for(const p of tracker.template)p.y*=1.25;
  for(let t=100;t<=1800;t+=100){const next=observed(0),ok=tracker.update(next,t);if(!ok)continue;
    const pose=JSON.stringify(tracker.pose),rotation=tracker.previousRotation.toArray(),velocity=tracker.rotationVelocity.toArray();
    axis.update(tracker.pose,next,tracker.template,t);
    assert.equal(JSON.stringify(tracker.pose),pose);assert.deepEqual(tracker.previousRotation.toArray(),rotation);assert.deepEqual(tracker.rotationVelocity.toArray(),velocity);
  }
});

test('unreliable thumb does not veto an independently consistent longitudinal knuckle axis',()=>{
  const tracker=calibrated(),axis=new RearPalmAxis();
  for(const p of tracker.template)p.y*=1.25;
  for(let t=100;t<=1800;t+=100){const next=observed(0);next.rotationQuality=.7;if(tracker.update(next,t))axis.update(tracker.pose,next,tracker.template,t);}
  assert.ok(axis.diagnostics.trusted);assert.ok(Math.abs(pitchOf(axis.pose.rotation))<.04);
});

test('disagreeing depth and side-on or malformed palms cannot start axis correction',()=>{
  for(const kind of ['depth','side','shape','missing-depth']){
    const tracker=calibrated(),axis=new RearPalmAxis();
    for(let t=100;t<=1800;t+=100){const next=observed(0,0,kind==='side'?1.3:0);
      if(kind==='depth')next.depthRotation=q(0,.6);
      if(kind==='shape')next.imagePalm[2].x+=150;
      if(kind==='missing-depth')next.depthRotation=null;
      axis.update({...next,rotation:q(0,.5)},next,tracker.template,t);
      assert.equal(axis.diagnostics.trusted,false);assert.equal(axis.diagnostics.correction,0);
    }
  }
});

test('an isolated depth glitch has bounded effect and cannot enter the robust depth history',()=>{
  const tracker=calibrated(),axis=new RearPalmAxis();
  for(const p of tracker.template)p.y*=1.25;
  for(let t=100;t<=1800;t+=100){const next=observed(0);tracker.update(next,t);axis.update(tracker.pose,next,tracker.template,t);}
  const previous=axis.pose.rotation.clone(),next=observed(0);next.depthRotation=q(0,.8);
  axis.update(tracker.pose,next,tracker.template,1900);
  assert.equal(axis.diagnostics.eligible,false);assert.ok(previous.angleTo(axis.pose.rotation)<=.120001);
  assert.ok(axis.history.every(h=>Math.abs(h.pitch)<1e-6));
});

test('missing frames expire on the original deadline and interrupt evidence; reset clears display',()=>{
  const tracker=calibrated(),axis=new RearPalmAxis();
  for(let t=100;t<=500;t+=100){const next=observed(0);tracker.update(next,t);axis.update(tracker.pose,next,tracker.template,t);}
  axis.interrupt();assert.equal(axis.history.length,0);assert.ok(axis.sample(720));assert.equal(axis.sample(721),null);
  const next=observed(0);axis.update(tracker.pose,next,tracker.template,800);assert.equal(axis.diagnostics.trusted,false);
  axis.reset();assert.equal(axis.sample(800),null);assert.equal(axis.correction,0);
});

test('front camera uses the identical pose with no rear correction history',()=>{
  const tracker=calibrated({mirror:true}),axis=new RearPalmAxis();
  for(let t=100;t<=1800;t+=100){const next=observed(0,.1,.3,{mirror:true});tracker.update(next,t);
    assert.equal(axis.update(tracker.pose,next,tracker.template,t),tracker.pose);assert.equal(axis.sample(t),null);
  }
});

test('a fading correction cannot cross a depth pole and reverse the visible heading',()=>{
  const tracker=calibrated(),axis=new RearPalmAxis(),next=observed(.6);
  for(let t=100;t<=1500;t+=100)axis.update({...next,rotation:q(.6,.6)},next,tracker.template,t);
  assert.ok(axis.correction<-.5);
  const result=axis.update({...next,rotation:q(.6,-1.2)},next,tracker.template,1600);
  assert.ok(Math.abs(wrap(headingOf(result.rotation)-.6))<1e-7);
});
