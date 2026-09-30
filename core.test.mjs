import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateWristPose, coverTransform, landmarkPoint, smoothingAlpha, WristPoseTracker } from './pose.js';
import { Vector3 } from './vendor/three/three.module.js';
import { inspectGLB } from './watch.js';

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

test('world depth is bounded and a reversed ambiguous palm cannot flip the dial', () => {
  let previous;
  for (let angle = -1.5; angle <= 1.5; angle += 0.05) {
    const world = landmarks.map(p => ({ x: (p.x - 0.5) * Math.cos(angle), y: p.y * 0.1, z: (p.x - 0.5) * Math.sin(angle) }));
    const pose = estimateWristPose(landmarks, view, { worldLandmarks: world });
    const normal = new Vector3(0, 0, 1).applyQuaternion(pose.rotation);
    assert.ok(normal.z > 0.3);
    if (previous) assert.ok(pose.rotation.angleTo(previous.rotation) < 0.2);
    previous = pose;
  }
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
  const bad = { ...pose, position: pose.position.clone().add(new Vector3(800, 0, 0)) };
  assert.equal(tracker.update(bad, 33), false);
  assert.equal(tracker.sample(33).position.distanceTo(pose.position), 0);
  assert.equal(tracker.update(pose, 66), true);
  assert.equal(tracker.update(bad, 99), false);
  assert.equal(tracker.update(bad, 132), true);
  assert.ok(tracker.sample(132).position.x > pose.position.x + 400);
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

