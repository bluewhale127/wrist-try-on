import { Quaternion, Vector3 } from './vendor/three/three.module.js';
import { fitPalmProjection } from './palm-projection.js?v=5';

const Y = new Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pitch = q => Math.asin(clamp(Y.clone().applyQuaternion(q).z, -1, 1));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// The calibrated 2D palm can mistake a changed width/length ratio for forearm
// pitch. Use consistent live longitudinal depth only while the palm is broad
// and well observed. Both depth outputs share a model: this is a temporal
// consistency gate, not an independent confidence or visibility measurement.
export class RearPalmAxis {
  constructor() { this.reset(); }
  reset() { this.history = []; this.correction = 0; this.lastTime = -Infinity; this.pose = null; this.diagnostics = null; }
  interrupt() { this.history = []; }
  update(pose, observation, template, time) {
    if (!pose || !observation || observation.mirror || !template) { this.reset(); return pose; }
    const projection = fitPalmProjection(template, observation.imagePalm);
    if (!projection) { this.reset(); return pose; }
    const result = this.apply(pose.rotation, observation, projection, time);
    // Keep this display correction out of the palm solver's branch/velocity
    // history. Feeding it back would make depth candidates swap unexpectedly.
    this.pose = { ...pose, position: pose.position.clone(), rotation: result.rotation.clone() };
    this.diagnostics = result.diagnostic;
    return this.pose;
  }
  sample(time) { return time >= this.lastTime && time - this.lastTime <= 220 ? this.pose : null; }
  apply(rotation, next, projection, time) {
    const dt = Math.max(0, Math.min(.1, (time - this.lastTime) / 1000));
    if (time <= this.lastTime || time - this.lastTime > 220) this.reset();
    this.lastTime = time;
    const raw = pitch(next.rotation), depth = next.depthRotation && pitch(next.depthRotation);
    const palm = next.imagePalm;
    const along = palm.slice(1).reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(.25).sub(palm[0]);
    const across = palm[1].clone().sub(palm[4]);
    const area = Math.abs(across.x * along.y - across.y * along.x) / (projection.scale * projection.scale);
    // Thumb agreement affects the across-palm axis, not wrist-to-knuckle pitch.
    // A valid knuckle frame (quality .7) is sufficient for this axis alone.
    const broadPalm = next.rotationQuality >= .5 && projection.residual < .035 &&
      Math.abs(projection.normalZ) > .55 && area > .3 && along.length() / projection.scale > .65;
    const eligible = broadPalm && depth !== null &&
      Math.abs(raw - depth) < .28 && Math.max(Math.abs(raw), Math.abs(depth)) < .75;
    const measured = depth === null ? raw : (raw + depth) * .5;
    this.history = broadPalm ? this.history.filter(h => time - h.time <= 450).slice(-4) : [];
    if (eligible) this.history.push({ pitch: measured, time });
    const stablePitch = this.history.length ? median(this.history.map(h => h.pitch)) : measured;
    const scatter = this.history.length ? median(this.history.map(h => Math.abs(h.pitch - stablePitch))) : Infinity;
    const trusted = eligible && this.history.length >= 3 && time - this.history[0].time >= 140 &&
      scatter < .12 && Math.abs(measured - stablePitch) < .25;
    // Only current evidence can supply depth. No extrapolated rotation and no
    // extending the tracker's existing lost-hand timeout.
    const fittedPitch = pitch(rotation);
    const target = trusted ? clamp(stablePitch - fittedPitch, -.95, .95) : 0;
    const step = (target - this.correction) * (1 - Math.exp(-dt * (trusted ? 8 : 3)));
    this.correction += clamp(step, -dt * 1.2, dt * 1.2);
    // Never pass through a pole and reverse the visible longitudinal heading
    // when the palm solver changes pitch while the correction is fading out.
    const correction = clamp(this.correction, -Math.PI/2-fittedPitch+1e-5, Math.PI/2-fittedPitch-1e-5);
    if (Math.abs(correction) > .001) {
      const axis = Y.clone().applyQuaternion(rotation);
      const heading = Math.atan2(-axis.x, axis.y);
      // This screen-plane axis rotates with the hand, so vertical and horizontal
      // arms use the same calculation. Preserve the solver's axial roll.
      const acrossScreen = new Vector3(Math.cos(heading), Math.sin(heading), 0);
      rotation = rotation.clone().premultiply(new Quaternion().setFromAxisAngle(acrossScreen, correction));
    }
    return { rotation, diagnostic: { eligible, trusted, fittedPitch, measuredPitch: measured, stablePitch, correction, frames: this.history.length } };
  }
}
