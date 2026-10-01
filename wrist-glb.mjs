import * as THREE from './vendor/three/three.module.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {normalizeImportedWatch,inspectGLB,disposeModel} from './watch.js';
import {WristRig} from './wrist-rig.js';
import {CenterObservation} from './wrist-watch-fit.mjs';
import {fitGeometry} from './wrist-fit-geometry.mjs?v=3';
import {watchPlacement} from './wrist-glb-placement.mjs?v=1';
const $=id=>document.getElementById(id),video=$('video'),photo=$('photo'),stage=$('stage');
const DEFAULTS={scale:1,roll:0,tilt:0,heading:0,dial:90,width:1,depth:1,height:0};let settings={...DEFAULTS};
let renderer,scene,camera,rig,model,modelName='',modelError=null,worker,ready=false,source='none',sourceLabel='',imageId=null;
let stream,objectURL,epoch=0,pending=null,seq=0,opening=false,facing='environment',lastFrame=-1,lastSent=-Infinity;
let result=null,photoPose=null,geometry=null,placement=null,inferenceMs=0,roundTripMs=0,lastDiagnostics=0;
const tracker=new CenterObservation(),view={width:1,height:1,videoWidth:0,videoHeight:0};
const marks=$('marks'),ctx=marks.getContext('2d');
function status(s,error=false){$('status').textContent=s;$('status').classList.toggle('error',error);}
function controls(){for(const key of Object.keys(DEFAULTS)){$(key).value=settings[key];$(`${key}-output`).textContent=['roll','tilt','heading','dial'].includes(key)?`${settings[key]}°`:`${settings[key].toFixed(2)}×`;}}
for(const key of Object.keys(DEFAULTS))$(key).oninput=()=>{settings[key]=Number($(key).value);controls();};
$('front').onclick=()=>{settings.roll=0;settings.tilt=0;controls();};
$('reset').onclick=()=>{settings={...DEFAULTS};controls();};controls();
function buttons(){for(const id of ['start','switch','media'])$(id).disabled=!ready||opening;$('stop').disabled=source==='none';$('pause').disabled=source!=='video';}
function reset(){epoch++;pending=null;tracker.reset();photoPose=null;result=null;geometry=null;lastFrame=-1;lastSent=-Infinity;if(rig)rig.visible=false;}
function stop(){
  reset();stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;source='none';imageId=null;opening=false;video.hidden=true;photo.hidden=true;$('pause').textContent='영상 일시정지';buttons();
}
$('stop').onclick=()=>{stop();status('미리보기를 멈췄어요. 카메라를 켜고 손목을 보여 주세요.');};
function reflect(){photo.classList.toggle('mirror',$('mirror').checked);video.classList.toggle('mirror',$('mirror').checked);geometry=null;}
$('mirror').onchange=reflect;
async function infer(element,still=false){
  if(!ready||pending||source==='none'||document.hidden)return;
  const width=still?element.naturalWidth:element.videoWidth,height=still?element.naturalHeight:element.videoHeight;
  if(!width||!height)return;
  const now=performance.now();if(!still&&(video.readyState<2||video.seeking||video.currentTime===lastFrame||now-lastSent<80))return;
  const request={id:++seq,epoch,time:now,still};pending=request;
  try{
    const frame=await createImageBitmap(element);
    if(request.epoch!==epoch){frame.close();return;}
    view.videoWidth=width;view.videoHeight=height;lastFrame=video.currentTime;lastSent=now;
    worker.postMessage({type:'frame',id:request.id,time:now,width,height,frame},[frame]);
  }catch(e){if(request.epoch===epoch){pending=null;status('분석 입력 오류: '+e.message,true);}}
}
async function openPhoto(url,label,id=null){
  stop();source='photo';sourceLabel=label;imageId=id;const token=epoch;opening=true;buttons();photo.hidden=false;photo.src=url;
  try{await photo.decode();if(token!==epoch)return;opening=false;buttons();reflect();status(label+' · 실제 모델로 손목 기준을 찾고 있어요.');await infer(photo,true);}
  catch(e){if(token===epoch){opening=false;buttons();status('사진을 열지 못했어요: '+e.message,true);}}
}
async function startCamera(){
  if(!ready)return;stop();opening=true;const token=epoch;buttons();status('카메라를 여는 중이에요.');
  try{
    const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}});
    if(token!==epoch){next.getTracks().forEach(t=>t.stop());return;}
    stream=next;source='camera';sourceLabel='실시간 카메라';video.hidden=false;video.srcObject=next;
    $('mirror').checked=(next.getVideoTracks()[0].getSettings().facingMode||facing)==='user';reflect();await video.play();
    if(token!==epoch)return;opening=false;buttons();status('손목 위치를 따라 시계를 표시합니다. 입체 회전은 슬라이더로 맞춰 주세요.');
  }catch(e){if(token===epoch){stop();status('카메라 연결 오류: '+e.message,true);}}
}
$('start').onclick=startCamera;$('switch').onclick=()=>{facing=facing==='environment'?'user':'environment';void startCamera();};
$('pause').onclick=()=>{if(video.paused){void video.play();$('pause').textContent='영상 일시정지';}else{video.pause();$('pause').textContent='영상 재생';}};
$('media').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;e.target.value='';
  if(file.type.startsWith('image/')){const url=URL.createObjectURL(file);await openPhoto(url,file.name);objectURL=url;return;}
  stop();source='video';sourceLabel=file.name;const token=epoch;objectURL=URL.createObjectURL(file);video.src=objectURL;video.hidden=false;video.loop=true;opening=true;buttons();
  try{await video.play();if(token!==epoch)return;opening=false;buttons();reflect();status('영상 위에 GLB를 표시하고 있어요.');}
  catch(e){if(token===epoch){stop();status('영상 재생 오류: '+e.message,true);}}
};
video.onseeking=()=>{if(source==='video'){reset();}};
video.onseeked=()=>{if(source==='video')void infer(video);};
let modelOperation=0;
async function importGLB(buffer,name){
  const token=++modelOperation;inspectGLB(buffer);
  const manager=new THREE.LoadingManager(),decoder=new URL('./vendor/three/draco/',import.meta.url).href;
  manager.setURLModifier(url=>{if(url.startsWith('blob:')||url.startsWith('data:')||url.startsWith(decoder))return url;throw Error('텍스처가 파일에 포함된 GLB를 사용해 주세요.');});
  const draco=new DRACOLoader(manager).setDecoderPath(decoder);
  try{
    const gltf=await new GLTFLoader(manager).setDRACOLoader(draco).parseAsync(buffer,'');
    if(token!==modelOperation){disposeModel(gltf.scene);return;}
    const next=normalizeImportedWatch(gltf.scene);if(model){rig.caseMount.remove(model);disposeModel(model);}
    model=next;rig.caseMount.add(model);modelName=name;modelError=null;
    let meshes=0;model.traverse(n=>{if(n.isMesh)meshes++;});model.userData.meshCount=meshes;
    $('model-status').textContent=`${name} · GLB 로드 완료`;
  }finally{draco.dispose();}
}
async function datejust(){
  $('model-status').textContent='Datejust GLB · 불러오는 중';
  try{const r=await fetch('./datejust-ar.glb');if(!r.ok)throw Error(`HTTP ${r.status}`);await importGLB(await r.arrayBuffer(),'Datejust');}
  catch(e){modelError=e.message;$('model-status').textContent='GLB 오류: '+e.message;}
}
$('datejust').onclick=datejust;$('model-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;e.target.value='';try{if(file.size>80*1024*1024)throw Error('80MB 이하 GLB를 사용해 주세요.');await importGLB(await file.arrayBuffer(),file.name);}catch(error){modelError=error.message;$('model-status').textContent='GLB 오류: '+error.message;}};
function drawPoint(p,color,label){
  const s=Math.min(view.width/view.videoWidth,view.height/view.videoHeight),x=view.width/2+(p[0]-view.videoWidth/2)*s*($('mirror').checked?-1:1),y=view.height/2+(p[1]-view.videoHeight/2)*s;
  ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.stroke();ctx.font='bold 14px sans-serif';ctx.fillText(label,x+8,y-8);
}
function render(now){
  if((source==='camera'||source==='video')&&!video.paused)void infer(video);
  if(pending&&now-pending.time>8000){pending=null;status('분석 응답이 지연됐어요. 사진을 다시 선택해 주세요.',true);}
  const moving=source==='camera'||source==='video',paused=source==='video'&&video.paused;
  const pose=source==='photo'?photoPose:paused?(result?.pose?.accepted?result.pose:null):moving?tracker.sample(now):null;
  const fresh=result&&(source==='photo'||paused||now-result.time<=250);
  geometry=fresh&&pose?fitGeometry(result.points,[pose.x,pose.y],view.videoWidth,view.videoHeight,$('mirror').checked):null;
  const useAuto=$('auto').checked&&geometry;
  placement=pose&&model?watchPlacement(pose,view,settings,useAuto||null,$('mirror').checked):null;
  rig.visible=!!placement;ctx.clearRect(0,0,marks.width,marks.height);
  if(placement){
    rig.position.copy(placement.position);rig.quaternion.copy(placement.rotation);rig.caseMount.rotation.z=placement.dialRadians;
    rig.fit({...placement.dimensions,caseSize:placement.caseSize,height:placement.height,sample:false,guide:$('guide').checked});rig.occluder.visible=$('occlusion').checked;
  }
  if($('show-marks').checked&&fresh){
    for(const [k,col] of Object.entries({A:'#72efb9',B:'#ff82b8',C:'#7acbff'}))if(result.points[k]?.accepted)drawPoint(result.points[k].center,col,k==='A'?'A · 12':k==='B'?'B · 6':'C');
    if(pose)drawPoint([pose.x,pose.y],'#ffe3a5','중심');
  }
  const trackingState=tracker.state(now);
  const waitingText=trackingState.reason==='stale'?'분석 응답이 늦어 재확인 중':trackingState.phase==='acquiring'?'손목 위치 확인 중':'손목 중심을 찾는 중';
  const fitText=useAuto?'자동 너비·평면 방향 적용 · 입체 회전은 수동':pose?'자동 기준 없음 · 수동 크기·방향 사용':waitingText;
  $('fit-status').textContent=fitText;$('heading').disabled=!!useAuto;$('dial').disabled=!!useAuto;
  $('badge').textContent=source==='none'?'카메라를 켜고 손목을 보여 주세요':placement?fitText:!model?'GLB를 불러오는 중':waitingText;
  if(now-lastDiagnostics>200){
    $('metrics').textContent=result?`중심 07 · 점수 ${result.pose?.score?.toFixed(3)??'-'} · 분석 ${Math.round(inferenceMs)}ms / 응답 ${Math.round(roundTripMs)}ms`:'';
    $('diagnostic').textContent=JSON.stringify({centerModel:'07',geometryModel:'03',inferenceMs,roundTripMs,trackingState,rawPose:result?.pose??null,ready,source,sourceLabel,imageId,modelName,modelError,meshCount:model?.userData.meshCount??0,caseAnchored:!!model?.userData.caseAnchored,visible:!!placement,automaticGeometry:!!useAuto,mirror:$('mirror').checked,pose:pose??null,points:result?.points??null,settings,caseSize:placement?.caseSize??null,heading:placement?.heading??null,dialRadians:placement?.dialRadians??null,contact:placement?[placement.target.x,placement.target.y]:null,sourceDimensions:[view.videoWidth,view.videoHeight],renderDimensions:[view.width,view.height],sourceGeometry:geometry},null,2);lastDiagnostics=now;
  }
  renderer.render(scene,camera);
}
async function boot(){
  try{
    renderer=new THREE.WebGLRenderer({canvas:$('scene'),alpha:true,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;
    scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10000);camera.position.z=2000;
    scene.add(new THREE.HemisphereLight(0xf4f7ff,0x19212e,.5));
    const key=new THREE.DirectionalLight(0xffffff,1.2);key.position.set(-200,500,800);scene.add(key);
    const fill=new THREE.DirectionalLight(0xf1f5ff,.4);fill.position.set(400,-200,500);scene.add(fill);
    const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment(),env=pmrem.fromScene(room,.04);scene.environment=env.texture;scene.environmentIntensity=.65;room.dispose();pmrem.dispose();
    rig=new WristRig();rig.visible=false;scene.add(rig);
    new ResizeObserver(()=>{view.width=stage.clientWidth;view.height=stage.clientHeight;renderer.setSize(view.width,view.height,false);camera.left=-view.width/2;camera.right=view.width/2;camera.top=view.height/2;camera.bottom=-view.height/2;camera.updateProjectionMatrix();marks.width=view.width;marks.height=view.height;}).observe(stage);
    worker=new Worker('./wrist-center/fit-worker-04.mjs?v=2',{type:'module'});
    const init=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('손목 모델 준비 시간 초과')),60000);
      worker.onerror=e=>{clearTimeout(timer);status('모델 실행 오류: '+e.message,true);reject(Error(e.message));};
      worker.onmessage=({data})=>{
        if(data.type==='ready'){clearTimeout(timer);resolve();return;}
        if(data.type==='error'){clearTimeout(timer);pending=null;status('분석 오류: '+data.message,true);reject(Error(data.message));return;}
        if(data.type!=='result'||data.id!==pending?.id)return;
        const request=pending;pending=null;if(request.epoch!==epoch)return;
        result=data;inferenceMs=data.inferenceMs;roundTripMs=performance.now()-request.time;
        if(request.still){photoPose=data.pose?.accepted?data.pose:null;status(photoPose?sourceLabel+' · 시계 크기와 회전을 조절해 보세요.':sourceLabel+' · 손목 중심을 찾지 못했어요.');}
        else tracker.update(data.pose,data.time,data.width,data.height,performance.now());
      };worker.postMessage({type:'init'});
    });
    renderer.setAnimationLoop(render);await Promise.all([init,datejust()]);ready=true;buttons();
    status('준비됐어요. 카메라를 켜고 손목을 보여 주세요.');
  }catch(e){status('준비 오류: '+e.message,true);}
}
window.addEventListener('pagehide',()=>{stop();worker?.terminate();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&source==='camera')stop();});
boot();
