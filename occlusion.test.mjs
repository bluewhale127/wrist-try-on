import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Raycaster } from './vendor/three/three.module.js';
import { WristRig, wristDimensions } from './wrist-rig.js';
import { FitSettings } from './fit-settings.js';

const dimensions = wristDimensions(100, 1.3, 1.4);
const behindMask = (rig, point) => {
  rig.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(point.x, point.y, 300), new Vector3(0, 0, -1));
  const hit = ray.intersectObject(rig.occluder)[0];
  return !!hit && hit.point.z > point.z;
};

test('GLB coverage hides a rear sliver outside the old mask without covering the dorsal case plane', () => {
  const rig = new WristRig();
  const fit = { ...dimensions, caseSize: 65, sample: false };
  const rearMetal = new Vector3(dimensions.radiusX * 1.04, 0, -dimensions.radiusZ);
  rig.fit({ ...fit, occlusionMargin: 1 });
  assert.equal(behindMask(rig, rearMetal), false);
  rig.fit({ ...fit, occlusionMargin: 1.1 });
  assert.equal(behindMask(rig, rearMetal), true);
  for (const margin of [1.01, 1.1, 1.25]) {
    rig.fit({ ...fit, occlusionMargin: margin });
    for (const x of [-20, 0, 20]) for (const y of [-20, 0, 20]) {
      assert.equal(behindMask(rig, new Vector3(x, y, dimensions.radiusZ + 0.1)), false);
    }
    assert.equal(rig.caseMount.position.z, dimensions.radiusZ);
    assert.equal(rig.caseMount.scale.x, 65);
  }
});

test('forearm coverage widens toward the elbow and its guide uses the same shape and transform', () => {
  const rig = new WristRig();
  rig.fit({ ...dimensions, caseSize: 65, occlusionMargin: 1.1, guide: true });
  const x = dimensions.radiusX * 1.1 * 1.06;
  assert.equal(behindMask(rig, new Vector3(x, -dimensions.length * 0.4, -dimensions.radiusZ)), true);
  assert.equal(behindMask(rig, new Vector3(x, dimensions.length * 0.4, -dimensions.radiusZ)), false);
  assert.deepEqual(rig.guide.position.toArray(), rig.occluder.position.toArray());
  assert.deepEqual(rig.guide.scale.toArray(), rig.occluder.scale.toArray());
  assert.equal(rig.guide.geometry, rig.forearmGuideGeometry);
  const oldScale = rig.occluder.scale.clone(), oldPosition = rig.occluder.position.clone();
  rig.fit({ ...dimensions, caseSize: 35, occlusionMargin: 1.1 });
  assert.ok(rig.occluder.scale.equals(oldScale));
  assert.ok(rig.occluder.position.equals(oldPosition));
});

test('sample strap and 100% GLB coverage retain the old cylinder; invalid margins are bounded', () => {
  const rig = new WristRig();
  for (const options of [{ sample: true, occlusionMargin: 1.25 }, { sample: false, occlusionMargin: 1 }, { occlusionMargin: NaN }]) {
    rig.fit({ ...dimensions, caseSize: 65, ...options });
    assert.equal(rig.occluder.geometry, rig.cylinderGeometry);
    assert.deepEqual(rig.occluder.position.toArray(), [0, 0, 0]);
    assert.equal(rig.occluder.scale.x, dimensions.radiusX);
    assert.equal(rig.occluder.scale.z, dimensions.radiusZ);
  }
  rig.fit({ ...dimensions, caseSize: 65, occlusionMargin: 99 });
  assert.equal(rig.occluder.scale.x, dimensions.radiusX * 1.25);
});

test('saved sizes receive GLB coverage defaults without reset, and coverage persists independently', () => {
  let data = JSON.stringify({ version: 1, profiles: { 'hand:datejust': { scale: 0.82 }, 'hand:sample': { scale: 1.7 } } });
  const storage = { getItem: () => data, setItem: (key, value) => { data = value; } };
  const settings = new FitSettings(storage);
  assert.equal(settings.load('hand', 'datejust').scale, 0.82);
  assert.equal(settings.load('hand', 'datejust')['occlusion-margin'], 1.1);
  assert.equal(settings.load('hand', 'sample')['occlusion-margin'], 1);
  settings.save('hand', 'datejust', { ...settings.load('hand', 'datejust'), 'occlusion-margin': 1.18 });
  assert.equal(new FitSettings(storage).load('hand', 'datejust')['occlusion-margin'], 1.18);
  assert.equal(settings.load('hand', 'datejust').scale, 0.82);
  assert.equal(settings.load('hand', 'sample').scale, 1.7);
});
