import {Euler,Quaternion,Vector3,MathUtils} from './vendor/three/three.module.js';
import {wristDimensions} from './wrist-rig.js?v=719';

export const DEFAULTS=Object.freeze({scale:1,heading:0,roll:0,tilt:0,dial:90,width:1.3,depth:1.4,height:0,occlusion:true,guide:false});
export const LIMITS={scale:[.3,2],heading:[-180,180],roll:[-180,180],tilt:[-80,80],dial:[-180,180],width:[.65,2],depth:[.6,2],height:[-.2,.6]};
export function sanitizeSettings(value){
  const result={...DEFAULTS};
  for(const [key,[lo,hi]] of Object.entries(LIMITS))if(Number.isFinite(value?.[key]))result[key]=MathUtils.clamp(value[key],lo,hi);
  for(const key of ['occlusion','guide'])if(typeof value?.[key]==='boolean')result[key]=value[key];
  return result;
}

// Explicit user action only: keep size/fit while clearing a saved side-on pose.
export function frontFacingSettings(value,heading){
  const result=sanitizeSettings(value);
  return {...result,heading:Number.isFinite(heading)?MathUtils.clamp(heading,-180,180):result.heading,roll:0,tilt:0,dial:90};
}

// Only position is learned. Scale and all rotation axes come from the controls.
// Match object-fit: contain, including its empty margins and selfie reflection.
export function manualPlacement(point,view,settings,mirror=false){
  const {videoWidth:vw,videoHeight:vh,width,height}=view;
  if(![point?.x,point?.y,vw,vh,width,height].every(Number.isFinite)||Math.min(vw,vh,width,height)<=0)return null;
  const f=sanitizeSettings(settings),scale=Math.min(width/vw,height/vh);
  const target=new Vector3((point.x-vw/2)*scale*(mirror?-1:1),(vh/2-point.y)*scale,0);
  const baseSize=Math.min(vw,vh)*.24*scale,caseSize=baseSize*f.scale;
  const dimensions=wristDimensions(baseSize/.65,f.width,f.depth);
  const rotation=new Quaternion().setFromEuler(new Euler(...[f.tilt,f.roll,f.heading].map(MathUtils.degToRad),'ZYX'));
  // The annotated point is the visible watch contact point, not a measured 3D
  // cylinder centre. Keep the projected case back on it when adjusting angles.
  const mountOffset=new Vector3(0,0,dimensions.radiusZ+f.height*caseSize).applyQuaternion(rotation);
  return {position:target.clone().sub(mountOffset),target,rotation,dimensions,caseSize,dialRadians:MathUtils.degToRad(f.dial),height:f.height};
}

export const TRACKING=Object.freeze({acquireScore:.55,continueScore:.4,acquireFrames:2,pairGapMs:200,holdMs:220,weakWindowMs:650});

export class CenterObservation {
  constructor(){this.reset();}
  reset(){
    this.pose=null;this.time=-Infinity;this.lastInput=-Infinity;this.strongTime=-Infinity;
    this.size=null;this.candidate=null;this.reason='waiting';
  }
  sample(now){return this.pose&&now>=this.time&&now-this.time<=TRACKING.holdMs?this.pose:null;}
  state(now){
    const visible=!!this.sample(now);
    const acquiring=!visible&&!!this.candidate&&now>=this.candidate.time&&now-this.candidate.time<=TRACKING.pairGapMs;
    const recent=now-this.time<=140;
    return {phase:visible?(recent&&this.reason==='strong'?'tracking':recent&&this.reason==='weak'?'assisted':'holding'):acquiring?'acquiring':'searching',
      reason:this.reason,visible,observationAgeMs:Number.isFinite(this.time)?Math.max(0,now-this.time):null,
      strongAgeMs:Number.isFinite(this.strongTime)?Math.max(0,now-this.strongTime):null,acquireCount:acquiring?this.candidate.count:0};
  }
  update(pose,time,sourceWidth,sourceHeight,now=time){
    if(!Number.isFinite(time)||!Number.isFinite(now)||time>now||time<=this.lastInput)return false;
    if(this.size&&(this.size[0]!==sourceWidth||this.size[1]!==sourceHeight))this.reset();
    this.lastInput=time;
    this.size=[sourceWidth,sourceHeight];
    const inside=[pose?.x,pose?.y,pose?.score,sourceWidth,sourceHeight].every(Number.isFinite)
      &&sourceWidth>0&&sourceHeight>0&&pose.score>=0&&pose.score<=1
      &&pose.x>0&&pose.y>0&&pose.x<sourceWidth&&pose.y<sourceHeight;
    if(!inside){this.pose=null;this.candidate=null;this.reason='invalid';return false;}
    if(now-time>TRACKING.holdMs){this.candidate=null;this.reason='stale';return false;}
    if(!this.sample(now))this.pose=null;
    const strong=pose.score>=TRACKING.acquireScore&&pose.accepted;
    const short=Math.min(sourceWidth,sourceHeight),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    if(this.pose){
      const dt=Math.min(.2,Math.max(0,(time-this.time)/1000));
      // Lower scores may update only a smaller neighbourhood of a recent strong
      // observation. They cannot initialize, relocate or prolong a lock forever.
      const radius=short*(strong ? .08+.6*dt : .04+.35*dt);
      if(distance(pose,this.pose)<=radius&&(strong||(pose.score>=TRACKING.continueScore&&pose.score<TRACKING.acquireScore&&time-this.strongTime<=TRACKING.weakWindowMs))){
        const alpha=1-Math.exp(-(time-this.time)/(strong?35:65));
        this.pose={...pose,x:this.pose.x+(pose.x-this.pose.x)*alpha,y:this.pose.y+(pose.y-this.pose.y)*alpha};
        this.time=time;this.candidate=null;this.reason=strong?'strong':'weak';
        if(strong)this.strongTime=time;
        return true;
      }
    }
    if(strong){
      const previous=this.candidate;
      const consistent=previous&&time-previous.time<=TRACKING.pairGapMs&&distance(pose,previous.pose)<=short*.1;
      this.candidate={pose:{...pose},time,count:consistent?previous.count+1:1};
      this.reason=this.pose?'jump':'acquiring';
      // Never interpolate a rejected jump across the arm. A new location can
      // attach only after the old observation expires and two observations agree.
      if(!this.pose&&this.candidate.count>=TRACKING.acquireFrames){
        this.pose={...pose};this.time=time;this.strongTime=time;this.candidate=null;this.reason='strong';return true;
      }
    }else{
      this.candidate=null;this.reason=pose.score>=TRACKING.continueScore?'weak-unconfirmed':'low-score';
    }
    return false;
  }
}
