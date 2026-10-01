import * as THREE from './vendor/three/three.module.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {HandDetector} from './hand-detector.js?v=75';
import {HandTarget} from './hand-target.js?v=73';
import {RearPalmAxis} from './rear-axis.js?v=79';
import {estimateWristPose,WristPoseTracker,watchRotationDegrees} from './pose.js?v=712';
import {calibrationPrompt} from './initial-calibration.js?v=78';
import {WristRig,wristDimensions} from './wrist-rig.js?v=719';
import {normalizeImportedWatch,inspectGLB} from './watch.js?v=716';
import {frameLabel,wristCrop,CaptureGate,CAPTURE_VERSION,TEACHER_FIT} from './teacher-capture.mjs';
import {openTeacherStore,sessionArchive} from './teacher-store.mjs';
const $=id=>document.getElementById(id),video=$('video'),stage=$('stage');
const capture=document.createElement('canvas'),cropCanvas=document.createElement('canvas'),captureCtx=capture.getContext('2d',{alpha:false});
cropCanvas.width=cropCanvas.height=224;const cropCtx=cropCanvas.getContext('2d',{alpha:false}),marks=$('marks'),ctx=marks.getContext('2d');
const tracker=new WristPoseTracker(),target=new HandTarget(),gate=new CaptureGate(),detector=new HandDetector();
const rearAxis=new RearPalmAxis();let displayPose=null;
let store,stream,session,ready=false,opening=false,epoch=0,task=null,lastFrame=-1,lastSent=-Infinity,lastPoseTime=-Infinity,lastLabel=null,lastReason='idle',savedTime=-Infinity,calibrationId=0;
let renderer,scene,camera,rig,model,exporting=false,downloadUrl=null,view={width:1,height:1,videoWidth:1,videoHeight:1};
let latestDiagnostic={},rejected={},inferMs=0;
const status=text=>{$('status').textContent=text;};
const jpeg=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('이미지 저장 변환 실패')),'image/jpeg',.88));
function buttons(){
  $('start').disabled=!ready||opening||!!stream||!!task||exporting;$('front').disabled=opening||!!stream||!!task||exporting;
  $('stop').disabled=!stream&&!opening;$('recalibrate').disabled=!stream||!!task;
  $('export').disabled=!$('sessions').value||!!stream||opening||!!task||exporting;
  $('delete').disabled=$('export').disabled;
}
function counts(){if(session)$('counts').textContent=`저장 ${session.count}장 · 손목 부분 ${session.crops}장 · ${(session.bytes/1048576).toFixed(1)}MB`;}
async function refreshSessions(prefer=$('sessions').value){
  const rows=await store.sessions();$('sessions').replaceChildren();
  if(!rows.length){const o=new Option('저장된 촬영 없음','');$('sessions').add(o);}
  for(const s of rows)$('sessions').add(new Option(`${new Date(s.createdAt).toLocaleString('ko-KR')} · ${s.count}장 · ${(s.bytes/1048576).toFixed(1)}MB`,s.id));
  if(rows.some(s=>s.id===prefer))$('sessions').value=prefer;buttons();
}
$('sessions').onchange=buttons;
function reset(){tracker.reset();target.reset();rearAxis.reset();gate.reset();displayPose=null;lastLabel=null;lastPoseTime=-Infinity;lastFrame=-1;calibrationId++;if(rig)rig.visible=false;}
function halt(){epoch++;opening=false;stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause();video.srcObject=null;reset();buttons();}
async function end(){halt();if(task)await task;await refreshSessions(session?.id);status('수집을 끝냈어요. ZIP을 내보내 주세요.');}
$('stop').onclick=()=>void end().catch(showError);
$('recalibrate').onclick=()=>{reset();status('손등과 손가락 전체를 보여 주세요. 새 기준을 맞추고 있어요.');};
function showError(e){$('error').textContent=e.message||String(e);}
async function start(){
  if(!ready||opening||stream||task||exporting)return;
  reset();opening=true;const token=++epoch;buttons();$('error').textContent='';status('카메라를 열고 있어요.');
  try{
    const facing=$('front').checked?'user':'environment';
    const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}});
    if(token!==epoch){next.getTracks().forEach(t=>t.stop());return;}
    stream=next;video.srcObject=stream;await video.play();if(token!==epoch)return;
    const actualFacing=stream.getVideoTracks()[0].getSettings().facingMode||facing;
    stage.classList.toggle('mirror',actualFacing==='user');
    const created=await store.create({facing:actualFacing,sourceResolution:[video.videoWidth,video.videoHeight],teacher:'legacy-hand-0.7.19-core',
      captureVersion:CAPTURE_VERSION,displayMirrored:actualFacing==='user',storedImagesMirrored:false,
      rearPalmAxis:actualFacing!=='user',opticalFlow:false,settings:TEACHER_FIT,studentTrainingRun:false,model:'datejust-ar.glb'});
    if(token!==epoch)return;session=created;rejected={};opening=false;counts();await refreshSessions(session.id);status('손등과 손가락 전체를 2초 정도 가만히 보여 주세요.');
    // This is only a request to reduce eviction risk; a ZIP backup is still needed.
    navigator.storage?.persist?.().catch(()=>{});
  }catch(e){if(token===epoch){halt();showError(e);status('카메라 또는 저장소를 열지 못했어요.');}}
  buttons();
}
$('start').onclick=()=>void start();
const prompts={calibration:'처음 손등과 손가락 전체를 가만히 보여 주세요.',tracking:'손 추적을 다시 확인하고 있어요. 지금은 저장하지 않아요.',hand:'손목과 엄지·손가락 밑부분을 화면 안에 넣어 주세요.',motion:'조금 더 천천히 움직여 주세요.',settling:'자세가 안정되는지 확인하고 있어요.',uncertain:'방향을 확인하고 있어요. 손등을 잠깐 보여 주세요.',latency:'분석이 늦어졌어요. 손을 잠깐 멈춰 주세요.',outside:'손목을 화면 안쪽으로 옮겨 주세요.'};
async function processFrame(token){
  try{
    // Freeze one source frame before inference; never label a later live video frame.
    const time=performance.now(),ratio=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight));
    const width=Math.round(video.videoWidth*ratio),height=Math.round(video.videoHeight*ratio);
    if(capture.width!==width||capture.height!==height){capture.width=width;capture.height=height;reset();}
    captureCtx.drawImage(video,0,0,width,height);lastFrame=video.currentTime;lastSent=time;
    const mediaTime=video.currentTime;
    const packet=await detector.detect(capture,time);if(token!==epoch)return;
    inferMs=performance.now()-time;view.videoWidth=width;view.videoHeight=height;
    const rawView={width,height,videoWidth:width,videoHeight:height};
    const chosen=target.select(packet.result,rawView,time,{allowRelocation:true});
    const landmarks=chosen===null?null:packet.result.landmarks[chosen],world=chosen===null?null:packet.result.worldLandmarks?.[chosen];
    const raw=estimateWristPose(landmarks,rawView,{mirror:false,offset:.5,scale:1,worldLandmarks:world});
    const accepted=tracker.update(raw,time),calibrated=!!tracker.orientationSign;
    displayPose=accepted&&calibrated&&session.facing!=='user'?rearAxis.update(tracker.pose,raw,tracker.template,time):tracker.pose;
    if(!accepted)rearAxis.interrupt();
    const result=frameLabel({pose:displayPose,basePose:tracker.pose,rearAxis:session.facing!=='user'?rearAxis.diagnostics:null,raw,selectedRotation:tracker.previousRotation,watchSign:tracker.watchOrientationSign,
      diagnostic:tracker.diagnostics,calibrated,accepted,time,latency:inferMs,width,height,landmarks});
    const candidate=gate.consider(result,time);lastReason=candidate.reason||'saved';
    latestDiagnostic={calibrated,accepted,reason:lastReason,backend:detector.backend,latencyMs:Math.round(inferMs),tracking:tracker.diagnostics};
    if(accepted&&calibrated){lastPoseTime=time;lastLabel=result.label||null;}else lastLabel=null;
    if(!candidate.label){
      if(candidate.reason!=='cadence')rejected[candidate.reason]=(rejected[candidate.reason]||0)+1;
      status(!calibrated?calibrationPrompt(tracker.diagnostics):candidate.reason==='cadence'?'자동 수집 중 · 천천히 움직여 주세요.':prompts[candidate.reason]||'추적 확인 중');return;
    }
    const label={...candidate.label,calibrationId,capturedAt:new Date(performance.timeOrigin+time).toISOString(),mediaTimeSeconds:mediaTime,
      teacherLandmarks:landmarks,teacherWorldLandmarks:world||null,backend:detector.backend,rejectedBeforeFrame:{...rejected}};
    label.crop=wristCrop(label,landmarks);
    const image=await jpeg(capture);let cropImage=null;
    if(label.crop){const c=label.crop;cropCtx.drawImage(capture,c.x,c.y,c.width,c.height,0,0,224,224);cropImage=await jpeg(cropCanvas);}
    if(token!==epoch)return;
    session=await store.save(session.id,{label,image,cropImage});counts();savedTime=time;
    status(`자동 저장 ${session.count}장 · 천천히 손목을 돌려 주세요.`);
    if(session.count>=300){halt();await refreshSessions(session.id);status('300장을 저장했어요. ZIP을 내보내 주세요.');}
  }catch(e){if(token===epoch){halt();showError(e);status('수집을 멈췄어요. 이미 저장된 기록은 내보낼 수 있어요.');await refreshSessions(session?.id);}}
}
function point(x,y){const s=Math.min(stage.clientWidth/view.videoWidth,stage.clientHeight/view.videoHeight);return [stage.clientWidth/2+(x-view.videoWidth/2)*s*(stage.classList.contains('mirror')?-1:1),stage.clientHeight/2+(y-view.videoHeight/2)*s];}
function drawAxes(label){
  if(!label)return;
  const [x,y]=label.center2d,start=point(x,y),length=label.widthPixels*.85;
  for(const [key,text,color] of [['back','뒤','#ffd183'],['six','6','#ff9ac0'],['front','앞','#7dd9ff'],['twelve','12','#a1f5b4']]){
    const axis=label.axes[key],end=point(x+axis[0]*length,y-axis[1]*length);
    ctx.strokeStyle=ctx.fillStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(...start);ctx.lineTo(...end);ctx.stroke();ctx.beginPath();ctx.arc(...end,3,0,Math.PI*2);ctx.fill();ctx.font='bold 14px system-ui';ctx.fillText(text,end[0]+5,end[1]-5);
  }
}
function render(now){
  if(stream&&!opening&&!task&&!document.hidden&&video.readyState>=2&&video.currentTime!==lastFrame&&now-lastSent>=65){
    task=processFrame(epoch).finally(()=>{task=null;buttons();});buttons();
  }
  const w=stage.clientWidth,h=stage.clientHeight;
  if(marks.width!==w||marks.height!==h){marks.width=w;marks.height=h;renderer.setSize(w,h,false);}
  const scale=Math.min(w/view.videoWidth,h/view.videoHeight);
  camera.left=-w/(2*scale);camera.right=w/(2*scale);camera.top=h/(2*scale);camera.bottom=-h/(2*scale);camera.updateProjectionMatrix();
  const p=displayPose,visible=stream&&tracker.sample(now)&&p&&tracker.orientationSign&&now-lastPoseTime<=220;
  rig.visible=!!visible&&$('show-watch').checked;
  if(visible){rig.position.copy(p.position);rig.quaternion.copy(p.rotation);rig.caseMount.rotation.set(0,0,THREE.MathUtils.degToRad(watchRotationDegrees(90,tracker.watchOrientationSign)));
    rig.fit({...wristDimensions(p.wristRadius/(.65*.46),TEACHER_FIT['wrist-width'],TEACHER_FIT['wrist-depth']),caseSize:p.size,height:0,sample:false});}
  ctx.clearRect(0,0,w,h);if(visible)drawAxes(lastLabel);renderer.render(scene,camera);
  $('diagnostic').textContent=JSON.stringify({version:CAPTURE_VERSION,ready,modelLoaded:!!model,session:session?.id||null,saved:session?.count||0,lastSaveAgeMs:Number.isFinite(savedTime)?Math.round(now-savedTime):null,...latestDiagnostic,rejected},null,2);
}
$('export').onclick=async()=>{
  if(exporting||stream||task)return;const id=$('sessions').value;if(!id)return;
  exporting=true;buttons();$('archive-status').textContent='ZIP을 만들고 있어요. 화면을 닫지 말아 주세요.';
  try{
    const sessions=await store.sessions(),s=sessions.find(v=>v.id===id),records=await store.frames(id);
    if(!s||records.length!==s.count)throw Error('기록 개수를 확인하지 못했어요. 다시 시도해 주세요.');
    const blob=await sessionArchive(s,records);if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(blob);
    const a=$('download');a.href=downloadUrl;a.download=`wrist-teacher-${s.createdAt.replace(/[:.]/g,'-')}.zip`;a.hidden=false;a.click();
    $('archive-status').textContent=`${s.count}장 ZIP 준비 완료. 다운로드가 안 뜨면 아래 링크를 눌러 주세요.`;
  }catch(e){showError(e);$('archive-status').textContent='내보내기에 실패했어요. 기기의 원본 기록은 그대로 있어요.';}
  finally{exporting=false;buttons();}
};
$('delete').onclick=async()=>{
  if(stream||task||exporting)return;const id=$('sessions').value;
  if(!id||!confirm('선택한 촬영 기록을 이 브라우저에서 삭제할까요? ZIP을 먼저 보관해 주세요.'))return;
  try{await store.delete(id);if(session?.id===id)session=null;await refreshSessions();$('archive-status').textContent='선택한 기록을 삭제했어요.';}catch(e){showError(e);}
};
async function boot(){
  try{
    renderer=new THREE.WebGLRenderer({canvas:$('scene'),alpha:true,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;
    scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10000);camera.position.z=2000;
    scene.add(new THREE.HemisphereLight(0xf4f7ff,0x19212e,.5));const light=new THREE.DirectionalLight(0xffffff,1.2);light.position.set(-200,500,800);scene.add(light);
    const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment(),env=pmrem.fromScene(room,.04);scene.environment=env.texture;scene.environmentIntensity=.65;room.dispose();pmrem.dispose();
    rig=new WristRig();rig.visible=false;scene.add(rig);renderer.setAnimationLoop(render);
    store=await openTeacherStore();await refreshSessions();
    const load=async()=>{const response=await fetch('./datejust-ar.glb');if(!response.ok)throw Error('GLB HTTP '+response.status);
      const buffer=await response.arrayBuffer();inspectGLB(buffer);const draco=new DRACOLoader().setDecoderPath('./vendor/three/draco/');
      try{const gltf=await new GLTFLoader().setDRACOLoader(draco).parseAsync(buffer,'');model=normalizeImportedWatch(gltf.scene);rig.caseMount.add(model);$('model-status').textContent='Datejust GLB 준비 완료';}finally{draco.dispose();}};
    await Promise.all([detector.initialize(),load()]);ready=true;buttons();status('준비됐어요. 카메라를 켜면 보정 후 자동으로 저장해요.');
  }catch(e){showError(e);status('준비하지 못했어요. 오류 내용을 확인해 주세요.');}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(stream||opening))void end().catch(showError);});
window.addEventListener('pagehide',()=>{halt();detector.close();});
void boot();
