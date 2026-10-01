import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3,Quaternion} from './vendor/three/three.module.js';
import {WristPoseTracker,estimateWristPose} from './pose.js';
import {WristRig,wristDimensions} from './wrist-rig.js';
import {frameLabel,wristCrop,CaptureGate,CollectionGate,CaptureTrace,reviewLabel,reviewCrop,guideFromDisplayPoint,TEACHER_FIT} from './teacher-capture.mjs';
import {crc32,makeZip,sessionArchive} from './teacher-store.mjs';
function example(){
  const points=Array.from({length:21},()=>({x:.5,y:.2,z:0}));
  const pose={rotation:new Quaternion(),position:new Vector3(0,-100,0),size:100,wristRadius:60};
  return {pose,raw:{position:pose.position.clone()},selectedRotation:pose.rotation.clone(),watchSign:1,diagnostic:{quality:.9,residual:.01,disagreement:.1},calibrated:true,accepted:true,time:1234,latency:40,width:720,height:720,landmarks:points};
}
test('case-contact origin and axes agree with GLB mount, not cylinder center',()=>{
  const data=example();data.pose.rotation.setFromAxisAngle(new Vector3(0,1,0),.6);data.selectedRotation.copy(data.pose.rotation);
  const label=frameLabel(data).label,rig=new WristRig();rig.position.copy(data.pose.position);rig.quaternion.copy(data.pose.rotation);rig.caseMount.rotation.z=Math.PI/2;
  rig.fit({...wristDimensions(60/(.65*.46),TEACHER_FIT['wrist-width'],TEACHER_FIT['wrist-depth']),caseSize:100});rig.updateMatrixWorld(true);
  const contact=rig.caseMount.getWorldPosition(new Vector3());
  assert.ok(Math.hypot(label.center2d[0]-(contact.x+360),label.center2d[1]-(360-contact.y))<1e-8);
  const q=rig.caseMount.getWorldQuaternion(new Quaternion());
  assert.ok(new Vector3(...label.axes.twelve).distanceTo(new Vector3(0,1,0).applyQuaternion(q))<1e-8);
  assert.notDeepEqual(label.center2d,label.wristAnchor2d);assert.equal(label.approvedForTraining,false);
});
test('held, stale, cropped-hand, ambiguous and lagged poses are excluded',()=>{
  const d=example();assert.ok(frameLabel(d).label);
  assert.equal(frameLabel({...d,accepted:false}).reason,'tracking');
  assert.equal(frameLabel({...d,calibrated:false}).reason,'calibration');
  assert.equal(frameLabel({...d,latency:250}).reason,'latency');
  assert.equal(frameLabel({...d,diagnostic:{...d.diagnostic,turnPending:true}}).reason,'uncertain');
  const moved=example();moved.raw.position.x+=50;assert.equal(frameLabel(moved).reason,'motion');
  const turned=example();turned.selectedRotation.setFromAxisAngle(new Vector3(0,1,0),.3);assert.equal(frameLabel(turned).reason,'motion');
  const cropped=example();cropped.landmarks[2].x=-.1;assert.equal(frameLabel(cropped).reason,'hand');
});
test('rear display correction must have live support and is preserved in labels',()=>{
  const d=example(),basePose={...d.pose,rotation:d.pose.rotation.clone()};
  d.pose.rotation.setFromAxisAngle(new Vector3(1,0,0),.2);
  assert.equal(frameLabel({...d,basePose,rearAxis:{trusted:false,correction:.2}}).reason,'uncertain');
  const label=frameLabel({...d,basePose,rearAxis:{trusted:true,correction:.2}}).label;
  assert.ok(label);assert.ok(Math.abs(label.axes.front[1]+Math.sin(.2))<1e-8);
  assert.deepEqual(label.baseRotation,[0,0,0,1]);
});
test('crop stays in source image and excludes all predicted finger points',()=>{
  const d=example(),label=frameLabel(d).label,crop=wristCrop(label,d.landmarks);assert.ok(crop);
  assert.ok(crop.x>=0&&crop.y>=0&&crop.x+crop.width<=720&&crop.y+crop.height<=720);
  assert.deepEqual(crop.centerNormalized,[.5,.5]);
  d.landmarks[4]={x:label.center2d[0]/720,y:label.center2d[1]/720};assert.equal(wristCrop(label,d.landmarks),null);
});
test('gate requires sustained observations, resets after a loss, caps cadence',()=>{
  const g=new CaptureGate(),r=frameLabel(example());
  assert.equal(g.consider(r,0).reason,'settling');assert.equal(g.consider(r,100).reason,'settling');assert.ok(g.consider(r,200).label);
  assert.equal(g.consider(r,300).reason,'cadence');assert.equal(g.consider({reason:'tracking'},400).reason,'tracking');
  assert.equal(g.consider(r,500).reason,'settling');assert.equal(g.consider(r,600).reason,'settling');assert.ok(g.consider(r,700).label);
});
test('legacy tracker produces eligible labels only after real calibration dwell',()=>{
  const local=Array.from({length:21},()=>new Vector3());
  for(const [i,x,y] of [[0,0,-.04],[1,.025,-.022],[2,.04,0],[5,.035,.04],[9,.012,.04],[13,-.012,.04],[17,-.035,.04],[3,.052,.022],[4,.06,.038]])local[i].set(x,y,0);
  for(const base of [5,9,13,17])for(let j=1;j<=3;j++)local[base+j].set(local[base].x,.04+j*.02,0);
  const landmarks=local.map(p=>({x:.5+p.x*3,y:.5-p.y*3,z:-p.z*3})),world=local.map(p=>({x:p.x,y:-p.y,z:-p.z}));
  const view={width:720,height:720,videoWidth:720,videoHeight:720},t=new WristPoseTracker();let eligible=0;
  for(let time=0;time<3000;time+=80){
    const raw=estimateWristPose(landmarks,view,{worldLandmarks:world,offset:.5}),accepted=t.update(raw,time);
    const r=frameLabel({pose:t.pose,raw,selectedRotation:t.previousRotation,watchSign:t.watchOrientationSign,diagnostic:t.diagnostics,calibrated:!!t.orientationSign,accepted,time,latency:40,width:720,height:720,landmarks});
    if(time<1500)assert.equal(r.label,undefined);if(r.label)eligible++;
  }
  assert.ok(eligible>=10,`eligible ${eligible}`);
});
test('ZIP has correct CRC, UTF-8 filenames and image-label file mapping',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const zip=await makeZip([['손목.txt','123456789']]),bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer);
  assert.equal(view.getUint32(0,true),0x04034b50);assert.equal(view.getUint32(14,true),0xcbf43926);assert.equal(view.getUint16(6,true),0x800);
  assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);
  const archive=await sessionArchive({id:'test',count:1},[{index:0,label:{center2d:[10,20]},image:new Blob(['frame']),cropImage:new Blob(['crop'])}]);
  const text=await archive.text();assert.ok(text.includes('frames/00000.jpg'));assert.ok(text.includes('crops/00000.jpg'));assert.ok(text.includes('manifest.json'));
  await assert.rejects(makeZip([['../bad','bad']]));
});

test('side scenes never become axis labels, even when teacher accepts; loss remains recordable',()=>{
  const g=new CollectionGate(),r=frameLabel(example());
  assert.equal(g.consider({reason:'calibration'},{calibrated:false,scene:'normal',time:0}),null);
  assert.deepEqual(g.consider({reason:'calibration'},{calibrated:false,scene:'side',time:0}),{kind:'review',reason:'side-review'});
  assert.equal(g.consider(r,{calibrated:false,scene:'side',time:100}),null);
  assert.deepEqual(g.consider(r,{calibrated:true,scene:'side',time:400}),{kind:'review',reason:'side-review'});
  assert.equal(g.consider(r,{calibrated:true,scene:'normal',time:500}),null);
  assert.deepEqual(g.consider({reason:'tracking'},{calibrated:false,scene:'normal',time:800}),{kind:'review',reason:'tracking'});
  assert.deepEqual(g.consider(r,{calibrated:true,scene:'normal',time:1200}),{kind:'label'});
  g.reset();assert.equal(g.consider({reason:'tracking'},{calibrated:false,scene:'normal',time:1500}),null);
});

test('review crop needs no hand or axis and remains inside portrait/landscape images',()=>{
  for(const [w,h] of [[405,720],[720,405],[48,48]])for(const x of [-1,0,.5,1,2])for(const y of [0,.5,1]){
    const crop=reviewCrop(w,h,{x,y,fraction:.8});
    assert.ok(crop.x>=0&&crop.y>=0&&crop.x+crop.width<=w&&crop.y+crop.height<=h);
    assert.equal(crop.width,crop.height);assert.equal(crop.centerNormalized,null);assert.equal(crop.reviewRequired,true);
  }
  assert.equal(reviewCrop(0,720),null);
  assert.equal(reviewCrop(405,720,{fraction:Infinity}).width,324);
});

test('guide taps account for letterboxing and selfie reflection without changing saved pixels',()=>{
  const input={stageWidth:600,stageHeight:720,imageWidth:405,imageHeight:720,x:197.5,y:360};
  const rear=guideFromDisplayPoint(input),front=guideFromDisplayPoint({...input,mirrored:true});
  assert.equal(rear.x,100/405);assert.equal(front.x,305/405);assert.equal(rear.y,.5);
  assert.equal(guideFromDisplayPoint({...input,x:10}),null);
  assert.equal(guideFromDisplayPoint({...input,stageWidth:0}),null);
});

test('side archive exports actual review crops and empty partial-point annotation templates',async()=>{
  const crop=reviewCrop(405,720,{x:.3,y:.5});
  const zip=await sessionArchive({id:'side-session',version:'teacher-03'},[{index:7,image:new Blob(['source']),cropImage:new Blob(['crop']),
    label:{kind:'review',scene:'side',imageSize:[405,720],crop,frameTimeMs:123,axes:null,center2d:null}}]);
  const bytes=new Uint8Array(await zip.arrayBuffer()),v=new DataView(bytes.buffer),files={};
  for(let offset=0;v.getUint32(offset,true)===0x04034b50;){
    const size=v.getUint32(offset+18,true),n=v.getUint16(offset+26,true),extra=v.getUint16(offset+28,true),start=offset+30+n+extra;
    const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+n));files[name]=new TextDecoder().decode(bytes.slice(start,start+size));offset=start+size;
  }
  const m=JSON.parse(files['manifest.json']),a=JSON.parse(files['annotation-template.json']);
  assert.equal(m.frames.length,0);assert.equal(m.reviewFrames[0].cropImage,'review-crops/00007.jpg');
  assert.equal(files[m.reviewFrames[0].cropImage],'crop');assert.equal(a.splitGroup,'side-session');
  assert.deepEqual(a.items[0].crop,crop);assert.equal(a.items[0].recordIndex,7);
  for(const t of Object.values(a.items[0].targets)){assert.equal(t.imagePoint,null);assert.equal(t.supervisionMask,0);assert.equal(t.state,'unreviewed');}
  assert.equal(a.items[0].threeDRotation,null);assert.equal(a.items[0].approvedForTraining,false);
});
test('review evidence cannot populate targets and is cloned at image timestamp',()=>{
  const evidence={teacherLandmarks:[{x:.1}],selectedRotation:[0,0,0,1]};
  const label=reviewLabel({reason:'tracking',scene:'side',time:123,width:720,height:720,evidence});
  evidence.teacherLandmarks[0].x=.9;
  assert.equal(label.evidence.teacherLandmarks[0].x,.1);assert.equal(label.evidence.trusted,false);
  assert.equal(label.axes,null);assert.equal(label.center2d,null);assert.equal(label.approvedForTraining,false);
});
test('trace includes final unsaved failures with bounded history and complete counters',()=>{
  const trace=new CaptureTrace(2);
  for(const reason of ['saved','tracking','uncertain','tracking'])trace.add({reason});
  const summary=trace.summary();assert.equal(summary.observations,4);assert.equal(summary.trace.length,2);
  assert.deepEqual(summary.rejected,{tracking:2,uncertain:1});assert.equal(summary.traceTruncated,true);
  summary.trace[0].reason='mutated';assert.equal(trace.summary().trace[0].reason,'uncertain');
});
test('mixed archive separates rejected images from training candidates and preserves legacy exports',async()=>{
  const records=[{index:0,image:new Blob(['a']),label:{kind:'label',axes:{front:[0,0,1]}}},
    {index:1,image:new Blob(['b']),label:{kind:'review',axes:{bad:true},center2d:[1,2],approvedForTraining:true}},
    {index:2,image:new Blob(['c']),label:{kind:'label'}}];
  const zip=await sessionArchive({version:'teacher-02',count:3},records);
  const bytes=new Uint8Array(await zip.arrayBuffer()),v=new DataView(bytes.buffer);let manifest;
  for(let offset=0;v.getUint32(offset,true)===0x04034b50;){
    const size=v.getUint32(offset+18,true),n=v.getUint16(offset+26,true),extra=v.getUint16(offset+28,true),start=offset+30+n+extra;
    const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+n));
    if(name==='manifest.json')manifest=JSON.parse(new TextDecoder().decode(bytes.slice(start,start+size)));
    offset=start+size;
  }
  assert.equal(manifest.frames.length,2);assert.equal(manifest.frames[1].index,1);assert.equal(manifest.frames[1].recordIndex,2);
  assert.equal(manifest.reviewFrames[0].axes,null);assert.equal(manifest.reviewFrames[0].approvedForTraining,false);
  assert.equal(manifest.reviewFrames[0].image,'review/00001.jpg');assert.deepEqual(manifest.recordCounts,{total:3,labeled:2,review:1});
  const legacy=await sessionArchive({version:'teacher-01',count:1},[records[0]]);
  assert.ok((await legacy.text()).includes('"schema": "teacher-01"'));
});
