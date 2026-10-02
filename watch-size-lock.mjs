// Capture the case size only from a visible, calibrated pose. The wrist mask
// follows current hand dimensions. Loss/reacquisition preserves the reference;
// camera, viewport or explicit calibration resets clear it.
export class WatchSizeLock {
 constructor(){this.reset();}
 reset(){this.reference=null;}
 dimensions(pose,manualScale){
  if(!pose||![pose.size,pose.wristRadius,manualScale].every(v=>Number.isFinite(v)&&v>0))return null;
  this.reference||={caseSize:pose.size/manualScale};
  return {size:this.reference.caseSize*manualScale,wristRadius:pose.wristRadius};
 }
}
