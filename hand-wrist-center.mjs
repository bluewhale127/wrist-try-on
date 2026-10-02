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
 reset(){this.lastTime=-Infinity;this.lastHand=-Infinity;this.binding=null;this.pending=null;this.diagnostic={used:false,reason:'waiting'};}
 update(pose,measurement,view,settings,time,now,mirror=false,tracking={}){
  if(!Number.isFinite(time)||!Number.isFinite(now)||time<=this.lastTime||now<time)return false;
  const key=[view.width,view.height,view.videoWidth,view.videoHeight,mirror].join(':');
  if(time-this.lastHand>1200||(this.binding&&this.binding.view!==key))this.reset();
  const dt=Math.max(0,Math.min(.15,(time-this.lastTime)/1000));this.lastTime=time;
  const hold=reason=>{this.pending=null;this.diagnostic={used:!!this.binding,reason:this.binding?'held-local-fit':reason,observation:reason};return false;};
  if(!pose)return hold('no-hand-pose');
  this.lastHand=time;
  if(now-time>220||measurement?.time!==time)return hold('stale-or-unmatched');
  // The annotated C on the palm/edge is not the hidden dorsal watch surface.
  // Learn a wearing offset on a confirmed broad back, then rotate that offset
  // with the existing hand frame instead of chasing C around the wrist.
  const x=new Vector3(1,0,0).applyQuaternion(pose.rotation),y=new Vector3(0,1,0).applyQuaternion(pose.rotation);
  const determinant=x.x*y.y-x.y*y.x;
  if(tracking.moving||tracking.surface!=='back'||!tracking.surfaceConfirmed||!['tracking','corrected'].includes(tracking.state)||determinant<.65)return hold('wait-for-back');
  const result=substituteWristCenter(pose,measurement,view,settings,mirror);
  if(!result.used)return hold(result.reason);
  const scale=pose.wristRadius/(.65*.46),delta=result.pose.position.clone().sub(pose.position);
  const local=new Vector3((delta.x*y.y-delta.y*y.x)/determinant/scale,(x.x*delta.y-x.y*delta.x)/determinant/scale,0);
  if(!Number.isFinite(local.length())||local.length()>.8)return hold('offset-outlier');
  const prior=this.pending,consistent=prior&&time-prior.time<=250&&local.distanceTo(prior.reference)<.10;
  this.pending={reference:consistent?prior.reference:local.clone(),time,start:consistent?prior.start:time,count:consistent?prior.count+1:1};
  if(this.pending.count<3||time-this.pending.start<180){this.diagnostic={used:!!this.binding,reason:this.binding?'held-local-fit':'confirming-fit'};return false;}
  this.binding ||= {local:new Vector3(),view:key};
  const step=local.clone().sub(this.binding.local).multiplyScalar(1-Math.exp(-dt*3));
  if(step.length()>.4*dt)step.setLength(.4*dt);
  this.binding.local.add(step);
  this.diagnostic={used:true,reason:'local-fit',local:this.binding.local.toArray(),distance:result.distance};
  return true;
 }
 apply(pose,time,view,mirror=false){
  const b=this.binding;
  if(!pose||!b||time<this.lastTime||time-this.lastHand>1200||b.view!==[view.width,view.height,view.videoWidth,view.videoHeight,mirror].join(':'))return pose;
  const delta=b.local.clone().multiplyScalar(pose.wristRadius/(.65*.46)).applyQuaternion(pose.rotation);
  // This is an offset in the existing hand frame, not a second rotation or a
  // predicted pose. The caller still owns pose expiry and rotation validity.
  return {...pose,position:pose.position.clone().add(delta)};
 }
}
