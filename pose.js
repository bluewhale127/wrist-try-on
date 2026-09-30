import { Matrix4, Quaternion, Vector3 } from './vendor/three/three.module.js';
import { palmTemplate, fitPalmProjection } from './palm-projection.js?v=5';

// The video and 3D overlay both use CSS object-fit: cover. All units here are CSS pixels.
export function coverTransform(videoWidth, videoHeight, width, height) {
  const scale = Math.max(width / videoWidth, height / videoHeight);
  return { scale, cropX: (videoWidth * scale - width) / 2, cropY: (videoHeight * scale - height) / 2 };
}

export function landmarkPoint(p, view, mirror = false) {
  const fit = coverTransform(view.videoWidth, view.videoHeight, view.width, view.height);
  const screenX = p.x * view.videoWidth * fit.scale - fit.cropX;
  return new Vector3(
    (mirror ? view.width - screenX : screenX) - view.width / 2,
    view.height / 2 - (p.y * view.videoHeight * fit.scale - fit.cropY),
    -(p.z || 0) * view.videoWidth * fit.scale,
  );
}

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const PALM = [0, 5, 9, 13, 17];
const finitePoint = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const Z = new Vector3(0, 0, 1), Y = new Vector3(0, 1, 0);
const halfTurn = new Quaternion().setFromAxisAngle(Y, Math.PI);

export function estimateWristPose(landmarks, view, { mirror = false, offset = 0.38, scale = 1, worldLandmarks } = {}) {
  if (!landmarks || landmarks.length !== 21) return null;
  if (PALM.some(i => !finitePoint(landmarks[i]))) return null;
  const screen = PALM.map(i => landmarkPoint(landmarks[i], view, mirror).setZ(0));
  const [wrist, index, middle, ring, pinky] = screen;
  // Average the rigid knuckles, not finger tips: curling fingers should not steer the watch.
  const center = index.clone().add(middle).add(ring).add(pinky).multiplyScalar(0.25);
  const along = center.sub(wrist);
  const projectedLength = along.length();
  if (projectedLength < 12) return null;
  const y2 = along.clone().normalize();
  const heading = Math.atan2(-y2.x, y2.y);
  let palmWidth = index.distanceTo(pinky), rotationQuality = 0;
  let rotation = new Quaternion().setFromAxisAngle(Z, heading);
  let thumbUsed = false, worldPalm = null;
  if (worldLandmarks?.length === 21 && PALM.every(i => finitePoint(worldLandmarks[i]))) {
    const worldPoint = i => {
      const p = worldLandmarks[i]; return new Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
    };
    const world = PALM.map(worldPoint);
    worldPalm = world;
    const wy = world[1].clone().add(world[2]).add(world[3]).add(world[4]).multiplyScalar(0.25).sub(world[0]);
    const wx = world[1].clone().sub(world[4]);
    if (wy.length() > 0.005 && wx.length() > 0.005) {
      wy.normalize(); wx.addScaledVector(wy, -wx.dot(wy));
      if (wx.length() > 0.005) {
        wx.normalize();
        rotationQuality = 1;
        // The pinky-to-thumb BASE vector identifies the radial side in 3D.
        // Tips are deliberately excluded: opening fingers is not a wrist rotation.
        if ([1, 2].every(i => finitePoint(worldLandmarks[i]))) {
          const thumb = worldPoint(1).add(worldPoint(2)).multiplyScalar(0.5).sub(world[4]);
          thumb.addScaledVector(wy, -thumb.dot(wy));
          if (thumb.length() > 0.008) {
            thumb.normalize();
            const agreement = thumb.dot(wx);
            if (agreement > 0.6) { wx.lerp(thumb, 0.2).normalize(); thumbUsed = true; }
            else rotationQuality = 0.7; // A tucked/occluded thumb must not freeze the knuckle frame.
          }
        }
        // Correct small image/world heading disagreement without flattening depth.
        const worldHeading = Math.atan2(-wy.x, wy.y);
        const align = new Quaternion().setFromAxisAngle(Z, heading - worldHeading);
        wx.applyQuaternion(align); wy.applyQuaternion(align);
        const normal = new Vector3().crossVectors(wx, wy).normalize();
        wx.crossVectors(wy, normal).normalize();
        rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(wx, wy, normal));
        // No camera-facing normal flip, Euler angle clamp, or side-view freeze here.
      }
      // Fit one image scale across several palm bones, avoiding width collapse on rotation.
      let imageEnergy = 0, worldEnergy = 0;
      for (const [a, b] of [[0, 1], [0, 2], [0, 3], [0, 4], [1, 4]]) {
        imageEnergy += screen[a].distanceToSquared(screen[b]);
        worldEnergy += (world[a].x - world[b].x) ** 2 + (world[a].y - world[b].y) ** 2;
      }
      if (worldEnergy > 1e-6) palmWidth = world[1].distanceTo(world[4]) * Math.sqrt(imageEnergy / worldEnergy);
    }
  }
  // A scale bound also guards bad world-depth estimates. This is still visual, not metric.
  palmWidth = clamp(palmWidth, projectedLength * 0.48, projectedLength * 1.35);
  const position = wrist.clone().addScaledVector(along, -offset);
  const size = palmWidth * 0.65 * scale;
  return { position, rotation, size, wristRadius: palmWidth * 0.65 * 0.46, heading, rotationQuality, thumbUsed, imagePalm: screen, worldPalm, userScale: scale };
}

// Rotate the case around the wrist centre, not around the centre of the dial.
export function wristSurfacePosition(center, rotation, radius) {
  return new Vector3(0, 0, radius).applyQuaternion(rotation).add(center);
}

export function smoothingAlpha(elapsedSeconds, response = 16) {
  return 1 - Math.exp(-Math.min(0.1, Math.max(0, elapsedSeconds)) * response);
}

function cutoffAlpha(dt, hz) { return 1 - Math.exp(-2 * Math.PI * hz * dt); }

// Adaptive filtering: steady hands get stronger smoothing, moving hands respond quickly.
// Hold only brief gaps; never extrapolate a watch indefinitely after a hand leaves the frame.
export class WristPoseTracker {
  constructor() { this.reset(); }
  reset() {
    this.pose = null; this.previous = null; this.lastGood = -Infinity; this.speed = 0;
    this.velocity = new Vector3(); this.pending = null; this.pendingRotation = null;
    this.motionVelocity = new Vector3(); this.pendingPose = null;
    this.orientationSign = 0; this.angularSpeed = 0; this.reference = null; this.referenceFrames = 0;
    this.referenceStarted = 0; this.referenceTime = -Infinity; this.templates = []; this.template = null;
    this.calibrationRotation = null; this.calibrationHeading = 0;
    this.lastRotationGood = -Infinity; this.lastInput = -Infinity;
    this.previousRotation = null; this.rotationVelocity = new Vector3(); this.recovery = null; this.branchEvidence = null;
    this.diagnostics = { state: 'calibrating', quality: 0, progress: 0 };
  }
  orientedRotation(next, time) {
    this.diagnostics = { state: 'uncertain', quality: 0, progress: this.orientationSign ? 1 : 0 };
    if (next.rotationQuality < 0.5) { this.branchEvidence = null; return null; }
    if (!this.orientationSign) {
      const normalZ = Z.clone().applyQuaternion(next.rotation).z;
      const template = Math.abs(normalZ) >= 0.6 && palmTemplate(next.imagePalm, next.rotation);
      this.diagnostics.state = 'calibrating';
      if (!template) { this.reference = null; this.referenceFrames = 0; return null; }
      if (!this.reference || time - this.referenceTime > 250 || this.reference.angleTo(next.rotation) > 0.25) {
        this.reference = next.rotation.clone(); this.referenceFrames = 0;
        this.referenceStarted = time; this.templates = [];
      }
      this.referenceTime = time;
      this.reference.slerp(next.rotation, 0.5);
      this.templates.push(template); if(this.templates.length>30)this.templates.shift();
      this.diagnostics.progress = Math.min(1,(time-this.referenceStarted)/500);
      if (++this.referenceFrames < 6 || time - this.referenceStarted < 500) return null;
      this.orientationSign = normalZ >= 0 ? 1 : -1;
      this.calibrationRotation = this.reference.clone();
      if (this.orientationSign === -1) this.calibrationRotation.multiply(halfTurn);
      this.calibrationHeading = next.heading;
      this.template = template.map((_,i)=>this.templates.reduce((sum,t)=>sum.add(t[i]),new Vector3()).multiplyScalar(1/this.templates.length));
      this.templates = [];
    }
    const projection = fitPalmProjection(this.template, next.imagePalm);
    if (!projection) return null;
    const raw = this.orientationSign === 1 ? next.rotation.clone() : next.rotation.clone().multiply(halfTurn);
    const candidates = projection.rotations.map(q=>this.orientationSign === 1 ? q : q.multiply(halfTurn));
    // Display expiry and orientation memory are different. A short occlusion
    // must not let a noisy world-depth estimate choose the opposite solution.
    const age = time - this.lastRotationGood;
    const previous = age <= 1500 ? this.previousRotation : null;
    const recoveryReference = this.calibrationRotation.clone().premultiply(new Quaternion().setFromAxisAngle(Z, next.heading-this.calibrationHeading));
    let predicted = previous?.clone();
    const speed = this.rotationVelocity.length();
    if (predicted && speed > 0.01) predicted.premultiply(new Quaternion().setFromAxisAngle(this.rotationVelocity.clone().normalize(), speed * Math.min(age, 100) / 1000));
    const score = q => predicted ? q.angleTo(predicted) + 0.12*q.angleTo(raw) : this.previousRotation ? q.angleTo(recoveryReference) : q.angleTo(raw);
    let rotation = score(candidates[0]) <= score(candidates[1]) ? candidates[0] : candidates[1];
    let branchConfirmed = false;
    const rawChoice = candidates[0].angleTo(raw) <= candidates[1].angleTo(raw) ? candidates[0] : candidates[1];
    // At a frontal turning point both depth solutions meet. Motion prediction
    // alone would force continued rotation when the user actually reverses.
    // Let sustained world evidence resolve this locally, never a large flip.
    if (previous && age <= 180 && rawChoice !== rotation && rawChoice.angleTo(raw) < 0.25 && rotation.angleTo(raw) > 0.3) {
      if (!this.branchEvidence || time-this.branchEvidence.time > 160 || this.branchEvidence.rotation.angleTo(rawChoice) > 0.3) {
        this.branchEvidence = { rotation: rawChoice.clone(), started: time, time, count: 1 };
      } else { this.branchEvidence.rotation.copy(rawChoice); this.branchEvidence.time = time; this.branchEvidence.count++; }
      if (this.branchEvidence.count >= 3 && time-this.branchEvidence.started >= 100 && rawChoice.angleTo(previous) < 0.7) { rotation = rawChoice; branchConfirmed = true; }
    } else this.branchEvidence = null;
    const quality = Math.exp(-((projection.residual/0.07)**2));
    const disagreement = rotation.angleTo(raw);
    this.diagnostics = { state: quality < 0.35 ? 'uncertain' : disagreement > 0.6 ? 'corrected' : 'tracking',
      quality, progress: 1, residual: projection.residual, disagreement, rawNormalZ: Z.clone().applyQuaternion(raw).z,
      fittedNormalZ: projection.normalZ*this.orientationSign, memoryAgeMs: Number.isFinite(age) ? age : null, branchConfirmed };
    if (quality < 0.35) { this.recovery = null; this.branchEvidence = null; return null; }
    if (this.previousRotation && age > 220) {
      const longGap = age > 1500;
      const separated = candidates[0].angleTo(candidates[1]) > 0.5;
      const ambiguous = previous && separated && Math.abs(candidates[0].angleTo(previous) - candidates[1].angleTo(previous)) < 0.12;
      const tooFar = previous && rotation.angleTo(previous) > Math.min(1.2, 0.45 + age * 0.001);
      // Once motion is unknowable, ask for a stable back-of-hand view. Do not
      // guess a half-turn that happened while the hand was hidden.
      const backFacing = this.diagnostics.fittedNormalZ > 0.55 && this.diagnostics.rawNormalZ > 0.5;
      const nearReference = rotation.angleTo(recoveryReference) < 0.65 || this.diagnostics.fittedNormalZ > 0.95;
      if ((longGap && (!backFacing || !nearReference)) || ambiguous || tooFar) {
        this.recovery = null; this.diagnostics.state = 'reorient'; return null;
      }
      if (!this.recovery || time-this.recovery.time > 200 || this.recovery.rotation.angleTo(rotation) > 0.3) {
        this.recovery = { rotation: rotation.clone(), started: time, time, count: 1 };
      } else { this.recovery.rotation.copy(rotation); this.recovery.time = time; this.recovery.count++; }
      this.diagnostics.state = longGap ? 'reorient' : 'reacquiring';
      if (this.recovery.count < 3 || time-this.recovery.started < (longGap ? 250 : 60)) return null;
    }
    // One calibrated palm width drives both size and wrist radius. Learned bone
    // lengths can change when fingers overlap; they must not resize the wrist.
    const palmWidth = this.template[1].distanceTo(this.template[4])*projection.scale;
    next.size = palmWidth*0.65*next.userScale;
    next.wristRadius = palmWidth*0.65*0.46;
    return rotation;
  }
  acceptRotation(rotation, time) {
    const dt = (time-this.lastRotationGood)/1000;
    if (this.previousRotation && dt > 0 && dt < 0.18) {
      const delta = rotation.clone().multiply(this.previousRotation.clone().invert()).normalize();
      if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      const vector = new Vector3(delta.x, delta.y, delta.z), sine = vector.length();
      if (sine > 1e-6) vector.multiplyScalar(Math.min(6, 2*Math.atan2(sine, delta.w)/dt)/sine);
      this.rotationVelocity.lerp(vector, cutoffAlpha(dt, 4));
    } else this.rotationVelocity.set(0, 0, 0);
    this.lastRotationGood = time; this.previousRotation = rotation.clone(); this.recovery = null;
  }
  update(next, time) {
    if (!Number.isFinite(time) || time <= this.lastInput) return false;
    const frameDt = clamp((time-this.lastInput)/1000, 0.001, 0.1);
    this.lastInput = time;
    if (!next) { this.branchEvidence = null; this.diagnostics = { state: 'missing', quality: 0, progress: this.orientationSign ? 1 : 0 }; return false; }
    next = { ...next };
    const oriented = this.orientedRotation(next, time);
    // A failed rotation fit also makes its inferred scale/anchor untrustworthy.
    // Hold the complete last pose rather than mixing a new raw size/position
    // with an old rotation during the 220ms display grace period.
    if (this.orientationSign && !oriented) return false;
    if (!this.pose || time - this.lastGood > 250) {
      this.pose = { ...next, position: next.position.clone(), rotation: next.rotation.clone() };
      this.pose.rotation.copy(oriented || this.previousRotation || new Quaternion().setFromAxisAngle(Z, next.heading));
      if (oriented) this.acceptRotation(oriented, time);
      this.previous = next.position.clone(); this.lastGood = time; this.speed = 0; this.velocity.set(0, 0, 0); this.pending = null;
      this.motionVelocity.set(0, 0, 0); this.pendingPose = null;
      this.pendingRotation = null; this.angularSpeed = 0;
      return true;
    }
    const dt = clamp((time - this.lastGood) / 1000, 0.001, 0.25);
    const bodySize = Math.max(this.pose.wristRadius / 0.46, 1);
    const predicted = this.previous.clone().addScaledVector(this.motionVelocity, Math.min(dt, 0.12));
    const innovation = next.position.distanceTo(predicted) / bodySize;
    const radiusChange = Math.abs(Math.log(next.wristRadius / this.pose.wristRadius));
    let rotationInnovation = 0;
    if (oriented && this.previousRotation) {
      const predictedRotation = this.previousRotation.clone(), rate = this.rotationVelocity.length();
      if (rate > 0.001) predictedRotation.premultiply(new Quaternion().setFromAxisAngle(this.rotationVelocity.clone().normalize(), rate * Math.min(dt, 0.1)));
      rotationInnovation = oriented.angleTo(predictedRotation);
    }
    const jump = innovation > 0.35 + Math.min(dt, 0.1) + this.motionVelocity.length()*dt/bodySize*0.3 || radiusChange > 0.12 + dt*0.5;
    this.diagnostics.innovation = { position: innovation, rotation: rotationInnovation, radius: radiusChange };
    if (jump) {
      const pending = this.pendingPose;
      const consistent = pending && time-pending.time < 180 && next.position.distanceTo(pending.position) < bodySize*(0.7+dt*6) && Math.abs(Math.log(next.wristRadius/pending.radius)) < 0.25 && (!oriented || !pending.rotation || oriented.angleTo(pending.rotation) < 0.45+dt*5);
      this.pendingPose = { position: next.position.clone(), radius: next.wristRadius, rotation: oriented?.clone(), time, started: consistent ? pending.started : time, count: consistent ? pending.count+1 : 1 };
      if (this.pendingPose.count < 2 || time-this.pendingPose.started < 50) { this.diagnostics.state = 'outlier'; return false; }
      this.motionVelocity.set(0, 0, 0);
    }
    this.pendingPose = null;
    if (oriented && this.previousRotation && this.previousRotation.angleTo(oriented) > 1.3+dt*4 && (!this.pendingRotation || this.pendingRotation.angleTo(oriented) > 0.45)) {
      this.pendingRotation = oriented.clone(); this.diagnostics.state = 'outlier'; return false;
    }
    this.pendingRotation = null;
    const ratio = next.size / this.pose.size;
    const positionRateLimit = 3 + Math.min(8, this.motionVelocity.length()/bodySize*1.2);
    const motion = next.position.clone().sub(this.previous).multiplyScalar(1 / dt);
    if (motion.length() > bodySize*10) motion.setLength(bodySize*10);
    this.motionVelocity.lerp(motion, cutoffAlpha(dt, 3));
    const velocity = next.position.clone().sub(this.previous).multiplyScalar(1 / dt / Math.max(next.size, 1));
    this.velocity.lerp(velocity, cutoffAlpha(dt, 1.5));
    this.speed = this.velocity.length();
    const filteredPosition = this.pose.position.clone().lerp(next.position, cutoffAlpha(dt, 1.6 + 3.5 * this.speed));
    const step = filteredPosition.sub(this.pose.position);
    if (step.length() > bodySize*positionRateLimit*frameDt) step.setLength(bodySize*positionRateLimit*frameDt);
    this.pose.position.add(step);
    const sizeAlpha = cutoffAlpha(dt, 1.2 + this.speed * 0.6);
    this.pose.size = Math.exp(Math.log(this.pose.size) + sizeAlpha * Math.log(ratio));
    this.pose.wristRadius += (next.wristRadius - this.pose.wristRadius) * sizeAlpha;
    if (oriented) {
      const angle = this.pose.rotation.angleTo(oriented);
      const measured = this.previousRotation ? this.previousRotation.angleTo(oriented) : angle;
      this.angularSpeed += cutoffAlpha(dt, 2) * (Math.min(measured / dt, 12) - this.angularSpeed);
      // Bound one visible step using motion already observed before this frame.
      // A single noisy angle must not instantly boost its own response speed.
      const filtered = this.pose.rotation.clone().slerp(oriented, cutoffAlpha(dt, 1.6 + this.angularSpeed * 0.65));
      const rateLimit = Math.min(6.5, 3 + this.rotationVelocity.length()*1.2);
      this.pose.rotation.rotateTowards(filtered, rateLimit*frameDt);
      if (time-this.lastRotationGood > 220) this.pose.rotation.copy(oriented);
      this.acceptRotation(oriented, time);
    }
    this.previous.copy(next.position); this.lastGood = time;
    return true;
  }
  sample(time) { return this.pose && time - this.lastGood <= 220 && (!this.orientationSign || time-this.lastRotationGood <= 220) ? this.pose : null; }
}
