import {Vector3,Quaternion} from './vendor/three/three.module.js';
const X=new Vector3(1,0,0),Y=new Vector3(0,1,0),Z=new Vector3(0,0,1);
const limit=70*Math.PI/180,tau=2*Math.PI;
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
// A clenched hand is not a rigid palm plane. Do not interpret its changing
// projection as evidence that the case has crossed to the opposite surface.
// This deliberately limits fist rotation, rather than claiming full 3D pose.
export class FistSurfaceGuard {
 constructor(){this.reset();}
 reset(){this.side=1;this.relative=null;this.openEvidence=null;this.last=-Infinity;this.diagnostic={limited:false,surface:'back'};}
 update(pose,observation,time,tracking={}){
  if(!pose||!Number.isFinite(time)||time<=this.last)return pose;
  if(time-this.last>220){this.relative=null;this.openEvidence=null;}
  this.last=time;
  const candidate=!!observation?.calibration?.open&&!!observation.calibration.inFrame;
  if(candidate){const e=this.openEvidence;this.openEvidence={start:e?.start??time,count:(e?.count??0)+1};}else this.openEvidence=null;
  const open=this.openEvidence?.count>=3&&time-this.openEvidence.start>=150;
  if(open){
   if(observation.calibration.inFrame&&tracking.surfaceConfirmed){
    if(tracking.surface==='palm')this.side=-1;
    if(tracking.surface==='back')this.side=1;
   }
   this.relative=null;this.diagnostic={limited:false,surface:this.side===1?'back':'palm',reason:'open-hand'};
   return pose;
  }
  const x=X.clone().applyQuaternion(pose.rotation),z=Z.clone().applyQuaternion(pose.rotation);
  const roll=Math.atan2(-x.z,z.z),center=this.side===1?0:Math.PI;
  let relative=wrap(roll-center);
  if(this.relative!==null){while(relative-this.relative>Math.PI)relative-=tau;while(relative-this.relative< -Math.PI)relative+=tau;}
  this.relative=relative;
  const bounded=Math.max(-limit,Math.min(limit,relative)),delta=bounded-relative;
  this.diagnostic={limited:Math.abs(delta)>.001,surface:this.side===1?'back':'palm',reason:'ambiguous-fist',correction:delta};
  return Math.abs(delta)<1e-8?pose:{...pose,rotation:pose.rotation.clone().multiply(new Quaternion().setFromAxisAngle(Y,delta))};
 }
}
