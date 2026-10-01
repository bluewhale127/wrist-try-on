import {Quaternion,Vector3,MathUtils} from './vendor/three/three.module.js';
import {watchRotationDegrees} from './pose.js?v=712';

// Watch-local right-handed axes, after legacy handedness correction:
// +Y twelve, -Y six; +Z dial outward, -Z toward inner wrist; +X three, -X nine.
// These are unit directions, NOT metric depth labels or strap surface geometry.
export function watchAxes(rotation,watchSign=1,dialDegrees=90){
 if(!rotation||!rotation.toArray().every(Number.isFinite)||Math.abs(rotation.length()-1)>.01||![-1,1].includes(watchSign))return null;
 const caseRotation=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),MathUtils.degToRad(watchRotationDegrees(dialDegrees,watchSign)));
 const combined=rotation.clone().multiply(caseRotation);
 const twelve=new Vector3(0,1,0).applyQuaternion(combined).normalize();
 const front=new Vector3(0,0,1).applyQuaternion(combined).normalize();
 const three=new Vector3().crossVectors(twelve,front).normalize();
 return {twelve:twelve.toArray(),six:twelve.clone().negate().toArray(),front:front.toArray(),back:front.clone().negate().toArray(),three:three.toArray(),nine:three.clone().negate().toArray(),
  rotation6d:[...twelve.toArray(),...front.toArray()]};
}

export function teacherAxesLabel({rotation,watchSign,diagnostic,calibrated,accepted,center,width,frameTimeMs}){
 // Do not turn a transient or uncalibrated legacy orientation into a training truth.
 if(!calibrated||!accepted||!diagnostic||diagnostic.quality<.65||!Number.isFinite(diagnostic.quality)||
  !Number.isFinite(diagnostic.residual)||diagnostic.residual>.035||diagnostic.depthPending||diagnostic.turnPending||
  !Array.isArray(center)||center.length!==2||!center.every(Number.isFinite)||!Number.isFinite(width)||width<=0)return null;
 const axes=watchAxes(rotation,watchSign);if(!axes)return null;
 return {frameTimeMs,center2d:center,widthPixels:width,axes,
  cameraFrame:{x:'image right',y:'image up',z:'toward camera',mirrored:false},
  origin:'Teacher wrist anchor proposal; align to user-reviewed case contact reference before training. Absolute 3D depth not observed.',
  labelKind:'calibrated_teacher_pseudo_label',independentGroundTruth:false,
  target6d:'twelve.xyz followed by front.xyz; reconstruct right-handed orthonormal frame',
  limits:'Back is opposite dial normal, not the curved strap or wrist surface.'};
}
