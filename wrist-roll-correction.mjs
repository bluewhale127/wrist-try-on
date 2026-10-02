import {Vector3,Quaternion} from './vendor/three/three.module.js';
const Z=new Vector3(0,0,1),Y=new Vector3(0,1,0);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x);};
const halfTurn=new Quaternion().setFromAxisAngle(Y,Math.PI);
// Display-only correction around the forearm, never fed back into tracking.
// The two depth outputs are correlated estimates, not ground truth. Require
// repeated agreement and bound the correction; retain genuine palm occlusion.
export class WristRollCorrection {
 constructor(){this.reset();}
 reset(){this.last=-Infinity;this.evidence=null;this.correction=0;this.diagnostic={applied:0,trusted:false};}
 update(pose,observation,time,{orientationSign=1,quality=0,mirror=false}={}){
  if(!pose||!Number.isFinite(time)||time<=this.last)return pose;
  if(time-this.last>220)this.reset();
  const dt=Math.min(.1,Math.max(0,(time-this.last)/1000));this.last=time;
  const normal=Z.clone().applyQuaternion(pose.rotation),axis=Y.clone().applyQuaternion(pose.rotation);
  const raw=observation?.rotation?.clone(),depth=observation?.depthRotation?.clone();
  if(orientationSign===-1){raw?.multiply(halfTurn);depth?.multiply(halfTurn);}
  const a=raw&&Z.clone().applyQuaternion(raw),b=depth&&Z.clone().applyQuaternion(depth);
  const eligible=!mirror&&quality>=.75&&a&&b&&a.angleTo(b)<.35&&Math.abs(axis.z)<.7;
  let target=0,trusted=false;
  if(eligible){
   const mean=a.clone().add(b).normalize();mean.addScaledVector(axis,-mean.dot(axis));
   if(mean.length()>.7){
    mean.normalize();target=Math.atan2(axis.dot(normal.clone().cross(mean)),normal.dot(mean));
    const e=this.evidence,consistent=e&&time-e.time<=180&&Math.abs(target-e.target)<.18;
    this.evidence={time,target,start:consistent?e.start:time,count:consistent?e.count+1:1};
    trusted=this.evidence.count>=3&&time-this.evidence.start>=120&&Math.abs(target)<.6;
   }else this.evidence=null;
  }else this.evidence=null;
  const desired=trusted?clamp(target,-.25,.25):0;
  this.correction+=clamp((desired-this.correction)*(1-Math.exp(-dt*9)),-dt*.8,dt*.8);
  // Frontal back/palm views are unchanged. Taper smoothly into side views.
  const applied=this.correction*smooth((.92-Math.abs(normal.z))/.3);
  this.diagnostic={trusted,applied,target:eligible?target:null};
  return {...pose,rotation:pose.rotation.clone().multiply(new Quaternion().setFromAxisAngle(Y,applied))};
 }
}
