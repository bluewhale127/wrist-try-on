import { Quaternion, Vector3 } from './vendor/three/three.module.js';
import { coverTransform } from './pose.js?v=74';
import { fitPalmProjection } from './palm-projection.js?v=5';
import { pyramid, wristFeatures, trackWrist, transformPoint } from './wrist-flow.js?v=75';

const clonePose=p=>({...p,position:p.position.clone(),rotation:p.rotation.clone()});
const PALM=[0,5,9,13,17], Z=new Vector3(0,0,1);
// These gates apply only to the rear camera. Keep the established selfie solver.
export function rearObservation(next, landmarks, tracker, visualPose=null) {
  if(!next)return {allowed:false,reason:'no-hand'};
  if(!tracker.template)return {allowed:true,reason:'calibrating'};
  if(PALM.filter(i=>{const p=landmarks?.[i];return !p||p.x<.01||p.x>.99||p.y<.01||p.y>.99;}).length>=2)return {allowed:false,reason:'cropped-palm'};
  const projection=fitPalmProjection(tracker.template,next.imagePalm);
  if(!projection)return {allowed:false,reason:'geometry'};
  const middle=next.imagePalm.slice(1).reduce((s,p)=>s.add(p),new Vector3()).multiplyScalar(.25);
  const lengthRatio=middle.distanceTo(next.imagePalm[0])/projection.scale;
  // With the hand pointing into the lens, tiny landmark errors move an
  // extrapolated wrist far away. Do not learn that unreliable new frame.
  if(lengthRatio<.42)return {allowed:false,reason:'foreshortened',lengthRatio};
  if(projection.residual>.075)return {allowed:false,reason:'perspective',lengthRatio};
  if(visualPose){
    const distance=visualPose.position.distanceTo(next.position)/Math.max(visualPose.wristRadius/.46,1);
    if(distance>.65)return {allowed:false,reason:'image-disagreement',lengthRatio};
  }
  return {allowed:true,reason:'hand',lengthRatio};
}

// One second maximum from the last accepted hand observation, not from the
// latest flow frame. Any bad flow frame ends the bridge; no blind hold/reseed.
export class RearWristAssist {
  constructor(){this.reset();}
  reset(){
    this.previous=null;this.current=null;this.points=[];this.pose=null;this.viewKey='';
    this.lastFrame=-Infinity;this.lastHand=-Infinity;this.lastDisplay=-Infinity;
    this.baseRadius=0;this.turn=0;this.steps=0;this.bridge=false;this.rejoin=null;
    this.diagnostics={state:'waiting',reason:'no-anchor'};
  }
  advance(frame,view,time){
    this.motion=null;
    if(!frame||!frame.data||!Number.isFinite(time)){this.reset();return null;}
    const key=[frame.width,frame.height,view.width,view.height,view.videoWidth,view.videoHeight].join(',');
    if(key!==this.viewKey||time<=this.lastFrame||time-this.lastFrame>180)this.reset();
    this.viewKey=key;this.view=view;
    const current=pyramid(frame),dt=time-this.lastFrame;
    if(this.previous&&this.pose&&this.points.length>=8&&dt>0&&dt<=180){
      this.motion=trackWrist(this.previous,current,this.points);
      if(this.motion){
        const m=this.motion, map=this.mapping(frame,view);
        const p={x:(this.pose.position.x+view.width/2+map.cropX)/map.scale,y:(view.height/2-this.pose.position.y+map.cropY)/map.scale};
        const q=transformPoint(m,p), travel=Math.hypot(q.x-p.x,q.y-p.y);
        if(travel>Math.max(frame.width,frame.height)*.2||!Number.isFinite(travel))this.motion=null;
        else{
          this.pose.position.set(q.x*map.scale-map.cropX-view.width/2,view.height/2-(q.y*map.scale-map.cropY),0);
          this.pose.size*=m.scale;this.pose.wristRadius*=m.scale;
          this.pose.rotation.premultiply(new Quaternion().setFromAxisAngle(Z,-m.angle));
          this.points=m.points;this.steps++;this.turn+=m.angle;this.lastDisplay=time;
        }
      }
      if(!this.motion){this.pose=null;this.points=[];this.steps=0;this.diagnostics={state:'lost',reason:'flow-rejected'};}
    }
    this.previous=current;this.current=frame;this.lastFrame=time;
    if(this.pose&&(time-this.lastHand>1000||Math.abs(this.turn)>.45||this.pose.wristRadius/this.baseRadius>1.8||this.pose.wristRadius/this.baseRadius<.6)){
      this.pose=null;this.points=[];this.diagnostics={state:'lost',reason:'bridge-limit'};
    }
    return this.motion&&this.steps>=2&&this.pose?this.pose:null;
  }
  mapping(frame,view){return coverTransform(frame.width,frame.height,view.width,view.height);}
  correct(pose,time){
    if(!pose||!this.current||time!==this.lastFrame)return;
    if(this.bridge&&this.pose&&!this.rejoin)this.rejoin={pose:clonePose(this.pose),time};
    this.pose=clonePose(pose);
    if(this.rejoin){
      const amount=Math.min(1,(time-this.rejoin.time)/180);
      this.pose.position.lerpVectors(this.rejoin.pose.position,pose.position,amount);
      this.pose.rotation.copy(this.rejoin.pose.rotation).slerp(pose.rotation,amount);
      this.pose.size=this.rejoin.pose.size+(pose.size-this.rejoin.pose.size)*amount;
      this.pose.wristRadius=this.rejoin.pose.wristRadius+(pose.wristRadius-this.rejoin.pose.wristRadius)*amount;
      if(amount===1)this.rejoin=null;
    }
    const f=this.current,v=this.view,map=this.mapping(f,v);
    const x=(this.pose.position.x+v.width/2+map.cropX)/map.scale,y=(v.height/2-this.pose.position.y+map.cropY)/map.scale;
    const body=this.pose.wristRadius/.46/map.scale;
    // Central wrist patch, inside its estimated width; never track background
    // across the entire image. A small/textureless patch cannot arm a bridge.
    const across=new Vector3(1,0,0).applyQuaternion(this.pose.rotation).multiplyScalar(body*.48);
    const along=new Vector3(0,1,0).applyQuaternion(this.pose.rotation).multiplyScalar(body*.65);
    const basis=[across.x,-across.y,along.x,-along.y];
    this.points=wristFeatures(f,{x,y,rx:Math.hypot(across.x,along.x),ry:Math.hypot(across.y,along.y),basis});
    this.lastHand=time;this.lastDisplay=time;this.baseRadius=this.pose.wristRadius;this.turn=0;
    this.bridge=false;
    this.diagnostics={state:this.rejoin?'rejoining':'hand',reason:this.points.length>=8?'armed':'low-texture',features:this.points.length};
  }
  fallback(time,reason){
    this.rejoin=null;
    if(this.motion&&this.steps>=2&&this.pose&&time-this.lastHand<=1000){
      this.bridge=true;
      this.diagnostics={state:'flow',reason,ageMs:time-this.lastHand,inliers:this.motion.inliers,residual:this.motion.residual};
      return true;
    }
    // Preserve the ordinary tracker grace period externally, never restart it.
    this.diagnostics={state:'lost',reason};return false;
  }
  sample(time){
    if(!this.pose||time<this.lastDisplay||time-this.lastDisplay>140)return null;
    if(this.bridge&&time-this.lastHand>1000)return null;
    return this.bridge||this.rejoin?this.pose:null;
  }
}
