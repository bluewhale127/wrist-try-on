// Reject contradictory observations; never replace them with a clamped rotation.
const pairs=[[0,1],[0,2],[0,3],[0,4],[1,4]];
const lengths=pose=>pose?.worldPalm?.length===5?pairs.map(([a,b])=>pose.worldPalm[a].distanceTo(pose.worldPalm[b])):null;
export class PalmConsistency {
 constructor(){this.reset();}
 reset(){this.reference=null;}
 capture(pose){const b=lengths(pose);if(b?.every(v=>Number.isFinite(v)&&v>.001))this.reference=b;}
 assess(pose){
  if(!this.reference)return {allowed:true,reason:'unseeded'};
  const b=lengths(pose),depthAngle=pose?.depthRotation?pose.rotation.angleTo(pose.depthRotation):null;
  if(!b?.every(v=>Number.isFinite(v)&&v>.001)||depthAngle===null)return {allowed:false,reason:'missing-geometry'};
  // Absolute model-space bone lengths can drift together. Only a change in
  // their proportions contradicts the rigid palm reference.
  const ratios=b.map((v,i)=>v/this.reference[i]),shapeSpread=Math.max(...ratios)/Math.min(...ratios);
  const reason=shapeSpread>1.65?'deformed-palm':'consistent';
  return {allowed:reason==='consistent',reason,shapeSpread,depthAngle};
 }
}
