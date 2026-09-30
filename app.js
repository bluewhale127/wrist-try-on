import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { estimateWristPose, WristPoseTracker, smoothingAlpha } from './pose.js?v=2';
import { HandDetector } from './hand-detector.js?v=2';
import { makeSampleWatch, makeOccluder, disposeModel, inspectGLB } from './watch.js';

const $ = id => document.getElementById(id);
const video = $('camera'), stage = $('stage'), status = $('status'), errorBox = $('error');
const controls = ['scale', 'offset', 'rotation', 'tilt-x', 'tilt-y', 'height'];
const defaults = { scale: 1, offset: 0.38, rotation: 90, 'tilt-x': 0, 'tilt-y': 0, height: 0 };
let renderer, scene, camera, anchor, adjustment, occluder, watch;
let mediaStream = null, mode = 'idle', operation = 0, facingMode = 'environment', mirror = false;
let handLandmarker = null, detectorPromise = null;
const tracker = new WristPoseTracker();
let poseInitialized = false, lastDetection = 0, lastVideoTime = -1, detecting = false;
let width = 1, height = 1, animationId, previousFrame = performance.now();
let fpsStart = 0, detections = 0, modelOperation = 0;
let inferenceInterval = 33;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function notice(message, isError = false) {
  if (isError) { errorBox.hidden = false; errorBox.textContent = message; }
  else { errorBox.hidden = true; errorBox.textContent = ''; status.textContent = message; }
}
function fit() {
  return Object.fromEntries(controls.map(id => [id, Number($(id).value)]));
}
function updateFit() {
  const values = fit();
  for (const id of controls) {
    $(id + '-output').value = id === 'scale' ? `${Math.round(values[id] * 100)}%` : id === 'offset' ? (Math.abs(values[id] - defaults[id]) < 0.005 ? '기본' : `${Math.round(values[id] * 100)}`) : id === 'height' ? values[id].toFixed(2) : `${values[id]}°`;
  }
  if (adjustment) {
    adjustment.rotation.set(THREE.MathUtils.degToRad(values['tilt-x']), THREE.MathUtils.degToRad(values['tilt-y']), THREE.MathUtils.degToRad(values.rotation), 'ZYX');
    adjustment.position.z = values.height;
  }
}
function resetFit() {
  for (const id of controls) $(id).value = defaults[id];
  $('occlusion').checked = true;
  updateFit();
}
function updateMode(next) {
  mode = next;
  stage.classList.toggle('live', next !== 'idle' && !!mediaStream);
  stage.classList.remove('tracked');
  $('mode-label').textContent = next === 'idle' ? '3D 미리보기' : '실시간 착용';
  $('start').textContent = next === 'idle' ? '카메라 시작' : next === 'loading' ? '준비 취소' : '카메라 끄기';
  $('switch').disabled = next !== 'live';
  $('camera-label').textContent = next === 'idle' ? '카메라 꺼짐' : next === 'loading' ? '준비 중' : mirror ? '전면 카메라' : '후면 카메라';
  $('tracking-label').textContent = next === 'idle' ? '3D 미리보기 · 카메라 꺼짐' : next === 'loading' ? '손 추적을 준비하고 있어요' : '손등과 손가락, 손목을 보여 주세요';
  $('fps').textContent = '';
  tracker.reset(); poseInitialized = false;
}
function stopCamera(message = '카메라를 껐습니다. 시계 모델을 계속 살펴볼 수 있어요.') {
  operation++;
  const old = mediaStream;
  mediaStream = null;
  if (old) for (const track of old.getTracks()) track.stop();
  video.pause(); video.srcObject = null;
  updateMode('idle');
  notice(message);
}
async function loadDetector() {
  if (handLandmarker) return handLandmarker;
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    handLandmarker = await new HandDetector().initialize();
    return handLandmarker;
  })();
  try { return await detectorPromise; }
  finally { detectorPromise = null; }
}
async function startCamera() {
  if (!renderer) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice('카메라를 사용하려면 HTTPS 주소 또는 localhost로 열어 주세요. 휴대폰에서 PC의 http://192.168… 주소로 접속하면 카메라를 사용할 수 없습니다. 실행 안내를 확인해 주세요.', true);
    return;
  }
  const id = ++operation;
  updateMode('loading');
  notice('카메라 사용을 허용해 주세요. 처음에는 손 추적 모델을 준비하는 데 시간이 걸릴 수 있습니다.');
  let acquired = null;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
    if (id !== operation) { acquired.getTracks().forEach(t => t.stop()); return; }
    mediaStream = acquired;
    const actualFacing = acquired.getVideoTracks()[0].getSettings().facingMode;
    mirror = (actualFacing || facingMode) === 'user';
    video.classList.toggle('mirror', mirror);
    video.srcObject = acquired;
    await video.play();
    if (id !== operation) return;
    stage.classList.add('live');
    notice('손 추적을 준비하고 있습니다. 잠시만 기다려 주세요.');
    await loadDetector();
    if (id !== operation) return;
    for (const track of acquired.getVideoTracks()) track.addEventListener('ended', () => {
      if (mediaStream === acquired) stopCamera('카메라 연결이 종료됐습니다. 카메라 시작을 눌러 다시 연결해 주세요.');
    }, { once: true });
    lastVideoTime = -1; lastDetection = 0; fpsStart = performance.now(); detections = 0;
    updateMode('live');
    notice('손등이 카메라를 향하도록 하고, 손가락과 손목을 함께 보여 주세요. 크기는 슬라이더로 맞출 수 있어요.');
  } catch (error) {
    if (id !== operation) { acquired?.getTracks().forEach(t => t.stop()); return; }
    stopCamera();
    const messages = {
      NotAllowedError: '카메라 권한이 허용되지 않았습니다. Chrome의 사이트 설정에서 카메라를 허용한 뒤 다시 시작해 주세요.',
      NotFoundError: '사용할 수 있는 카메라가 없습니다. 카메라가 있는 스마트폰의 Chrome에서 열어 주세요.',
      NotReadableError: '카메라를 열 수 없습니다. 다른 카메라 앱을 닫은 뒤 다시 시작해 주세요.',
      OverconstrainedError: '이 카메라는 요청한 설정을 지원하지 않습니다. 다른 카메라나 Chrome에서 다시 시도해 주세요.',
    };
    notice(messages[error.name] || '카메라 또는 손 추적을 준비하지 못했습니다. 새로고침 후 다시 시도해 주세요. vendor 폴더가 모두 포함되어 있어야 합니다.', true);
    console.error('Camera initialization failed:', error);
  }
}
async function detect(time) {
  if (detecting || !handLandmarker || video.readyState < 2 || !video.videoWidth || time - lastDetection < inferenceInterval || video.currentTime === lastVideoTime) return;
  detecting = true;
  const id = operation;
  lastVideoTime = video.currentTime; lastDetection = time;
  try {
    const { result, elapsed } = await handLandmarker.detect(video, time);
    if (id !== operation || mode !== 'live') return;
    const completed = performance.now();
    inferenceInterval = Math.max(33, Math.min(120, elapsed * (handLandmarker.backend.startsWith('worker') ? 1.05 : 1.5)));
    detections++;
    if (time - fpsStart >= 1200) { $('fps').textContent = `${Math.round(detections * 1000 / (time - fpsStart))} 추적/초`; fpsStart = time; detections = 0; }
    const values = fit();
    const next = estimateWristPose(result.landmarks?.[0], { width, height, videoWidth: video.videoWidth, videoHeight: video.videoHeight }, { mirror, offset: values.offset, scale: values.scale, worldLandmarks: result.worldLandmarks?.[0] });
    if (tracker.update(next, completed)) {
      $('tracking-label').textContent = '손목을 따라 시계를 맞추고 있어요';
      stage.classList.add('tracked');
    } else {
      $('tracking-label').textContent = tracker.sample(completed) ? '손목을 다시 확인하고 있어요' : '손등과 손가락, 손목을 보여 주세요';
    }
  } catch (error) {
    if (id === operation && mode === 'live') { stopCamera(); notice('손 추적이 중단되었습니다. 카메라를 다시 시작해 주세요.', true); console.error(error); }
  } finally { detecting = false; }
}
function render(time) {
  animationId = requestAnimationFrame(render);
  if (!renderer || document.hidden) return;
  const dt = (time - previousFrame) / 1000;
  previousFrame = time;
  if (mode === 'live') {
    void detect(time);
  }
  if (mode === 'idle') {
    anchor.visible = true;
    anchor.position.set(0, 2, 0);
    anchor.scale.setScalar(Math.min(width * 0.49, height * 0.35) * Number($('scale').value));
    anchor.rotation.set(0.2, reduceMotion ? -0.25 : Math.sin(time * 0.0003) * 0.25 - 0.15, -0.08);
    occluder.visible = false;
  } else {
    const targetPose = tracker.sample(time);
    anchor.visible = mode === 'live' && !!targetPose;
    stage.classList.toggle('tracked', anchor.visible);
    if (anchor.visible) {
      const alpha = poseInitialized ? smoothingAlpha(dt, 40) : 1;
      anchor.position.lerp(targetPose.position, alpha);
      anchor.quaternion.slerp(targetPose.rotation, alpha);
      anchor.scale.lerp(new THREE.Vector3().setScalar(targetPose.size), alpha);
      poseInitialized = true;
    } else poseInitialized = false;
    occluder.visible = $('occlusion').checked;
  }
  renderer.render(scene, camera);
}
function replaceModel(model) {
  if (watch) { adjustment.remove(watch); disposeModel(watch); }
  watch = model; adjustment.add(watch);
}
async function importModel(file) {
  if (!file) return;
  const id = ++modelOperation;
  $('model-status').textContent = '시계를 불러오고 있습니다…';
  let loader, draco, loaded = null;
  try {
    if (!/\.glb$/i.test(file.name)) throw new Error('.glb 파일을 선택해 주세요.');
    if (file.size > 40 * 1024 * 1024) throw new Error('모바일 테스트용으로 40MB 이하의 모델을 선택해 주세요.');
    const buffer = await file.arrayBuffer();
    inspectGLB(buffer);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      if (/^(blob:|data:)/.test(url) || url.startsWith(new URL('./vendor/three/draco/', import.meta.url).href)) return url;
      throw new Error('외부 파일을 참조하는 모델입니다. 텍스처를 GLB 안에 포함해 주세요.');
    });
    draco = new DRACOLoader(manager);
    draco.setDecoderPath(new URL('./vendor/three/draco/', import.meta.url).href);
    loader = new GLTFLoader(manager).setDRACOLoader(draco);
    const gltf = await loader.parseAsync(buffer, ''); loaded = gltf.scene;
    if (id !== modelOperation) { disposeModel(loaded); loaded = null; return; }
    const bounds = new THREE.Box3().setFromObject(loaded);
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    if (bounds.isEmpty() || size.x < 1e-8 || !Number.isFinite(size.length())) throw new Error('크기를 확인할 수 없는 모델입니다. 메시가 포함되어 있는지 확인해 주세요.');
    // Keep the artist's local origin in Z for wrist contact. Center X/Y and normalize X width.
    loaded.position.x -= center.x; loaded.position.y -= center.y;
    const normalized = new THREE.Group(); normalized.scale.setScalar(1 / size.x); normalized.add(loaded);
    replaceModel(normalized); loaded = null;
    resetFit();
    $('model-name').textContent = file.name.replace(/\.glb$/i, '');
    $('model-caption').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 내 시계 모델`;
    $('model-status').textContent = '불러왔습니다. 크기와 방향을 맞춰 주세요.';
  } catch (error) {
    if (loaded) disposeModel(loaded);
    if (id === modelOperation) $('model-status').textContent = error.message || '모델을 불러오지 못했습니다. GLB 내보내기 설정을 확인해 주세요.';
  } finally { draco?.dispose(); if (id === modelOperation) $('model-file').value = ''; }
}

try {
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000); camera.position.z = 2000;
  scene.add(new THREE.HemisphereLight(0xe5faff, 0x19212e, 2));
  const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(-200, 500, 800); scene.add(key);
  const fill = new THREE.DirectionalLight(0xa2e8e2, 2); fill.position.set(400, -200, 500); scene.add(fill);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture; pmrem.dispose(); room.dispose();
  anchor = new THREE.Group(); adjustment = new THREE.Group(); occluder = makeOccluder();
  anchor.add(occluder, adjustment); scene.add(anchor); replaceModel(makeSampleWatch()); updateFit();
  new ResizeObserver(() => {
    ({ width, height } = stage.getBoundingClientRect());
    renderer.setSize(width, height, false);
    camera.left = -width / 2; camera.right = width / 2; camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
    tracker.reset(); poseInitialized = false;
  }).observe(stage);
  animationId = requestAnimationFrame(render);
} catch (error) {
  notice('3D 화면을 시작하지 못했습니다. WebGL을 지원하는 최신 Chrome에서 열어 주세요.', true);
  $('start').disabled = true; console.error(error);
}
for (const id of controls) $(id).addEventListener('input', updateFit);
$('reset').addEventListener('click', resetFit);
$('start').addEventListener('click', () => mode === 'idle' ? startCamera() : stopCamera());
$('switch').addEventListener('click', () => { facingMode = mirror ? 'environment' : 'user'; stopCamera(); startCamera(); });
$('model-file').addEventListener('change', event => importModel(event.target.files[0]));
$('sample').addEventListener('click', () => {
  if (!adjustment) return;
  modelOperation++; replaceModel(makeSampleWatch()); resetFit();
  $('model-name').textContent = 'Studio 01'; $('model-caption').textContent = '준비된 모델이 없어도 바로 테스트할 수 있어요.'; $('model-status').textContent = ''; $('model-file').value = '';
});
document.addEventListener('visibilitychange', () => { if (document.hidden && mode !== 'idle') stopCamera('다른 화면으로 이동해 카메라를 껐습니다. 다시 시작하려면 카메라 시작을 눌러 주세요.'); });
window.addEventListener('pagehide', () => { stopCamera(); });
