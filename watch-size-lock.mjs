// Capture only from a visible, calibrated pose. Loss/reacquisition does not
// change this reference; camera, viewport or explicit calibration resets do.
export class WatchSizeLock {
 constructor(){this.reset();}
 reset(){this.reference=null;}
 dimensions(pose,manualScale){
  if(!pose||![pose.size,pose.wristRadius,manualScale].every(v=>Number.isFinite(v)&&v>0))return null;
  this.reference||={caseSize:pose.size/manualScale,wristRadius:pose.wristRadius};
  return {size:this.reference.caseSize*manualScale,wristRadius:this.reference.wristRadius};
 }
}
