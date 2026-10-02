import {CenterObservation} from './wrist-center/recovery-observation-01.mjs';
const $=id=>document.getElementById(id);
const requestedModel=new URLSearchParams(location.search).get('model');
if([...$('model').options].some(option=>option.value===requestedModel))$('model').value=requestedModel;
const video=$('video'),overlay=$('overlay'),ctx=overlay.getContext('2d'),tracker=new CenterObservation();
let worker=null,stream=null,generation=0,running=false,ready=false,busy=false,watchdog=null,facing='environment';
let requestId=0,lastVideoTime=-1,lastResult=null,frames=0,attached=0,logs=[];
const record=row=>{logs.push({...row,wallTime:new Date().toISOString()});if(logs.length>3000)logs.splice(0,logs.length-3000);};
const status=text=>{$('status').textContent=text;};
function clearTracking(){tracker.reset();lastResult=null;lastVideoTime=-1;ctx.clearRect(0,0,overlay.width,overlay.height);}
function stop(message='카메라가 꺼졌습니다.'){
 generation++;running=false;ready=false;busy=false;clearTimeout(watchdog);worker?.terminate();worker=null;
 stream?.getTracks().forEach(track=>track.stop());stream=null;video.srcObject=null;clearTracking();
 $('start').textContent='카메라 켜기';status(message);record({event:'stop'});
}
function fail(message){stop(message);}
async function start(){
 stop('카메라와 모델을 준비하고 있습니다…');running=true;const epoch=generation;
 $('start').textContent='카메라 끄기';frames=0;attached=0;
 record({event:'start',model:$('model').value,facing});
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('HTTPS 주소에서 Chrome으로 열어 주세요.');
  const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720}}});
  if(epoch!==generation){acquired.getTracks().forEach(track=>track.stop());return;}
  stream=acquired;
  const actual=stream.getVideoTracks()[0].getSettings().facingMode;
  $('stage').classList.toggle('mirror',(actual||facing)==='user');
  video.srcObject=stream;await video.play();if(epoch!==generation)return;
  worker=new Worker(new URL('./wrist-center/center-live-worker-01.mjs?v=3',import.meta.url),{type:'module'});
  watchdog=setTimeout(()=>{if(epoch===generation)fail('모델 준비 시간이 초과됐습니다. 카메라 켜기로 다시 시도해 주세요.');},45000);
  worker.onerror=()=>{if(epoch===generation)fail('모델 실행 오류입니다. 새로고침 후 다시 시도해 주세요.');};
  worker.onmessage=({data})=>{
   if(epoch!==generation)return;
   clearTimeout(watchdog);
   if(data.type==='error'){fail('추적 오류: '+data.message);return;}
   if(data.type==='ready'){ready=true;status('손목을 화면에 보여 주세요.');return;}
   if(data.type!=='result'||data.id!==requestId)return;
   busy=false;lastResult=data;frames++;
   const now=performance.now();tracker.update(data.pose,data.time,data.width,data.height,now);
   const state=tracker.state(now);if(state.visible)attached++;
   record({event:'frame',model:$('model').value,facing,frame:frames,time:data.time,latencyMs:now-data.time,inferenceMs:data.inferenceMs,width:data.width,height:data.height,pose:data.pose,viewCount:data.viewCount,state});
  };
  worker.postMessage({type:'init',model:$('model').value});
 }catch(error){if(epoch===generation)fail(error.name==='NotAllowedError'?'카메라 권한을 허용한 후 다시 눌러 주세요.':error.message);}
}
async function sendFrame(){
 if(!running||!ready||busy||video.readyState<2||video.currentTime===lastVideoTime)return;
 busy=true;const epoch=generation;lastVideoTime=video.currentTime;
 const scale=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight));
 const width=Math.round(video.videoWidth*scale),height=Math.round(video.videoHeight*scale),time=performance.now();
 try{
  const frame=await createImageBitmap(video,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
  if(epoch!==generation){frame.close();return;}
  worker.postMessage({type:'frame',id:++requestId,time,width,height,frame},[frame]);
  watchdog=setTimeout(()=>{if(epoch===generation)fail('추적 응답이 멈췄습니다. 카메라 켜기로 다시 시작해 주세요.');},10000);
 }catch(error){if(epoch===generation)fail('영상 처리 오류: '+error.message);}
}
function draw(){
 const now=performance.now();
 if(lastResult){
  const {width,height}=lastResult;
  if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
  ctx.clearRect(0,0,width,height);
  const dot=(p,color,r)=>{ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(p.x-12,p.y);ctx.lineTo(p.x+12,p.y);ctx.moveTo(p.x,p.y-12);ctx.lineTo(p.x,p.y+12);ctx.stroke();};
  const pose=tracker.sample(now),state=tracker.state(now);
  if($('raw').checked&&now-lastResult.time<220&&Number.isFinite(lastResult.pose?.x))dot(lastResult.pose,'#ffb55b',5);
  if(pose)dot(pose,'#53ffd0',10);
  status(state.visible?'중심 추적 중':state.phase==='acquiring'?'중심 위치 확인 중…':'손목을 찾고 있습니다…');
  $('stats').textContent=`${$('model').selectedOptions[0].text} · ${lastResult.inferenceMs.toFixed(0)} ms · ${lastResult.viewCount}방향 · 점수 ${(lastResult.pose?.score??0).toFixed(2)} · ${state.reason}`;
 }
 sendFrame();requestAnimationFrame(draw);
}
$('start').onclick=()=>running?stop():start();
$('model').onchange=()=>{clearTracking();record({event:'model',model:$('model').value});if(running)start();};
$('switch').onclick=()=>{facing=facing==='environment'?'user':'environment';clearTracking();if(running)start();else{$('stats').textContent=facing==='user'?'전면 카메라 선택':'후면 카메라 선택';}};
$('reset').onclick=()=>{if(running)start();else clearTracking();};
$('save').onclick=()=>{
 const data={version:'center-live-03',model:$('model').value,exportedAt:new Date().toISOString(),imagesIncluded:false,frames,attached,logs};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`wrist-center-live-${new Date().toISOString().replaceAll(':','-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stop('화면이 숨겨져 카메라를 껐습니다. 다시 켜 주세요.');});
addEventListener('pagehide',()=>stop());
requestAnimationFrame(draw);
