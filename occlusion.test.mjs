import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Raycaster } from './vendor/three/three.module.js';
import { WristRig, wristDimensions } from './wrist-rig.js';
import { FitSettings } from './fit-settings.js';

const dimensions = wristDimensions(100, 1.3, 1.4);
const hidden = (rig, point, origin) => {
  rig.updateMatrixWorld(true);
  const ray = new Raycaster(origin, point.clone().sub(origin).normalize());
  const hit = ray.intersectObject(rig.occluder)[0];
  return !!hit && hit.distance < origin.distanceTo(point) - .001;
};

test('side-facing bracelet outside the wrist stays visible while the opposite metal is hidden', () => {
  const rig = new WristRig();
  rig.fit({ ...dimensions, caseSize:65, occlusionMargin:1.1 });
  const origin = new Vector3(300, -10, -5);
  assert.equal(hidden(rig, new Vector3(dimensions.radiusX+2,-10,-5),origin), false);
  assert.equal(hidden(rig, new Vector3(-dimensions.radiusX-2,-10,-5),origin), true);
});

test('palm-facing clasp remains visible on both sides of the bracelet centre', () => {
  const rig = new WristRig();
  rig.fit({ ...dimensions, caseSize:65, occlusionMargin:1.25 });
  for(const y of [-12,0,12]) {
    const origin = new Vector3(0,y,-300);
    assert.equal(hidden(rig,new Vector3(0,y,-dimensions.radiusZ-2),origin),false);
    assert.equal(hidden(rig,new Vector3(0,y,dimensions.radiusZ+2),origin),true);
  }
});

test('legacy GLB expansion settings are ignored without resetting other saved fit controls', () => {
  for(const margin of [1.1,1.25]) {
    let data=JSON.stringify({version:1,profiles:{'hand:datejust':{scale:.82,offset:.6,rotation:80,height:.1,'wrist-width':1.45,'wrist-depth':1.2,occlusion:false,'occlusion-margin':margin},'hand:sample':{scale:1.6}}});
    const storage={getItem:()=>data,setItem:(key,value)=>{data=value;}};
    const settings=new FitSettings(storage),fit=settings.load('hand','datejust');
    assert.equal(fit['occlusion-margin'],undefined);
    assert.deepEqual([fit.scale,fit.offset,fit.rotation,fit.height,fit['wrist-width'],fit['wrist-depth'],fit.occlusion],[.82,.6,80,.1,1.45,1.2,false]);
    settings.save('hand','datejust',fit);
    assert.equal(JSON.parse(data).profiles['hand:datejust']['occlusion-margin'],undefined);
    assert.deepEqual(new FitSettings(storage).load('hand','datejust'),fit);
    assert.equal(settings.load('hand','sample').scale,1.6);
  }
});

test('restoring wrist coverage preserves case contact and independent wrist sizing', () => {
  const rig=new WristRig();
  rig.fit({...dimensions,caseSize:65,height:.1,guide:true});
  assert.equal(rig.caseMount.position.z,dimensions.radiusZ+6.5);
  assert.deepEqual(rig.occluder.position.toArray(),[0,0,0]);
  const scale=rig.occluder.scale.clone();
  rig.fit({...dimensions,caseSize:35,guide:true});
  assert.ok(rig.occluder.scale.equals(scale));
  assert.ok(rig.guide.scale.equals(scale));
});


test('rigid bracelet center stays on the wrist axis through full rolls, model adjustments and sizing',()=>{
  const rig=new WristRig(),pivot=[.001,-.033,-.535];rig.position.set(23,-17,4);
  for(const roll of [0,Math.PI/2,Math.PI,Math.PI*1.5,Math.PI*2]){
    rig.rotation.set(.2,roll,-.8);
    for(const tilt of [0,.6])for(const size of [35,65,90]){
      rig.caseMount.rotation.set(.1,tilt,Math.PI/2,'ZYX');
      rig.fit({...dimensions,caseSize:size,wristPivot:pivot});rig.updateMatrixWorld(true);
      const center=rig.caseMount.localToWorld(new Vector3().fromArray(pivot));
      assert.ok(center.distanceTo(rig.position)<1e-9);
      assert.deepEqual(rig.occluder.scale.toArray(),[dimensions.radiusX,dimensions.length,dimensions.radiusZ]);
    }
  }
});

test('manual lift offsets a centered bracelet, and switching models restores case-contact mounting',()=>{
  const rig=new WristRig(),pivot=[0,-.03,-.53];rig.caseMount.rotation.z=Math.PI/2;
  rig.fit({...dimensions,caseSize:65,wristPivot:pivot,height:.1});rig.updateMatrixWorld(true);
  assert.ok(rig.caseMount.localToWorld(new Vector3().fromArray(pivot)).distanceTo(new Vector3(0,0,6.5))<1e-9);
  for(const invalid of [null,[NaN,0,0],[0,0]]){
    rig.fit({...dimensions,caseSize:65,wristPivot:invalid});
    assert.deepEqual(rig.caseMount.position.toArray(),[0,0,dimensions.radiusZ]);
  }
  rig.fit({...dimensions,caseSize:65,wristPivot:pivot,sample:true});
  assert.deepEqual(rig.caseMount.position.toArray(),[0,0,dimensions.radiusZ]);
});
