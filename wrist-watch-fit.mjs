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

export class CenterObservation {
  constructor(){this.reset();}
  reset(){this.pose=null;this.time=-Infinity;this.size=null;}
  update(pose,time,sourceWidth,sourceHeight,now=time){
    if(!Number.isFinite(time)||!Number.isFinite(now)||time>now||time<=this.time)return false;
    this.time=time;
    const valid=pose?.accepted&&pose.score>=.55&&[pose.x,pose.y,sourceWidth,sourceHeight].every(Number.isFinite)
      &&pose.x>0&&pose.y>0&&pose.x<sourceWidth&&pose.y<sourceHeight&&now-time<=350;
    if(!valid){this.pose=null;return false;}
    const source=[sourceWidth,sourceHeight];
    this.pose={...pose};this.size=source;
    return true;
  }
  sample(now){return this.pose&&now>=this.time&&now-this.time<=350?this.pose:null;}
}
