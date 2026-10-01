import * as THREE from './vendor/three/three.module.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {makeSampleWatch,disposeModel,inspectGLB,normalizeImportedWatch} from './watch.js?v=716';
import {WristRig} from './wrist-rig.js?v=719';
import {DEFAULTS,LIMITS,sanitizeSettings,manualPlacement,CenterObservation} from './wrist-watch-fit.mjs?v=1';

const $=id=>document.getElementById(id),video=$('camera'),stage=$('stage');
const STORAGE='viver-wrist-center-watch-v1',observation=new CenterObservation();
let settings={...DEFAULTS};
try{settings=sanitizeSettings(JSON.parse(localStorage.getItem(STORAGE)));}catch{}
let renderer,scene,camera,rig,model,environment,worker,ready=false,bitmap=false;
let active=false,opening=false,sourceMode=null,mirror=false,facing='environment',stream,videoURL;
let generation=0,requestId=0,pending=null,capturing=false,lastSent=-Infinity,lastVideoTime=-1;
let modelOperation=0,modelName='임시 시계',lastMs=0,observations=0,placement=null;
const capture=document.createElement('canvas'),captureContext=capture.getContext('2d',{willReadFrequently:true});
const mark=$('center-mark'),markContext=mark.getContext('2d');
let view={width:1,height:1,videoWidth:0,videoHeight:0};
let fatal=false;

function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function buttons(){
  $('start').disabled=!ready||fatal||active||opening;
  $('switch').disabled=!ready||fatal||opening;
  $('stop').disabled=!active&&!opening;
  $('file').disabled=!ready||fatal||opening;
}
function updateControls(save=false){
  settings=sanitizeSettings(settings);
  for(const key of Object.keys(LIMITS)){
    $(key).value=settings[key];
    $(`${key}-output`).textContent=['heading','roll','tilt','dial'].includes(key)?`${settings[key]}°`:`${settings[key].toFixed(2)}×`;
  }
  $('occlusion').checked=settings.occlusion;$('guide').checked=settings.guide;
  if(save)try{localStorage.setItem(STORAGE,JSON.stringify(settings));$('saved').textContent='조절값을 저장했어요.';}catch{$('saved').textContent='이 브라우저에서는 조절값 저장을 사용할 수 없어요.';}
}
for(const key of Object.keys(LIMITS))$(key).addEventListener('input',()=>{settings[key]=Number($(key).value);updateControls(true);});
for(const key of ['occlusion','guide'])$(key).addEventListener('change',()=>{settings[key]=$(key).checked;updateControls(true);});
$('vertical').onclick=()=>{settings.heading=0;updateControls(true);};
$('horizontal').onclick=()=>{settings.heading=-90;updateControls(true);};
$('reset').onclick=()=>{settings={...DEFAULTS};updateControls(true);};
updateControls();

function setModel(next,name){
  if(model){rig.caseMount.remove(model);disposeModel(model);}
  model=next;modelName=name;rig.caseMount.add(model);$('model-status').textContent=`사용 중: ${name}`;
}
async function importGLB(buffer,name,operation){
  inspectGLB(buffer);
  const manager=new THREE.LoadingManager(),decoder=new URL('./vendor/three/draco/',import.meta.url).href;
  manager.setURLModifier(url=>{
    if(url.startsWith('blob:')||url.startsWith('data:')||url.startsWith(decoder))return url;
    throw new Error('파일 안에 텍스처를 포함한 GLB를 사용해 주세요.');
  });
  const draco=new DRACOLoader(manager).setDecoderPath(decoder);
  try{
    const gltf=await new GLTFLoader(manager).setDRACOLoader(draco).parseAsync(buffer,'');
    if(operation!==modelOperation){disposeModel(gltf.scene);return;}
    setModel(normalizeImportedWatch(gltf.scene),name);
  }finally{draco.dispose();}
}
async function loadDatejust(){
  const operation=++modelOperation;$('model-status').textContent='Datejust를 불러오는 중 · 약 22MB';
  try{
    const response=await fetch(new URL('./datejust-ar.glb?v=1',import.meta.url));
    if(!response.ok)throw Error(`모델 다운로드 오류 (${response.status})`);
    const buffer=await response.arrayBuffer();if(operation!==modelOperation)return;
    await importGLB(buffer,'Datejust',operation);
  }catch(error){if(operation===modelOperation)$('model-status').textContent=`${error.message} · 현재 ${modelName}를 사용해요.`;}
}
$('datejust').onclick=loadDatejust;
$('sample').onclick=()=>{++modelOperation;setModel(makeSampleWatch(),'임시 시계');};
$('model-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;const operation=++modelOperation;
  $('model-status').textContent='내 시계를 불러오는 중';
  try{if(file.size>80*1024*1024)throw Error('80MB 이하의 GLB를 사용해 주세요.');await importGLB(await file.arrayBuffer(),file.name,operation);}
  catch(error){if(operation===modelOperation)$('model-status').textContent=`${error.message} · 현재 ${modelName}를 사용해요.`;}
  event.target.value='';
};

function resetObservation(){generation++;observation.reset();lastSent=-Infinity;lastVideoTime=-1;if(rig)rig.visible=false;}
function stopSource(showMessage=true){
  resetObservation();active=false;opening=false;sourceMode=null;
  stream?.getTracks().forEach(track=>track.stop());stream=null;
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
  mirror=false;video.classList.remove('mirror');$('placeholder').hidden=false;
  $('badge').textContent=ready?'카메라를 켜고 손목을 보여 주세요':'손목 모델 준비 중';
  $('metrics').textContent='';buttons();if(showMessage)message('카메라를 켜거나 기기에 있는 영상을 선택해 주세요.');
}
function fail(text){fatal=true;ready=false;stopSource(false);worker?.terminate();clearTimeout(initTimeout);$('badge').textContent='준비 실패';message(text+' 새로고침해서 다시 시도해 주세요.',true);buttons();}
async function startCamera(){
  if(!ready||fatal)return;
  stopSource(false);const id=generation;opening=true;buttons();message('카메라를 여는 중이에요.');
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('카메라는 HTTPS 주소에서 열어 주세요.');
    const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}});
    if(id!==generation){next.getTracks().forEach(track=>track.stop());return;}
    stream=next;const actual=next.getVideoTracks()[0].getSettings().facingMode;
    mirror=(actual||facing)==='user';video.classList.toggle('mirror',mirror);
    sourceMode='camera';video.srcObject=stream;await video.play();
    if(id!==generation)return;
    active=true;opening=false;$('placeholder').hidden=true;buttons();message(mirror?'전면 카메라 · 손목을 보여 주세요.':'후면 카메라 · 손목을 보여 주세요.');
  }catch(error){if(id!==generation)return;stopSource(false);message(`카메라를 열지 못했어요: ${error.message}`,true);}
}
$('start').onclick=startCamera;
$('switch').onclick=()=>{facing=mirror||facing==='user'?'environment':'user';void startCamera();};
$('stop').onclick=()=>stopSource();
$('file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  stopSource(false);const id=generation;opening=true;buttons();
  videoURL=URL.createObjectURL(file);sourceMode='file';video.src=videoURL;video.loop=true;
  try{await video.play();if(id!==generation)return;active=true;opening=false;$('placeholder').hidden=true;message('영상의 손목 중심에 시계를 붙이고 있어요. 크기와 방향을 맞춰 주세요.');buttons();}
  catch(error){if(id===generation){stopSource(false);message(`영상을 열지 못했어요: ${error.message}`,true);}}
  event.target.value='';
};
video.addEventListener('seeking',()=>resetObservation());
// A paused, sought frame can also be checked without playing earlier hand frames.
video.addEventListener('seeked',()=>{if(active)void submitFrame();});
video.addEventListener('error',()=>{if(active||opening){stopSource(false);message('이 영상을 재생할 수 없어요. 다른 MP4 영상을 선택해 주세요.',true);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(sourceMode==='camera'||opening))stopSource();});
window.addEventListener('pagehide',()=>{stopSource(false);worker?.terminate();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});

async function submitFrame(){
  if(!ready||!active||fatal||pending||capturing||video.readyState<2||video.seeking||document.hidden)return;
  const now=performance.now(),frameTime=video.currentTime;
  if(now-lastSent<60||frameTime===lastVideoTime)return;
  const width=video.videoWidth,height=video.videoHeight;if(!width||!height)return;
  const id=++requestId,epoch=generation;capturing=true;
  try{
    let frame,rgba;
    if(bitmap&&typeof createImageBitmap==='function'){
      frame=await createImageBitmap(video);
      if(epoch!==generation||!active){frame.close();return;}
    }else{
      if(capture.width!==width||capture.height!==height){capture.width=width;capture.height=height;}
      captureContext.drawImage(video,0,0,width,height);rgba=captureContext.getImageData(0,0,width,height).data;
    }
    if(epoch!==generation||!active){frame?.close();return;}
    pending={id,epoch,time:now};lastSent=now;lastVideoTime=frameTime;
    try{worker.postMessage({type:'frame',id,time:now,frameTime,width,height,frame,rgba},frame?[frame]:[rgba.buffer]);}
    catch(error){frame?.close();pending=null;throw error;}
  }catch(error){if(epoch===generation)fail(`영상 처리 중 오류가 발생했어요: ${error.message}`);}
  finally{capturing=false;}
}
function onVideoFrame(){void submitFrame();video.requestVideoFrameCallback(onVideoFrame);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(onVideoFrame);

const initTimeout=setTimeout(()=>fail('손목 모델을 불러오는 데 시간이 너무 오래 걸렸어요.'),60000);
function boot(){
  try{
    renderer=new THREE.WebGLRenderer({canvas:$('scene'),alpha:true,antialias:true,powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;
    scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10000);camera.position.z=2000;
    scene.add(new THREE.HemisphereLight(0xf4f7ff,0x19212e,.5));
    const key=new THREE.DirectionalLight(0xffffff,1.2);key.position.set(-200,500,800);scene.add(key);
    const fill=new THREE.DirectionalLight(0xf1f5ff,.4);fill.position.set(400,-200,500);scene.add(fill);
    const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;scene.environmentIntensity=.65;room.dispose();pmrem.dispose();
    rig=new WristRig();rig.visible=false;scene.add(rig);setModel(makeSampleWatch(),'임시 시계');void loadDatejust();
    new ResizeObserver(()=>{
      const width=stage.clientWidth,height=stage.clientHeight;view.width=width;view.height=height;
      renderer.setSize(width,height,false);camera.left=-width/2;camera.right=width/2;camera.top=height/2;camera.bottom=-height/2;camera.updateProjectionMatrix();
      mark.width=width;mark.height=height;
    }).observe(stage);
    worker=new Worker(new URL('./wrist-center/center-worker.mjs?v=1',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
      if(fatal)return;
      if(data.type==='ready'){clearTimeout(initTimeout);ready=true;bitmap=data.bitmap;buttons();$('badge').textContent='카메라를 켜고 손목을 보여 주세요';message('준비됐어요. 손목만 보여도 시작할 수 있어요.');return;}
      if(data.type==='error'){fail(`손목 모델 오류: ${data.message}`);return;}
      if(data.type!=='result'||data.id!==pending?.id)return;
      const request=pending;pending=null;
      if(request.epoch!==generation||!active)return;
      lastMs=data.inferenceMs;observations++;
      observation.update(data.pose,data.time,data.width,data.height,performance.now());
    };
    worker.onerror=event=>fail(`손목 모델 실행 오류: ${event.message}`);
    worker.postMessage({type:'init'});
    renderer.setAnimationLoop(render);
  }catch(error){fail(`화면을 준비하지 못했어요: ${error.message}`);}
}
function render(now){
  if(pending&&now-pending.time>8000){pending=null;fail('손목 분석이 멈췄어요.');}
  if(!video.requestVideoFrameCallback)void submitFrame();
  const pose=active?observation.sample(now):null;
  view.videoWidth=video.videoWidth;view.videoHeight=video.videoHeight;
  placement=pose?manualPlacement(pose,view,settings,mirror):null;rig.visible=!!placement;
  markContext.clearRect(0,0,mark.width,mark.height);
  if(placement){
    rig.position.copy(placement.position);rig.quaternion.copy(placement.rotation);rig.caseMount.rotation.z=placement.dialRadians;
    rig.fit({...placement.dimensions,caseSize:placement.caseSize,height:placement.height,sample:!!model.userData.sample,guide:settings.guide});rig.occluder.visible=settings.occlusion;
    if($('show-center').checked){const x=placement.target.x+view.width/2,y=view.height/2-placement.target.y;markContext.strokeStyle='#fff38f';markContext.lineWidth=2;markContext.beginPath();markContext.arc(x,y,6,0,Math.PI*2);markContext.moveTo(x-12,y);markContext.lineTo(x+12,y);markContext.moveTo(x,y-12);markContext.lineTo(x,y+12);markContext.stroke();}
  }
  if(active){
    const text=placement?'손목 중심 추적 중 · 크기·방향 수동':'손목을 찾고 있어요';if($('badge').textContent!==text)$('badge').textContent=text;
    $('metrics').textContent=lastMs?`분석 ${Math.round(lastMs)}ms · ${placement?`점수 ${pose.score.toFixed(2)}`:'손목이 다시 보이면 자동으로 붙어요'}`:'';
  }
  renderer.render(scene,camera);
}
// Read-only snapshots for local regression tests; no camera images are exposed.
Object.defineProperty(window,'__wristWatch',{get:()=>({ready,active,opening,sourceMode,mirror,fatal,visible:!!rig?.visible,pose:observation.sample(performance.now()),settings:{...settings},modelName,observations,lastMs,generation,pending:!!pending,caseSize:placement?.caseSize,projectedCenter:placement?[placement.target.x+view.width/2,view.height/2-placement.target.y]:null})});
boot();
