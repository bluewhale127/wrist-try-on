import {Quaternion,Euler,Vector3,MathUtils} from './vendor/three/three.module.js';
// Geometry has already been reflected once by fitGeometry; position is reflected here.
export function watchPlacement(point,view,settings,geometry=null,mirror=false){
  const {width,height,videoWidth:vw,videoHeight:vh}=view;
  if(![point?.x,point?.y,width,height,vw,vh].every(Number.isFinite)||Math.min(width,height,vw,vh)<=0)return null;
  const s=Math.min(width/vw,height/vh),toRad=MathUtils.degToRad;
  const sourceWidth=geometry?.projectedWidth??Math.min(vw,vh)*.36;
  const caseSize=sourceWidth*.68*s*settings.scale;
  const radiusX=sourceWidth*.5*s*settings.width,radiusZ=sourceWidth*.31*s*settings.depth;
  const heading=geometry?.heading??toRad(settings.heading),dial=geometry?.dial??toRad(settings.dial);
  const rotation=new Quaternion().setFromEuler(new Euler(toRad(settings.tilt),toRad(settings.roll),heading,'ZYX'));
  const target=new Vector3((point.x-vw/2)*s*(mirror?-1:1),(vh/2-point.y)*s,0);
  const mountOffset=new Vector3(0,0,radiusZ+settings.height*caseSize).applyQuaternion(rotation);
  return {position:target.clone().sub(mountOffset),target,rotation,caseSize,dialRadians:dial,height:settings.height,
    dimensions:{radiusX,radiusZ,length:radiusX*2.8},heading,sourceWidth};
}
