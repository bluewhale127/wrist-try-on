import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Group,Mesh,BoxGeometry,MeshBasicMaterial,Box3,Vector3} from './vendor/three/three.module.js';
import {normalizeImportedWatch} from './watch.js';

function watch() {
  const scene=new Group(),caseMesh=new Mesh(new BoxGeometry(.041,.041,.01),new MeshBasicMaterial());
  caseMesh.position.set(0,0,.005);scene.add(caseMesh);
  const crown=new Mesh(new BoxGeometry(.006,.005,.005),new MeshBasicMaterial());crown.position.set(.023,0,.005);scene.add(crown);
  return {scene,caseMesh};
}
test('explicit case contact keeps the dial centred despite a protruding crown',()=>{
  const {scene,caseMesh}=watch();scene.userData.wristAR={version:1,caseWidth:.041,contact:[0,0,0]};
  const root=normalizeImportedWatch(scene);root.updateMatrixWorld(true);
  const bounds=new Box3().setFromObject(caseMesh);
  assert.equal(root.userData.caseAnchored,true);
  assert.ok(Math.abs(bounds.getSize(new Vector3()).x-1)<1e-6);
  assert.ok(Math.abs(bounds.getCenter(new Vector3()).x)<1e-6);
  assert.ok(Math.abs(bounds.min.z)<1e-6);
});
test('an unprepared GLB keeps legacy whole-width normalization and authored contact height',()=>{
  const {scene}=watch();scene.position.set(1,2,3);
  const before=new Box3().setFromObject(scene),width=before.getSize(new Vector3()).x;
  const root=normalizeImportedWatch(scene),after=new Box3().setFromObject(root);
  assert.equal(root.userData.caseAnchored,false);
  assert.ok(Math.abs(after.getSize(new Vector3()).x-1)<1e-6);
  assert.ok(Math.abs(after.getCenter(new Vector3()).x)<1e-6);
  assert.ok(Math.abs(after.getCenter(new Vector3()).y)<1e-6);
  assert.ok(Math.abs(after.min.z-before.min.z/width)<1e-6);
});
test('invalid anchor metadata falls back without invalid transforms',()=>{
  for(const meta of [{version:2,caseWidth:.041,contact:[0,0,0]},{version:1,caseWidth:NaN,contact:[0,0,0]},{version:1,caseWidth:1e-20,contact:[0,0,0]},{version:1,caseWidth:.041,contact:[999,0,0]}]){
    const {scene}=watch();scene.userData.wristAR=meta;
    const root=normalizeImportedWatch(scene);assert.equal(root.userData.caseAnchored,false);assert.ok(Number.isFinite(root.scale.x));
  }
});
test('empty imported scenes are rejected',()=>assert.throws(()=>normalizeImportedWatch(new Group()),/크기/));


test('known rigid bracelet supplies a separate normalized pivot without changing its geometry',()=>{
  const {scene,caseMesh}=watch();scene.userData.wristAR={version:1,caseWidth:.041,contact:[0,0,0]};
  const loop=new Group();loop.name='closed-loop';
  const band=new Mesh(new BoxGeometry(.02,.08,.06),new MeshBasicMaterial());band.position.set(.002,-.003,-.03);loop.add(band);scene.add(loop);
  const vertices=band.geometry.attributes.position.array.slice();
  const root=normalizeImportedWatch(scene,{wristLoopName:'closed-loop'});
  const expected=new Vector3(.002,-.003,-.03).divideScalar(.041);
  assert.ok(new Vector3().fromArray(root.userData.wristPivot).distanceTo(expected)<1e-6);
  assert.deepEqual(band.geometry.attributes.position.array,vertices);
  assert.ok(Math.abs(new Box3().setFromObject(caseMesh).min.z)<1e-6);
});

test('unknown or unspecified bracelet keeps the case-contact mount',()=>{
  for(const options of [{},{wristLoopName:'missing'}]){
    const {scene}=watch();scene.userData.wristAR={version:1,caseWidth:.041,contact:[0,0,0]};
    assert.equal(normalizeImportedWatch(scene,options).userData.wristPivot,undefined);
  }
});
