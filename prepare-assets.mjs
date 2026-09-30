import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const vendor = path.join(root, 'vendor');
const deps = path.join(root, 'node_modules');
const modelURL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const modelHash = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const copy = async (source, destination) => {
  const target = path.join(vendor, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(deps, source), target, { recursive: true });
};
await Promise.all([
  copy('three/build/three.module.js', 'three/three.module.js'),
  copy('three/build/three.core.js', 'three/three.core.js'),
  copy('three/examples/jsm/loaders/GLTFLoader.js', 'three/addons/loaders/GLTFLoader.js'),
  copy('three/examples/jsm/loaders/DRACOLoader.js', 'three/addons/loaders/DRACOLoader.js'),
  copy('three/examples/jsm/utils/BufferGeometryUtils.js', 'three/addons/utils/BufferGeometryUtils.js'),
  copy('three/examples/jsm/environments/RoomEnvironment.js', 'three/addons/environments/RoomEnvironment.js'),
  copy('three/examples/jsm/libs/draco/gltf', 'three/draco'),
  copy('three/LICENSE', 'three/LICENSE'),
  copy('@mediapipe/tasks-vision/vision_bundle.mjs', 'vision/vision_bundle.mjs'),
  copy('@mediapipe/tasks-vision/wasm', 'vision/wasm'),
]);
await cp(path.join(root, 'MEDIAPIPE_LICENSE.txt'), path.join(vendor, 'vision/LICENSE'));
const modelPath = path.join(vendor, 'vision/hand_landmarker.task');
let model;
try { model = await readFile(modelPath); } catch {}
const matches = buffer => buffer && createHash('sha256').update(buffer).digest('hex') === modelHash;
if (!matches(model)) {
  console.log('Downloading official Hand Landmarker model (version 1)...');
  const response = await fetch(modelURL, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  model = Buffer.from(await response.arrayBuffer());
  if (!matches(model)) throw new Error('Hand Landmarker model checksum mismatch.');
  await writeFile(modelPath, model);
}
console.log('Local assets are ready.');

