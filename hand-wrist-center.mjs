import {Vector3} from './vendor/three/three.module.js';
import {coverTransform} from './pose.js?v=712';
import {wristDimensions} from './wrist-rig.js?v=719';

// C supervises the projected wearing surface, not MediaPipe landmark0 or the
// internal wrist cylinder axis. Keep inferred depth, rotation, and size intact.
export function substituteWristCenter(pose,measurement,view,settings,mirror=false){
 const keep=reason=>({pose,used:false,reason});
 if(!pose)return keep('no-hand-pose');
 const p=measurement?.pose,w=measurement?.width,h=measurement?.height;
 if(!p?.accepted||![p.x,p.y,p.score,w,h].every(Number.isFinite)||w<=0||h<=0||p.score<.4||p.score>1||p.x<=0||p.y<=0||p.x>=w||p.y>=h)return keep('invalid-center');
 if(![view.width,view.height,view.videoWidth,view.videoHeight].every(x=>Number.isFinite(x)&&x>0))return keep('invalid-view');
 const fit=coverTransform(view.videoWidth,view.videoHeight,view.width,view.height);
 const screenX=p.x/w*view.videoWidth*fit.scale-fit.cropX;
 const screenY=p.y/h*view.videoHeight*fit.scale-fit.cropY;
 const c=new Vector3((mirror?view.width-screenX:screenX)-view.width/2,view.height/2-screenY,0);
 if(Math.abs(c.x)>view.width/2||Math.abs(c.y)>view.height/2)return keep('outside-display');
 const dimensions=wristDimensions(pose.wristRadius/(.65*.46),settings['wrist-width'],settings['wrist-depth']);
 const surfaceOffset=new Vector3(0,0,dimensions.radiusZ).applyQuaternion(pose.rotation);
 const manual=new Vector3();
 if(pose.imagePalm?.length===5){
  for(const point of pose.imagePalm.slice(1))manual.add(point);
  manual.multiplyScalar(.25).sub(pose.imagePalm[0]).multiplyScalar(-(settings.offset-.5));
 }
 const expected=pose.position.clone().add(surfaceOffset).sub(manual);
 const distance=Math.hypot(c.x-expected.x,c.y-expected.y);
 // Associate with the selected hand; another hand/background peak cannot move it freely.
 if(distance>Math.max(24,pose.wristRadius/.46*1.25))return {...keep('hand-disagreement'),distance};
 const position=pose.position.clone();position.x=c.x+manual.x-surfaceOffset.x;position.y=c.y+manual.y-surfaceOffset.y;
 return {pose:{...pose,position},used:true,reason:'model-center',distance,center:[c.x,c.y],before:pose.position.toArray(),after:position.toArray()};
}

export class HandWristCenter {
 constructor(){this.reset();}
 reset(){this.lastTime=-Infinity;this.correction=null;this.diagnostic={used:false,reason:'waiting'};}
 update(pose,measurement,view,settings,time,now,mirror=false){
  if(!Number.isFinite(time)||!Number.isFinite(now)||time<=this.lastTime||now<time)return false;
  this.lastTime=time;
  if(now-time>220||measurement?.time!==time){this.correction=null;this.diagnostic={used:false,reason:'stale-or-unmatched'};return false;}
  const result=substituteWristCenter(pose,measurement,view,settings,mirror);this.diagnostic={...result,pose:undefined};
  this.correction=result.used?{delta:result.pose.position.clone().sub(pose.position),time,view:[view.width,view.height,view.videoWidth,view.videoHeight,mirror].join(':')}:null;
  return result.used;
 }
 apply(pose,time,view,mirror=false){
  const c=this.correction;
  if(!pose||!c||time<c.time||time-c.time>140||c.view!==[view.width,view.height,view.videoWidth,view.videoHeight,mirror].join(':'))return pose;
  return {...pose,position:pose.position.clone().add(c.delta)};
 }
}
