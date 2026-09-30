import { Vector3 } from './vendor/three/three.module.js';
import { palmTemplate } from './palm-projection.js?v=5';

const normal = rotation => new Vector3(0,0,1).applyQuaternion(rotation).z;
const duration = 1500, minimumFrames = 12;
export function calibrationPrompt(diagnostic) {
  return ({
    missing: '손등과 손가락 전체를 화면 안에 보여 주세요',
    frame: '손끝까지 화면 안에 넣어 주세요',
    open: '손등을 보이고 손가락을 편하게 펴 주세요',
    frontal: '손등을 카메라와 평행하게 맞춰 주세요',
    depth: '손등 각도를 조금 바꿔 주세요 · 깊이 확인 중',
    motion: '손과 카메라를 잠깐 멈춰 주세요',
    shape: '손가락을 편 채로 유지해 주세요 · 모양 확인 중',
    gap: '손을 계속 보여 주세요 · 기준 다시 확인 중',
  })[diagnostic.reason] || `그대로 유지해 주세요 · 기준 확인 ${Math.round((diagnostic.progress || 0)*100)}%`;
}

// Only startup uses this gate. Once a reference exists, curls, side views and
// reacquisition keep using the established tracking and recovery logic.
export class InitialCalibration {
  constructor() { this.reset(); }
  reset() { this.anchor = null; this.samples = []; this.lastTime = -Infinity; }
  update(pose, time) {
    const fail = reason => { this.reset(); return {ready:false, reason, progress:0}; };
    if (!pose) return fail('missing');
    if (!pose.calibration?.inFrame) return fail('frame');
    if (!pose.calibration.open || pose.rotationQuality < .9) return fail('open');
    // The two depth outputs have different systematic biases on real hands.
    // A modest mismatch is not a failed detection. Keep a broad sanity gate
    // for conflicting orientation, plus a separate frontal/stability check.
    if (!pose.depthRotation || pose.rotation.angleTo(pose.depthRotation) > .6) return fail('depth');
    if (Math.abs(normal(pose.rotation)) < .82 || Math.abs(normal(pose.depthRotation)) < .82) return fail('frontal');
    const template = palmTemplate(pose.imagePalm, pose.rotation);
    if (!template) return fail('shape');
    const center = pose.imagePalm.reduce((sum,p)=>sum.add(p),new Vector3()).multiplyScalar(.2);
    const length = pose.imagePalm.slice(1).reduce((sum,p)=>sum.add(p),new Vector3()).multiplyScalar(.25).distanceTo(pose.imagePalm[0]);
    let reason = null;
    if (this.anchor) {
      const a = this.anchor;
      // Compare to the start of the window, never a moving reference that can
      // silently follow slow drift. A rejected frame cannot count as dwell.
      if (time-this.lastTime > 250) reason = 'gap';
      // Allow ordinary hand tremor and estimator jitter around the fixed
      // anchor; the baseline still cannot drift with continuous movement.
      else if (pose.rotation.angleTo(a.rotation) > .22 || pose.depthRotation.angleTo(a.depth) > .22 ||
        center.distanceTo(a.center)/a.length > .18 || Math.abs(Math.log(length/a.length)) > .06) reason = 'motion';
      else if (Math.sqrt(template.reduce((sum,p,i)=>sum+p.distanceToSquared(a.template[i]),0)/5) > .035) reason = 'shape';
      if (reason) this.reset();
    }
    if (!this.anchor) this.anchor = {rotation:pose.rotation.clone(), depth:pose.depthRotation.clone(), center, length, template, time};
    this.lastTime = time;
    this.samples.push({template,rotation:pose.rotation.clone()});
    // A high-frame-rate input must not grow the calibration buffer forever.
    if (this.samples.length > 120) this.samples.shift();
    const elapsed = time-this.anchor.time;
    const progress = Math.min(1, elapsed/duration, this.samples.length/minimumFrames);
    if (elapsed < duration || this.samples.length < minimumFrames) return {ready:false,reason:reason || 'hold',progress};
    const rotation = this.samples[0].rotation.clone();
    this.samples.slice(1).forEach((s,i)=>rotation.slerp(s.rotation,1/(i+2)));
    return {ready:true,progress:1,rotation,template:template.map((_,i)=>this.samples.reduce((sum,s)=>sum.add(s.template[i]),new Vector3()).multiplyScalar(1/this.samples.length))};
  }
}
