import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { estimateWristPose, landmarkPoint, WristPoseTracker, smoothingAlpha, watchRotationDegrees } from './pose.js?v=101';
import { calibrationPrompt } from './initial-calibration.js?v=101';
import { RearPalmAxis } from './rear-axis.js?v=79';
import { HandDetector } from './hand-detector.js?v=75';
import { RearWristAssist, rearObservation } from './rear-assist.js?v=75';
import { HandTarget } from './hand-target.js?v=73';
import { makeSampleWatch, disposeModel, inspectGLB, normalizeImportedWatch } from './watch.js?v=106';
import { WristRig, wristDimensions } from './wrist-rig.js?v=106';
import { DiagnosticRecorder } from './diagnostic-recorder.js?v=711';

import { FIT_CONTROLS, FitSettings, defaultFit } from './fit-settings.js?v=719';
import {HandWristCenter} from './hand-wrist-center.mjs?v=2';
import {WristCenterClient} from './wrist-center-client.mjs?v=1';
import {WristCenterContinuation} from './wrist-center-continuation.mjs?v=1';
import {WatchSizeLock} from './watch-size-lock.mjs?v=1';

const $ = id => document.getElementById(id);
const video = $('camera'), stage = $('stage'), status = $('status'), errorBox = $('error');
const controls = FIT_CONTROLS;
const engine = 'hand', defaults = defaultFit(engine);
let modelKey = 'sample';
let storage; try { storage = window.localStorage; } catch {}
const fitSettings = new FitSettings(storage);
let renderer, scene, camera, anchor, adjustment, occluder, watch;
let mediaStream = null, mode = 'idle', operation = 0, facingMode = 'environment', mirror = false;
let handLandmarker = null, detectorPromise = null;
const tracker = new WristPoseTracker({allowClosedStart:!!$('model10-center')});
const handTarget = new HandTarget();
const rearAssist = new RearWristAssist();
const rearAxis = new RearPalmAxis();
const wristCenter = new HandWristCenter();
const wristContinuation=new WristCenterContinuation();
const watchSizeLock=new WatchSizeLock();
let renderSource=null,sourceTransition=null;
let centerClient=null,centerFailure='';
const centerEnabled=()=>!!$('model10-center')?.checked;
const continuationEnabled=()=>centerEnabled()&&!!$('wrist-continue')?.checked;
const rearEnabled = () => !mirror && $('rear-assist').checked;
const rearAxisEnabled = () => !mirror && $('rear-axis').checked;
const debugCanvas = $('tracking-debug'), debugContext = debugCanvas.getContext('2d');
let debugFrame = null;
const diagnosticRecorder = new DiagnosticRecorder();
const renderedCaseRotation = new THREE.Quaternion();
let lastDiagnosticUiTime = -Infinity;
const renderCenter = new THREE.Vector3();
let renderRadius = 0, renderSize = 0;
let poseInitialized = false, lastDetection = 0, lastVideoTime = -1, detecting = false;
let width = 1, height = 1, animationId, previousFrame = performance.now();
let fpsStart = 0, detections = 0, modelOperation = 0;
let inferenceInterval = 33;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function diagnosticContext() {
  return { mode, operation, mirror, facingMode, orientationSign: tracker.orientationSign,
    centerMode:centerEnabled()?'hybrid10':'legacy',centerFailure,
    watchOrientationSign: tracker.watchOrientationSign, template: tracker.template?.map(p => p.toArray()),
    selectedRotation: tracker.previousRotation?.toArray(), rotationVelocity: tracker.rotationVelocity.toArray(),
    view: { width, height, videoWidth: video.videoWidth, videoHeight: video.videoHeight },
    fit: fit(), rearAssistEnabled: rearEnabled(), rearAxisEnabled: rearAxisEnabled() };
}
function diagnosticEvent(type, detail = {}) {
  diagnosticRecorder.event(performance.now(), type, { ...diagnosticContext(), ...detail });
}
function updateDiagnosticUi(time = performance.now(), force = false) {
  if (!force && time - lastDiagnosticUiTime < 250) return;
  lastDiagnosticUiTime = time;
  const s = diagnosticRecorder.summary(time);
  $('record-diagnostics').textContent = s.active ? '진단 기록 중지' : s.frames || s.renderSamples ? '진단 기록 이어서' : '진단 기록 시작';
  $('record-diagnostics').disabled = s.full;
  $('clear-diagnostics').disabled = s.active || !(s.frames || s.renderSamples);
  $('save-diagnostics').disabled = !(s.frames || s.renderSamples);
  const state = s.active ? '기록 중' : s.full ? '기록 한도 도달 · 저장해 주세요' : s.frames || s.renderSamples ? '기록 멈춤' : '진단 기록 꺼짐';
  $('recording-status').textContent = `${state} · 관측 ${s.frames}개 · 시계 표시 ${s.visibleWatchSamples}개 · ${Math.floor(s.durationMs / 1000)}초 / 120초`;
  $('recording-help').textContent = s.visibleWatchSamples ? '시계 본체의 표시 기록이 포함돼 있어요. 문제가 생기면 바로 저장해 주세요.' : '시계 표시가 0개면 본체가 붙은 구간이 아직 기록되지 않았어요.';
}

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
    $(id + '-output').value = id === 'scale' || id.startsWith('wrist-') ? `${Math.round(values[id] * 100)}%` : id === 'offset' ? (Math.abs(values[id] - defaults[id]) < 0.005 ? '기본' : `${Math.round(values[id] * 100)}`) : id === 'height' ? values[id].toFixed(2) : `${values[id]}°`;
  }
  applyCaseOrientation(values);
}
function applyCaseOrientation(values) {
  if (!adjustment) return;
  const rotation = watchRotationDegrees(values.rotation, mode === 'live' ? tracker.watchOrientationSign : 1);
  adjustment.rotation.set(THREE.MathUtils.degToRad(values['tilt-x']), THREE.MathUtils.degToRad(values['tilt-y']), THREE.MathUtils.degToRad(rotation), 'ZYX');
}
function applyFit(values) {
  rearAssist.reset(); rearAxis.reset();
  for (const id of controls) $(id).value = values[id];
  $('occlusion').checked = values.occlusion;
  updateFit();
}
function saveFit() {
  const saved = fitSettings.save(engine, modelKey, { ...fit(), occlusion: $('occlusion').checked });
  $('fit-saved').textContent = saved ? '이 브라우저에 자동 저장됐어요.' : '이 브라우저에서는 설정 저장을 사용할 수 없어요.';
}
function resetFit() {
  applyFit(defaultFit(engine, modelKey)); $('wrist-guide').checked = false; saveFit();
}
function updateMode(next) {
  diagnosticEvent('tracking-reset', { reason: 'camera-mode', nextMode: next });
  mode = next;
  stage.classList.toggle('live', next !== 'idle' && !!mediaStream);
  stage.classList.remove('tracked');
  $('mode-label').textContent = next === 'idle' ? '3D 미리보기' : '실시간 착용';
  $('start').textContent = next === 'idle' ? '카메라 시작' : next === 'loading' ? '준비 취소' : '카메라 끄기';
  $('switch').disabled = next !== 'live';
  $('calibrate').disabled = next !== 'live';
  $('align-dial').disabled = next === 'loading';
  $('camera-label').textContent = next === 'idle' ? '카메라 꺼짐' : next === 'loading' ? '준비 중' : mirror ? '전면 카메라' : '후면 카메라';
  $('tracking-label').textContent = next === 'idle' ? '3D 미리보기 · 카메라 꺼짐' : next === 'loading' ? '손 추적을 준비하고 있어요' : '손등과 손가락, 손목을 보여 주세요';
  $('fps').textContent = '';
  tracker.reset();watchSizeLock.reset(); wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null; rearAxis.reset(); handTarget.reset(); rearAssist.reset(); poseInitialized = false;
  $('rear-assist').disabled = next === 'loading' || (next === 'live' && mirror);
  $('rear-axis').disabled = next === 'loading' || (next === 'live' && mirror);
  debugFrame = null; debugContext.clearRect(0, 0, width, height);
  if (next === 'idle') $('debug-info').textContent = '카메라가 꺼졌습니다. 남아 있는 진단 기록은 저장할 수 있어요.';
}
function stopCamera(message = '카메라를 껐습니다. 시계 모델을 계속 살펴볼 수 있어요.') {
  operation++;
  centerClient?.close();centerClient=null;wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null;
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
    centerFailure='';
    if(centerEnabled()){
      const client=new WristCenterClient();centerClient=client;
      try{await client.initialize();}
      catch(error){client.close();if(id===operation){centerClient=null;centerFailure=error.message;}}
      if(id!==operation){client.close();return;}
    }
    for (const track of acquired.getVideoTracks()) track.addEventListener('ended', () => {
      if (mediaStream === acquired) stopCamera('카메라 연결이 종료됐습니다. 카메라 시작을 눌러 다시 연결해 주세요.');
    }, { once: true });
    lastVideoTime = -1; lastDetection = 0; fpsStart = performance.now(); detections = 0;
    updateMode('live');
    notice($('model10-center')?'손등 또는 주먹의 등을 카메라와 평행하게 보여 주세요. 주먹은 약 3초 동안 유지해 주세요.':'손등과 손가락을 카메라 쪽으로 편하게 펴고 약 2초 동안 움직이지 않고 유지해 주세요. 다른 손으로 바꾸면 손등 기준을 다시 맞춰 주세요.');
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
    const assistEnabled = rearEnabled();
    let handData,centerData=null;
    if(centerEnabled()&&centerClient){
      const s=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight));
      const frame=await createImageBitmap(video,{resizeWidth:Math.round(video.videoWidth*s),resizeHeight:Math.round(video.videoHeight*s),resizeQuality:'high'});
      try{
        const client=centerClient;
        const [hand,center]=await Promise.allSettled([handLandmarker.detect(frame,time,{captureGray:assistEnabled}),client.detect(frame,time)]);
        if(hand.status==='rejected')throw hand.reason;
        handData=hand.value;
        if(center.status==='fulfilled')centerData=center.value;
        else if(id===operation){centerFailure=center.reason.message;client.close();if(centerClient===client)centerClient=null;}
      }finally{frame.close();}
    }else handData=await handLandmarker.detect(video,time,{captureGray:assistEnabled});
    const {result,elapsed,gray}=handData;
    if (id !== operation || mode !== 'live') return;
    const completed = performance.now();
    inferenceInterval = Math.max(33, Math.min(120, elapsed * (handLandmarker.backend.startsWith('worker') ? 1.05 : 1.5)));
    detections++;
    if (time - fpsStart >= 1200) { $('fps').textContent = `${Math.round(detections * 1000 / (time - fpsStart))} 회/초`; fpsStart = time; detections = 0; }
    const values = fit();
    const view = { width, height, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
    const assistStarted = performance.now();
    const visual = assistEnabled ? rearAssist.advance(gray, view, time) : null;
    const selected = handTarget.select(result, view, time, { allowRelocation: mirror || assistEnabled });
    const landmarks = selected === null ? null : result.landmarks[selected];
    const worldLandmarks = selected === null ? null : result.worldLandmarks?.[selected];
    const next = estimateWristPose(landmarks, view, { mirror, offset: values.offset, scale: values.scale, worldLandmarks });
    const observation = assistEnabled ? rearObservation(next, landmarks, tracker, visual) : {allowed:true};
    const accepted = tracker.update(observation.allowed ? next : null, time);
    const displayPose = accepted && tracker.orientationSign && rearAxisEnabled()
      ? rearAxis.update(tracker.pose, next, tracker.template, time) : tracker.pose;
    if (!accepted) rearAxis.interrupt();
    if(centerEnabled()&&accepted&&tracker.orientationSign){
      wristCenter.update({...displayPose,imagePalm:next.imagePalm},centerData,view,values,time,completed,mirror,{...tracker.diagnostics,moving:tracker.speed>.3||tracker.angularSpeed>.35});
    }else if(centerEnabled())wristCenter.update(null,null,view,values,time,completed,mirror);
    if(continuationEnabled()){
      const trusted=accepted&&tracker.orientationSign&&tracker.diagnostics.quality>=.65;
      const fitted=trusted?wristCenter.apply(displayPose,completed,view,mirror):null;
      wristContinuation.update(fitted,centerData,view,time,completed,mirror,selected===null||!next?.calibration?.inFrame);
    }else wristContinuation.reset();
    if($('model10-status'))$('model10-status').textContent=!centerEnabled()?'기존 손 관절 위치 사용':centerFailure?'손목 모델을 준비하지 못해 기존 위치를 사용합니다. 카메라를 다시 켜 주세요.':wristCenter.diagnostic.used?(wristCenter.diagnostic.reason==='local-fit'?'모델10.6 · 착용 위치 보정 중':'모델10.6 · 착용 위치 유지 중'):'모델10.6 · 손등에서 착용 위치 확인 중';
    if(assistEnabled){
      if(accepted && tracker.orientationSign && tracker.diagnostics.quality>=.65 && tracker.diagnostics.disagreement<.75)rearAssist.correct(displayPose,time);
      else if(accepted){rearAssist.reset();rearAssist.diagnostics={state:'hand',reason:'uncertain-anchor'};}
      else rearAssist.fallback(time,observation.allowed ? tracker.diagnostics.state : observation.reason);
    }
    const assistMs = performance.now()-assistStarted;
    if(assistEnabled)inferenceInterval=Math.max(inferenceInterval,Math.min(120,elapsed+assistMs));
    if (accepted || ['calibrating','uncertain','reorient','reacquiring','outlier','depth-check','turn-check'].includes(tracker.diagnostics.state)) {
      const diagnostic = tracker.diagnostics;
      $('tracking-label').textContent = !tracker.orientationSign ? (tracker.allowClosedStart&&diagnostic.reason==='open'?'손등 또는 편하게 쥔 주먹의 등을 보여 주세요':calibrationPrompt(diagnostic)) : ['depth-check','turn-check'].includes(diagnostic.state) ? '손목 회전 방향을 다시 확인하고 있어요' : diagnostic.state === 'reorient' ? '손등 또는 손바닥을 펴서 잠깐 유지 · 방향 복구 중' : diagnostic.state === 'reacquiring' ? '기존 손의 회전을 다시 확인하고 있어요' : ['uncertain','outlier'].includes(diagnostic.state) ? '손목 움직임을 다시 확인하고 있어요' : diagnostic.surfaceConfirmed ? `${diagnostic.surface==='palm'?'손바닥':'손등'} 방향 확인 · 회전을 따라가고 있어요` : diagnostic.state === 'corrected' ? '화면의 손 모양으로 회전을 보정하고 있어요' : '손목 회전을 따라가고 있어요';
    } else {
      $('tracking-label').textContent = handTarget.state === 'recovering' ? '새 위치의 손을 확인 중 · 손등을 잠깐 유지해 주세요' : handTarget.state === 'lost' ? '같은 손을 원래 위치로 · 계속 안 잡히면 손등 기준 맞추기' : tracker.sample(completed) ? '손목을 다시 확인하고 있어요' : '손등과 손가락, 손목을 보여 주세요';
    }
    if(assistEnabled && rearAssist.sample(performance.now()))$('tracking-label').textContent=rearAssist.bridge?'손목 영상으로 잠시 유지 중 · 큰 회전은 멈춰 주세요':'손 관절 추적으로 부드럽게 복귀 중';
    else if(assistEnabled && !observation.allowed && ['foreshortened','perspective'].includes(observation.reason))$('tracking-label').textContent='기울기가 커서 방향을 확인하기 어려워요 · 손등을 다시 보여 주세요';
    debugFrame = { next, landmarks, time,centerData };
    if ($('debug').checked) {
      const d = tracker.diagnostics;
      $('debug-info').textContent = `상태: ${{calibrating:'기준 설정',tracking:'추적',corrected:'기울기 보정',uncertain:'불확실',missing:'손 없음',reorient:'손 표면으로 방향 복구',reacquiring:'회전 재확인',outlier:'순간 튐 확인','depth-check':'전면 회전 방향 재확인','turn-check':'후면 되돌림 방향 확인'}[d.state]} · 배치 일치도 ${Math.round(d.quality*100)}%\n표면 추정: ${{back:'손등',palm:'손바닥',edge:'옆면·기울임'}[d.surface]||'확인 중'} · 기준 ${d.surfaceConfirmed?'확인됨':'확인 중'}\n시계 방향 ${values.rotation}° · 엄지 축 ${tracker.watchOrientationSign}\n대상: ${handTarget.state} · 검출 ${result.landmarks?.length || 0}개\n프레임 처리 ${Math.round(completed-time)}ms · ${handLandmarker.backend}\n일치도는 실제 정확도 점수가 아닙니다.`;
      if(mirror)$('debug-info').textContent+=`\n전면 깊이 확인 ${d.depthEvidenceFrames||0}회 · ${d.depthRealigned?'방향 복구':d.depthPending?'방향 확인 중':'추적 중'}`;
      if(rearAxisEnabled() && rearAxis.diagnostics)$('debug-info').textContent+=`\n팔 기울기 보정 ${Math.round(rearAxis.diagnostics.correction*180/Math.PI)}° · ${rearAxis.diagnostics.trusted?'관절 확인됨':'확인 중'}`;
      if(!tracker.orientationSign)$('debug-info').textContent+=`\n초기 기준: ${calibrationPrompt(d)}`;
      if(assistEnabled)$('debug-info').textContent+=`\n후면 보조: ${rearAssist.diagnostics.state} · ${rearAssist.diagnostics.reason} · ${Math.round(assistMs)}ms`;
    }
    if (diagnosticRecorder.active) {
      diagnosticRecorder.recordFrame({ time, completedTime: completed, operation, accepted,
        elapsed: completed-time, inferenceMs: elapsed, backend: handLandmarker.backend,
        rearAssist:assistEnabled?{...rearAssist.diagnostics,observation,processingMs:assistMs}:null,
        rearAxis:rearAxisEnabled()?rearAxis.diagnostics:null, displayRotation:displayPose?.rotation.toArray(),
        view:{width,height,videoWidth:video.videoWidth,videoHeight:video.videoHeight}, mirror, fit:values,
        landmarks,worldLandmarks,calibration:next?.calibration,handedness:selected === null ? null : result.handedness?.[selected],
        centerMode:centerEnabled()?'hybrid10':'legacy',centerMeasurement:centerData?{pose:centerData.pose,width:centerData.width,height:centerData.height,time:centerData.time,inferenceMs:centerData.inferenceMs}:null,centerFusion:wristCenter.diagnostic,
        wristContinuation:wristContinuation.diagnostic,
        target:{state:handTarget.state,index:selected,detected:result.landmarks?.length || 0},
        diagnostic:tracker.diagnostics, orientationSign:tracker.orientationSign, watchOrientationSign:tracker.watchOrientationSign,
        template:tracker.template?.map(p=>p.toArray()), selectedRotation:tracker.previousRotation?.toArray(), rotationVelocity:tracker.rotationVelocity.toArray(),
        depthRotation:next?.depthRotation?.toArray(), caseRotationDegrees:watchRotationDegrees(values.rotation,tracker.watchOrientationSign), rawRotation:next?.rotation.toArray(), rotation:tracker.pose?.rotation.toArray(),position:tracker.pose?.position.toArray() }, completed);
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
  const values = fit();
  applyCaseOrientation(values);
  let centerApplied=false;
  if (mode === 'live') {
    void detect(time);
  }
  if (mode === 'idle') {
    anchor.visible = true;
    anchor.position.set(0, 2, 0);
    const baseSize = Math.min(width * 0.49, height * 0.35);
    anchor.fit({ ...wristDimensions(baseSize / 0.65, values['wrist-width'], values['wrist-depth']), caseSize: baseSize * values.scale, height: values.height, sample: !!watch.userData.sample, guide: $('wrist-guide').checked, wristPivot: watch.userData.wristPivot });
    anchor.rotation.set(0.2, reduceMotion ? -0.25 : Math.sin(time * 0.0003) * 0.25 - 0.15, -0.08);
    occluder.visible = false;
  } else {
    const trackedPose = tracker.sample(time);
    const legacyPose = (rearEnabled() ? rearAssist.sample(time) : null) ||
      (trackedPose && rearAxisEnabled() ? rearAxis.sample(time) || trackedPose : trackedPose);
    const view={width,height,videoWidth:video.videoWidth,videoHeight:video.videoHeight};
    const centerPose=continuationEnabled()?wristContinuation.sample(time,view,mirror):null;
    const handPose=legacyPose||centerPose,centerOnly=!!handPose&&!legacyPose;
    anchor.visible = mode === 'live' && !!handPose && !!tracker.orientationSign;
    stage.classList.toggle('tracked', anchor.visible);
    if (anchor.visible) {
      const source=centerOnly?'center-only':'hand';
      if(renderSource&&source!==renderSource)sourceTransition={position:anchor.position.clone(),rotation:anchor.quaternion.clone(),time};
      renderSource=source;
      const alpha = poseInitialized ? smoothingAlpha(dt, 40) : 1;
      renderCenter.lerp(handPose.position, alpha);
      const dimensions=$('lock-size')?.checked?watchSizeLock.dimensions(handPose,values.scale):handPose;
      renderRadius += (dimensions.wristRadius - renderRadius) * alpha;
      renderSize += (dimensions.size - renderSize) * alpha;
      // Smooth the underlying hand once, then rotate its wearing offset with
      // the very same quaternion/radius used by this render. Do not lag the
      // offset in screen space behind a newer rotation.
      const renderedHand={...handPose,position:renderCenter};
      const fitted=centerEnabled()&&!centerOnly?wristCenter.apply(renderedHand,time,view,mirror):renderedHand;
      centerApplied=fitted!==renderedHand;
      anchor.quaternion.copy(handPose.rotation);
      anchor.position.copy(fitted.position);
      if(sourceTransition){const t=Math.min(1,(time-sourceTransition.time)/180);anchor.position.lerpVectors(sourceTransition.position,anchor.position,t);anchor.quaternion.slerpQuaternions(sourceTransition.rotation,handPose.rotation,t);if(t===1)sourceTransition=null;}
      anchor.fit({ ...wristDimensions(renderRadius / (0.65 * 0.46), values['wrist-width'], values['wrist-depth']), caseSize: renderSize, height: values.height, sample: !!watch.userData.sample, guide: $('wrist-guide').checked, wristPivot: watch.userData.wristPivot });
      if(centerOnly){$('tracking-label').textContent='손목 중심 추적 · 방향·크기 유지 중';$('model10-status').textContent='손목 중심으로 위치를 이어갑니다. 회전하거나 거리가 바뀌면 손을 다시 보여 주세요.';}
      poseInitialized = true;
    } else {poseInitialized = false;renderSource=null;sourceTransition=null;
      if(continuationEnabled()&&wristContinuation.diagnostic.state==='center-without-axes')$('tracking-label').textContent='손목 중심 확인 · 처음에는 손을 보여 방향을 맞춰 주세요';
    }
    occluder.visible = $('occlusion').checked;
  }
  renderer.render(scene, camera);
  if (diagnosticRecorder.active) {
    const watchVisible = mode === 'live' && anchor.visible;
    diagnosticRecorder.recordRender({ time, mode, operation, watchVisible, inferenceTime: debugFrame?.time ?? null,
      centerApplied:watchVisible&&centerApplied,
      trackingSource:watchVisible?renderSource:null,
      modelWristPivot:watch.userData.wristPivot || null,caseMountOffset:watchVisible?adjustment.position.toArray():null,
      sizeLocked:!!$('lock-size')?.checked,caseSize:watchVisible?renderSize:null,wristRadius:watchVisible?renderRadius:null,
      orientationSign: tracker.orientationSign, state: tracker.diagnostics.state, mirror,
      anchorRotation: watchVisible ? anchor.quaternion.toArray() : null,
      caseWorldRotation: watchVisible ? adjustment.getWorldQuaternion(renderedCaseRotation).toArray() : null,
      position: watchVisible ? anchor.position.toArray() : null });
  }
  updateDiagnosticUi(time);
  drawDiagnostics(time);
}

function drawDiagnostics(time) {
  debugCanvas.hidden = !$('debug').checked;
  if (debugCanvas.hidden) return;
  debugContext.clearRect(0,0,width,height);
  if (mode !== 'live' || !debugFrame || time-debugFrame.time>220) return;
  if (!debugFrame.landmarks) return;
  const view={width,height,videoWidth:video.videoWidth,videoHeight:video.videoHeight};
  const point=p=>[p.x+width/2,height/2-p.y];
  const points=debugFrame.landmarks.map(p=>point(landmarkPoint(p,view,mirror)));
  const line=(a,b,color)=>{debugContext.strokeStyle=color;debugContext.lineWidth=2;debugContext.beginPath();debugContext.moveTo(...a);debugContext.lineTo(...b);debugContext.stroke();};
  for(const chain of [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]])for(let i=1;i<chain.length;i++)line(points[chain[i-1]],points[chain[i]],'#ffe28c');
  debugContext.fillStyle='#ffe28c';for(const p of points){debugContext.beginPath();debugContext.arc(...p,3,0,Math.PI*2);debugContext.fill();}
  if(debugFrame.next && tracker.pose){
    const origin=tracker.pose.position, length=tracker.pose.size;
    const raw=debugFrame.next.rotation.clone();if(tracker.orientationSign===-1)raw.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));
    const shown = (rearEnabled() && rearAssist.sample(time)) || (rearAxisEnabled() && rearAxis.sample(time)) || tracker.pose;
    for(const [rotation,color] of [[raw,'#66b7ff'],[shown.rotation,'#a2efdb']]) {
      const tip=new THREE.Vector3(0,0,length).applyQuaternion(rotation).add(origin);
      line(point(origin),point(tip),color);
      debugContext.fillStyle=color;debugContext.beginPath();debugContext.arc(...point(tip),5,0,Math.PI*2);debugContext.fill();
    }
  }
}
function replaceModel(model) {
  if (watch) { adjustment.remove(watch); disposeModel(watch); }
  watch = model; adjustment.add(watch);
}
async function importModel(file, profileKey) {
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
    const normalized = normalizeImportedWatch(loaded, { wristLoopName: profileKey === 'datejust' ? '@bra-U-12' : undefined });
    replaceModel(normalized); loaded = null;
    modelKey = profileKey || 'glb:' + file.name + ':' + file.size; applyFit(fitSettings.load(engine, modelKey));
    $('model-name').textContent = file.name.replace(/\.glb$/i, '');
    $('model-caption').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 내 시계 모델`;
    $('model-status').textContent = normalized.userData.wristPivot ? '스트랩 고리 중심을 손목 회전 중심에 맞췄습니다. 원본 GLB 형태를 유지합니다.' : normalized.userData.caseAnchored ? '케이스 중심·뒷면 기준으로 불러왔습니다. 스트랩은 모델의 고정된 형태이며 손목에 맞게 자동으로 휘어지지는 않습니다.' : '불러왔습니다. 손목 모형으로 위치를 맞출 수 있어요. GLB의 스트랩 형태는 그대로 유지됩니다.';
  } catch (error) {
    if (loaded) disposeModel(loaded);
    if (id === modelOperation) $('model-status').textContent = error.message || '모델을 불러오지 못했습니다. GLB 내보내기 설정을 확인해 주세요.';
  } finally { draco?.dispose(); if (id === modelOperation) $('model-file').value = ''; }
}

async function loadDatejust() {
  const button = $('datejust'), id = ++modelOperation;
  if (button) button.disabled = true;
  $('model-status').textContent = 'Datejust 모델을 내려받고 있습니다… (약 22MB)';
  try {
    const response = await fetch(new URL('./datejust-ar.glb?v=1', import.meta.url));
    if (!response.ok) throw new Error('모델을 내려받지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
    const blob = await response.blob();
    if (id !== modelOperation) return;
    await importModel(new File([blob], 'Rolex-Datejust-AR.glb', { type: 'model/gltf-binary' }), 'datejust');
  } catch (error) { if (id === modelOperation) $('model-status').textContent = error.message || '모델을 불러오지 못했습니다.'; }
  finally { if (button) button.disabled = false; }
}

try {
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000); camera.position.z = 2000;
  // Leave headroom for polished metal reflections in both preview and AR.
  scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x19212e, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(-200, 500, 800); scene.add(key);
  const fill = new THREE.DirectionalLight(0xf1f5ff, 0.4); fill.position.set(400, -200, 500); scene.add(fill);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture; pmrem.dispose(); room.dispose();
  scene.environmentIntensity = 0.65;
  anchor = new WristRig(); adjustment = anchor.caseMount; occluder = anchor.occluder;
  scene.add(anchor); replaceModel(makeSampleWatch()); updateFit();
  new ResizeObserver(() => {
    diagnosticEvent('tracking-reset', { reason: 'stage-resize', nextView: { width: stage.clientWidth, height: stage.clientHeight } });
    ({ width, height } = stage.getBoundingClientRect());
    renderer.setSize(width, height, false);
    debugCanvas.width = Math.round(width); debugCanvas.height = Math.round(height);
    camera.left = -width / 2; camera.right = width / 2; camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
    tracker.reset();watchSizeLock.reset(); wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null; rearAxis.reset(); rearAssist.reset(); poseInitialized = false;
  }).observe(stage);
  animationId = requestAnimationFrame(render);
} catch (error) {
  notice('3D 화면을 시작하지 못했습니다. WebGL을 지원하는 최신 Chrome에서 열어 주세요.', true);
  $('start').disabled = true; console.error(error);
}
applyFit(fitSettings.load(engine, modelKey));
for (const id of controls) $(id).addEventListener('input', () => { rearAssist.reset(); rearAxis.reset(); updateFit(); saveFit(); });
$('rear-assist').addEventListener('change',()=>{
  diagnosticEvent('tracking-reset', { reason: 'rear-assist-setting' });
  operation++;rearAssist.reset();tracker.reset();watchSizeLock.reset(); wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null; rearAxis.reset();handTarget.reset();poseInitialized=false;
  notice('후면 추적 설정을 바꿨어요. 손등과 손가락을 보여 기준을 다시 맞춰 주세요.');
});
$('occlusion').addEventListener('change', saveFit);
$('rear-axis').addEventListener('change',()=>{rearAxis.reset();rearAssist.reset();});
$('reset').addEventListener('click', resetFit);
$('align-dial').addEventListener('click', () => {
  diagnosticEvent('tracking-reset', { reason: 'align-dial' });
  $('rotation').value = 90; $('tilt-x').value = 0; $('tilt-y').value = 0;
  updateFit(); saveFit();
  if (mode === 'live') { operation++; tracker.reset();watchSizeLock.reset(); wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null; rearAxis.reset(); handTarget.reset(); rearAssist.reset(); poseInitialized = false; }
  notice('6시는 엄지, 12시는 새끼손가락 쪽으로 맞춥니다. 카메라에 손등과 손가락을 펴고 약 2초 동안 움직이지 않고 유지해 주세요.');
});
$('calibrate').addEventListener('click', () => {
  diagnosticEvent('tracking-reset', { reason: 'calibrate-button' });
  operation++;
  tracker.reset();watchSizeLock.reset(); wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null; rearAxis.reset(); handTarget.reset(); rearAssist.reset(); poseInitialized = false;
  notice('손등과 손가락을 카메라 쪽으로 펴고 약 2초 동안 움직이지 않고 유지해 주세요. 손의 기준 형태와 회전을 다시 맞춥니다.');
});
$('record-diagnostics').addEventListener('click', () => {
  const time = performance.now();
  if (diagnosticRecorder.active) diagnosticRecorder.stop(time);
  else diagnosticRecorder.start(time, diagnosticContext());
  updateDiagnosticUi(time, true);
});
$('clear-diagnostics').addEventListener('click', () => {
  if (diagnosticRecorder.active) return;
  diagnosticRecorder.clear(); updateDiagnosticUi(performance.now(), true);
});
$('save-diagnostics').addEventListener('click',()=>{
  if(!diagnosticRecorder.frames.length && !diagnosticRecorder.renders.length)return;
  const time = performance.now(); diagnosticRecorder.stop(time, 'save');
  updateDiagnosticUi(time, true);
  const blob=new Blob([JSON.stringify(diagnosticRecorder.export(time, {version:'0.7.19',engine,timeOrigin:performance.timeOrigin}))],{type:'application/json'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');link.href=url;link.download='wrist-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('start').addEventListener('click', () => mode === 'idle' ? startCamera() : stopCamera());
$('switch').addEventListener('click', () => { facingMode = mirror ? 'environment' : 'user'; stopCamera(); startCamera(); });
$('model-file').addEventListener('change', event => importModel(event.target.files[0]));
$('datejust')?.addEventListener('click', loadDatejust);
$('sample').addEventListener('click', () => {
  if (!adjustment) return;
  modelOperation++; replaceModel(makeSampleWatch()); modelKey = 'sample'; applyFit(fitSettings.load(engine, modelKey));
  $('model-name').textContent = 'Studio 01'; $('model-caption').textContent = '준비된 모델이 없어도 바로 테스트할 수 있어요.'; $('model-status').textContent = ''; $('model-file').value = '';
});
document.addEventListener('visibilitychange', () => { if (document.hidden && mode !== 'idle') stopCamera('다른 화면으로 이동해 카메라를 껐습니다. 다시 시작하려면 카메라 시작을 눌러 주세요.'); });
window.addEventListener('pagehide', () => { stopCamera(); });

$('lock-size')?.addEventListener('change',()=>watchSizeLock.reset());
$('wrist-continue')?.addEventListener('change',()=>{wristContinuation.reset();sourceTransition=null;});
$('model10-center')?.addEventListener('change',()=>{
  wristCenter.reset();wristContinuation.reset();renderSource=null;sourceTransition=null;diagnosticEvent('center-mode',{enabled:centerEnabled()});
  if(mode==='live'||mode==='loading'){stopCamera();void startCamera();}
});
if ($('datejust') && renderer && (new URLSearchParams(location.search).get('model') === 'datejust'||$('model10-center'))) void loadDatejust();
