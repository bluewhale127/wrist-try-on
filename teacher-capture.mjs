import {Vector3} from './vendor/three/three.module.js';
import {teacherAxesLabel} from './watch-teacher-axes.mjs';
import {defaultFit} from './fit-settings.js';

export const CAPTURE_VERSION='teacher-03';
export const TEACHER_FIT=Object.freeze(defaultFit('hand','datejust'));
export const LIMITS={frames:300,bytes:80*1024*1024,totalBytes:200*1024*1024,intervalMs:334};

// All coordinates refer to the captured, unmirrored image, not CSS video pixels.
export function frameLabel({pose,basePose=pose,rearAxis=null,raw,selectedRotation,watchSign,diagnostic,calibrated,accepted,time,latency,width,height,landmarks}){
  if(!accepted||!calibrated)return {reason:calibrated?'tracking':'calibration'};
  if(!Number.isFinite(latency)||latency>220)return {reason:'latency'};
  if(!pose||!raw||!selectedRotation||!landmarks||landmarks.length!==21)return {reason:'tracking'};
  const palm=[0,1,2,5,9,13,17];
  if(palm.some(i=>!Number.isFinite(landmarks[i].x)||!Number.isFinite(landmarks[i].y)||landmarks[i].x<.015||landmarks[i].x>.985||landmarks[i].y<.015||landmarks[i].y>.985))return {reason:'hand'};
  // A filtered display can lag a fast hand. Do not teach that lag to the student.
  if(basePose.rotation.angleTo(selectedRotation)>.12||pose.position.distanceTo(raw.position)>pose.size*.08)return {reason:'motion'};
  if(rearAxis&&!rearAxis.trusted&&Math.abs(rearAxis.correction)>.03)return {reason:'uncertain'};
  const center=[pose.position.x+width/2,height/2-pose.position.y];
  const label=teacherAxesLabel({rotation:pose.rotation,watchSign,diagnostic,calibrated,accepted,center,width:pose.size,frameTimeMs:time});
  if(!label)return {reason:'uncertain'};
  if(diagnostic.disagreement>.6||diagnostic.surfaceRealigned||diagnostic.depthRealigned||diagnostic.turnRealigned)return {reason:'uncertain'};
  const radiusZ=pose.wristRadius/(.65*.46)*.27*TEACHER_FIT['wrist-depth'];
  const contact=pose.position.clone().add(new Vector3(0,0,radiusZ).applyQuaternion(pose.rotation));
  const contact2d=[contact.x+width/2,height/2-contact.y];
  if(contact2d.some((v,i)=>v<0||v>=[width,height][i]))return {reason:'outside'};
  return {label:{...label,schema:CAPTURE_VERSION,imageSize:[width,height],latencyMs:latency,
    center2d:contact2d,wristAnchor2d:center,caseContact2d:contact2d,caseContactRenderer3d:contact.toArray(),
    origin:'Normalized GLB case contact origin, projected into image pixels. Not an anatomical or metric ground truth.',
    renderedPose:{position:pose.position.toArray(),rotation:pose.rotation.toArray(),caseWidthPixels:pose.size,radiusZ},
    selectedRotation:selectedRotation.toArray(),baseRotation:basePose.rotation.toArray(),rearAxis,diagnostic:structuredClone(diagnostic),
    reviewed:false,approvedForTraining:false,
    settings:{...TEACHER_FIT}}};
}

// A conservative *candidate* crop, excluding predicted finger/base locations.
// Landmarks are not segmentation: these crops still require visual review.
export function wristCrop(label,landmarks){
  const [width,height]=label.imageSize,[cx,cy]=label.wristAnchor2d;
  for(const factor of [2.8,2.5,2.2,2,1.8,1.5,1.25,1]){
    const side=Math.round(label.widthPixels*factor);
    if(side<48)continue;
    const x=Math.round(cx-side/2),y=Math.round(cy-side/2),margin=side*.06;
    if(x<0||y<0||x+side>width||y+side>height)continue;
    const contains=landmarks.slice(1).some(p=>p.x*width>=x-margin&&p.x*width<=x+side+margin&&p.y*height>=y-margin&&p.y*height<=y+side+margin);
    if(contains)continue;
    const center=label.center2d;
    if(center[0]<x||center[0]>=x+side||center[1]<y||center[1]>=y+side)continue;
    return {x,y,width:side,height:side,outputSize:224,centerNormalized:[(center[0]-x)/side,(center[1]-y)/side],
      axesUnchanged:true,reviewRequired:true,method:'axis-aligned crop excluding predicted hand landmarks 1..20'};
  }
  return null;
}

export class CaptureGate {
  reset(){this.last=null;this.lastSave=-Infinity;this.streak=0;}
  constructor(){this.reset();}
  consider(result,time){
    if(!result.label){this.last=null;this.streak=0;return result;}
    const label=result.label;
    if(this.last){
      const dt=time-this.last.time;
      const dot=label.axes.front.reduce((sum,v,i)=>sum+v*this.last.label.axes.front[i],0);
      const dotY=label.axes.twelve.reduce((sum,v,i)=>sum+v*this.last.label.axes.twelve[i],0);
      const radians=Math.acos(Math.max(-1,Math.min(1,Math.min(dot,dotY))));
      const distance=Math.hypot(...label.center2d.map((v,i)=>v-this.last.label.center2d[i]));
      if(dt<=0||dt>250||radians>1.3*dt/1000+.025||distance/label.widthPixels>dt/1000*.8+.02)this.streak=0;
    }
    this.last={label,time};this.streak++;
    if(this.streak<3)return {reason:'settling'};
    if(time-this.lastSave<LIMITS.intervalMs)return {reason:'cadence'};
    this.lastSave=time;return result;
  }
}

// A scene tag is a user's filming intention, never a measured orientation.
// Review images deliberately have no usable target center or axes.
export function reviewLabel({reason,scene,time,width,height,evidence}){
  return {schema:CAPTURE_VERSION,kind:'review',reason,scene,frameTimeMs:time,imageSize:[width,height],
    axes:null,center2d:null,reviewed:false,approvedForTraining:false,
    evidence:{...structuredClone(evidence),trusted:false}};
}

export class CollectionGate {
  constructor(){this.reset();}
  reset(){this.hasReference=false;this.lastSave=-Infinity;}
  consider(candidate,{calibrated,scene,time}){
    this.hasReference ||= calibrated;
    if((scene!=='side'&&!this.hasReference)||time-this.lastSave<LIMITS.intervalMs)return null;
    if(scene!=='side'&&!candidate.label&&candidate.reason==='cadence')return null;
    this.lastSave=time;
    return scene==='side'?{kind:'review',reason:'side-review'}:
      candidate.label?{kind:'label'}:{kind:'review',reason:candidate.reason||'tracking'};
  }
}

// A framing aid, not a detected wrist box or a target center. It works even
// with no landmarks and must be frozen alongside the inference source image.
export function reviewCrop(width,height,guide={}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||Math.min(width,height)<48)return null;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const fraction=Number.isFinite(guide.fraction)?clamp(guide.fraction,.35,1):.8;
  const side=Math.min(Math.min(width,height),Math.max(48,Math.round(Math.min(width,height)*fraction)));
  const cx=(Number.isFinite(guide.x)?clamp(guide.x,0,1):.5)*width;
  const cy=(Number.isFinite(guide.y)?clamp(guide.y,0,1):.55)*height;
  return {x:clamp(Math.round(cx-side/2),0,width-side),y:clamp(Math.round(cy-side/2),0,height-side),width:side,height:side,
    outputSize:224,method:'user-positioned framing guide; not a detected wrist or target',reviewRequired:true,centerNormalized:null};
}

export function guideFromDisplayPoint({x,y,stageWidth,stageHeight,imageWidth,imageHeight,mirrored=false}){
  if(![x,y,stageWidth,stageHeight,imageWidth,imageHeight].every(Number.isFinite)||Math.min(stageWidth,stageHeight,imageWidth,imageHeight)<=0)return null;
  const scale=Math.min(stageWidth/imageWidth,stageHeight/imageHeight);
  let ix=(x-stageWidth/2)/scale+imageWidth/2;
  const iy=(y-stageHeight/2)/scale+imageHeight/2;
  if(ix<0||iy<0||ix>imageWidth||iy>imageHeight)return null;
  if(mirrored)ix=imageWidth-ix;
  return {x:ix/imageWidth,y:iy/imageHeight};
}

export class CaptureTrace {
  constructor(limit=1800){this.limit=limit;this.samples=[];this.rejected={};this.observations=0;}
  add(sample){
    this.observations++;
    if(sample.reason!=='saved'&&sample.reason!=='eligible'&&sample.reason!=='cadence')this.rejected[sample.reason]=(this.rejected[sample.reason]||0)+1;
    this.samples.push(structuredClone(sample));if(this.samples.length>this.limit)this.samples.shift();
  }
  summary(){return {observations:this.observations,rejected:{...this.rejected},trace:structuredClone(this.samples),traceTruncated:this.observations>this.limit};}
}
