import {Vector3} from './vendor/three/three.module.js';
import {coverTransform} from './pose.js?v=101';

export function cameraCenter(measurement,view,mirror=false){
 const p=measurement?.pose,w=measurement?.width,h=measurement?.height;
 if(!p?.accepted||p.score<.55||![p.x,p.y,p.score,w,h].every(Number.isFinite)||w<=0||h<=0||p.x<=0||p.y<=0||p.x>=w||p.y>=h)return null;
 const f=coverTransform(view.videoWidth,view.videoHeight,view.width,view.height);
 const x=p.x/w*view.videoWidth*f.scale-f.cropX,y=p.y/h*view.videoHeight*f.scale-f.cropY;
 if(x<0||y<0||x>view.width||y>view.height)return null;
 return new Vector3((mirror?view.width-x:x)-view.width/2,view.height/2-y,0);
}
const key=(v,m)=>[v.width,v.height,v.videoWidth,v.videoHeight,m].join(':');
const copy=p=>({...p,position:p.position.clone(),rotation:p.rotation.clone()});

// A center observation supplies translation only. It never supplies a new
// orientation or depth/size. The UI must name this explicitly while active.
export class WristCenterContinuation {
 constructor(){this.reset();}
 reset(){this.anchor=null;this.pose=null;this.lastInput=-Infinity;this.lastGood=-Infinity;this.diagnostic={state:'waiting'};}
 update(handPose,measurement,view,time,now,mirror=false,allowTranslation=true){
  if(!Number.isFinite(time)||!Number.isFinite(now)||time<=this.lastInput)return;
  this.lastInput=time;
  const k=key(view,mirror);
  if(this.anchor&&(this.anchor.key!==k||time-this.lastGood>1500))this.reset();
  this.lastInput=time;
  const center=now>=time&&now-time<=220&&measurement?.time===time?cameraCenter(measurement,view,mirror):null;
  if(handPose){
   // Refresh only from a real, accepted hand pose. A flow/center-only pose
   // cannot renew the remembered 3D reference.
   const body=handPose.wristRadius/.46;
   if(center&&Math.hypot(center.x-handPose.position.x,center.y-handPose.position.y)<body*1.25){
    this.anchor={pose:copy(handPose),center:center.clone(),offset:handPose.position.clone().sub(center),body,key:k};
    this.pose=copy(handPose);this.lastGood=time;this.diagnostic={state:'armed'};
   }else {this.anchor=null;this.pose=null;this.diagnostic={state:'waiting-center'};}
   return;
  }
  if(!allowTranslation){this.pose=null;this.diagnostic={state:'hand-axes-uncertain'};return;}
  if(!this.anchor){this.diagnostic={state:center?'center-without-axes':'waiting'};return;}
  if(!center){this.diagnostic={state:'center-missing'};return;}
  const a=this.anchor,dt=Math.min(.25,Math.max(.001,(time-this.lastGood)/1000));
  const distance=center.distanceTo(a.center);
  if(distance>a.body*(.25+dt*2)){
   this.pose=null;this.anchor=null;this.diagnostic={state:'center-jump'};return;
  }
  const target=center.clone().add(a.offset);
  this.pose ||= copy(a.pose);
  this.pose.position.lerp(target,1-Math.exp(-dt*14));
  a.center.copy(center);this.lastGood=time;
  this.diagnostic={state:'center-only',orientation:'held',scale:'held',score:measurement.pose.score};
 }
 sample(time,view,mirror=false){
  if(!this.pose||!this.anchor||this.diagnostic.state!=='center-only'||time<this.lastGood||time-this.lastGood>220||key(view,mirror)!==this.anchor.key)return null;
  return this.pose;
 }
}
