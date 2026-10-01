import { Matrix4, Quaternion, Vector3 } from './vendor/three/three.module.js';
import { fitPalmProjection } from './palm-projection.js?v=5';

import { InitialCalibration } from './initial-calibration.js?v=78';

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
  const observed = PALM.map(i => landmarkPoint(landmarks[i], view, mirror));
  const screen = observed.map(p => p.clone().setZ(0));
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
  // Normalized landmark depth and world depth come from the same model. Their
  // agreement is a consistency check, not an independent depth measurement.
  let depthRotation = null;
  {
    const dy = observed.slice(1).reduce((sum,p)=>sum.add(p),new Vector3()).multiplyScalar(0.25).sub(observed[0]);
    const dx = observed[1].clone().sub(observed[4]);
    if (dy.length() > 12) {
      dy.normalize(); dx.addScaledVector(dy,-dx.dot(dy));
      if (dx.length() > 8) {
        dx.normalize();
        const normal = new Vector3().crossVectors(dx,dy).normalize();
        depthRotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(dx,dy,normal));
      }
    }
  }
  const allPoints = landmarks.every(finitePoint) ? landmarks.map(p=>landmarkPoint(p,view,mirror)) : [];
  const inFrame = allPoints.length === 21 && allPoints.every(p=>Math.abs(p.x)<view.width*.48 && Math.abs(p.y)<view.height*.48);
  // Geometric eligibility, not an occlusion classifier: inferred landmarks
  // can still be wrong. Require extended fingers only while learning a palm.
  const open = allPoints.length === 21 && [5,9,13,17].every(i=>
    allPoints[i+3].clone().sub(allPoints[i]).dot(y2) > projectedLength*.25);
  return { calibration: {inFrame,open}, position, rotation, size, wristRadius: palmWidth * 0.65 * 0.46, heading, rotationQuality, thumbUsed, imagePalm: screen, worldPalm, userScale: scale, mirror, depthRotation };
}

// Rotate the case around the wrist centre, not around the centre of the dial.
export function wristSurfacePosition(center, rotation, radius) {
  return new Vector3(0, 0, radius).applyQuaternion(rotation).add(center);
}

// Raw palm +X points toward the thumb. The dorsal-frame half turn can reverse
// that axis (opposite hand or selfie reflection). Keep 6 o'clock on the thumb
// side using the sign fixed at calibration, never a noisy per-frame label.
export function watchRotationDegrees(rotation, orientationSign = 1) {
  return rotation + (orientationSign === -1 ? 180 : 0);
}

export function smoothingAlpha(elapsedSeconds, response = 16) {
  return 1 - Math.exp(-Math.min(0.1, Math.max(0, elapsedSeconds)) * response);
}

function cutoffAlpha(dt, hz) { return 1 - Math.exp(-2 * Math.PI * hz * dt); }

// Adaptive filtering: steady hands get stronger smoothing, moving hands respond quickly.
// Hold only brief gaps; never extrapolate a watch indefinitely after a hand leaves the frame.
export class WristPoseTracker {
  constructor() { this.reset(); }
  get watchOrientationSign() {
    // A bad initial world frame can unproject the thumb into template -X.
    // The observed template ordering, not the world frame alone, decides
    // which side of the final dorsal frame the six-o'clock marker belongs on.
    const radial = this.template ? this.template[1].x-this.template[4].x : 1;
    return (this.orientationSign || 1) * (radial < 0 ? -1 : 1);
  }
  reset() {
    this.pose = null; this.previous = null; this.lastGood = -Infinity; this.speed = 0;
    this.velocity = new Vector3(); this.pending = null; this.pendingRotation = null;
    this.motionVelocity = new Vector3(); this.pendingPose = null;
    this.orientationSign = 0; this.angularSpeed = 0; this.initialCalibration = new InitialCalibration(); this.template = null;
    this.calibrationRotation = null; this.calibrationHeading = 0;
    this.lastRotationGood = -Infinity; this.lastInput = -Infinity;
    this.previousRotation = null; this.rotationVelocity = new Vector3(); this.recovery = null; this.branchEvidence = null;
    this.surfaceEvidence = null; this.turnEvidence = null;
    this.depthEvidence = null; this.depthBlocked = false;
    this.diagnostics = { state: 'calibrating', quality: 0, progress: 0 };
  }
  orientedRotation(next, time) {
    this.diagnostics = { state: 'uncertain', quality: 0, progress: this.orientationSign ? 1 : 0 };
    if (!this.orientationSign) {
      const initial = this.initialCalibration.update(next,time);
      this.diagnostics = {state:'calibrating', quality:0, progress:initial.progress, reason:initial.reason};
      if (!initial.ready) return null;
      this.orientationSign = Z.clone().applyQuaternion(initial.rotation).z >= 0 ? 1 : -1;
      this.calibrationRotation = initial.rotation;
      if (this.orientationSign === -1) this.calibrationRotation.multiply(halfTurn);
      this.calibrationHeading = next.heading;
      this.template = initial.template;
      this.initialCalibration.reset();
      // Discard provisional position history before the first visible pose.
      this.pose = null;
    }
    if (next.rotationQuality < 0.5) { this.branchEvidence = null; this.surfaceEvidence = null; this.depthEvidence = null; this.turnEvidence = null; return null; }
    const projection = fitPalmProjection(this.template, next.imagePalm);
    if (!projection) { this.surfaceEvidence = null; this.depthEvidence = null; this.turnEvidence = null; return null; }
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
    const fittedNormalZ = projection.normalZ*this.orientationSign;
    const rawNormalZ = Z.clone().applyQuaternion(raw).z;
    const depth = next.depthRotation?.clone();
    if (depth && this.orientationSign === -1) depth.multiply(halfTurn);
    // A missing turnaround observation can return to the same last-seen angle.
    // Requiring an already observed reverse delta would then accept the wrong
    // predicted branch before this guard can run. Hold a corroborated branch
    // conflict even without that delta. Do not feed it back into velocity.
    // Allow bounded depth bias; both outputs must agree with each other and
    // clearly prefer the same candidate across observations, not just fit it.
    let turnPending = false, turnRealigned = false;
    const turn = this.turnEvidence;
    const continuingTurn = turn && time-turn.time <= 160 && rawChoice.angleTo(turn.rotation) < Math.min(1.05,.2+(time-turn.time)*.018);
    // Only an ongoing, fresh confirmation may extend beyond the initial gate.
    // This does not extend the visible-pose deadline or carry votes across loss.
    const recentTurn = age <= 220 || (continuingTurn && age <= 600);
    const turnConflict = !next.mirror && previous && recentTurn && speed > 1.2 && depth && quality >= .8 &&
      rawChoice !== rotation && raw.angleTo(depth) < .6 &&
      rawChoice.angleTo(raw) < .6 && rawChoice.angleTo(depth) < .6 &&
      rotation.angleTo(raw)-rawChoice.angleTo(raw) > .25 && rotation.angleTo(depth)-rawChoice.angleTo(depth) > .25;
    if (turnConflict) {
      this.turnEvidence = { rotation:rawChoice.clone(), time, started:continuingTurn?turn.started:time, count:continuingTurn?turn.count+1:1 };
      if (this.turnEvidence.count >= 2 && time-this.turnEvidence.started >= 50) {
        rotation = rawChoice; branchConfirmed = true; turnRealigned = true; this.turnEvidence = null;
      } else turnPending = true;
    } else this.turnEvidence = null;
    // Re-localize at either broad surface only when image geometry and world
    // pose agree for several frames. Side views, curls, a single bad frame,
    // or changing depth branches cannot provide this independent reference.
    const surface = fittedNormalZ >= 0 ? 'back' : 'palm';
    const clearSurface = quality >= 0.85 && Math.abs(fittedNormalZ) >= 0.86 && Math.abs(rawNormalZ) >= 0.75 && fittedNormalZ*rawNormalZ > 0 && rawChoice.angleTo(raw) < 0.35;
    if (clearSurface) {
      const evidence = this.surfaceEvidence;
      const stable = evidence && evidence.surface === surface && time-evidence.time <= 180 && evidence.rotation.angleTo(rawChoice) < 0.18 && evidence.position.distanceTo(next.position) < next.wristRadius/0.46*0.3;
      this.surfaceEvidence = { surface, rotation:rawChoice.clone(), position:next.position.clone(), time, started:stable?evidence.started:time, count:stable?evidence.count+1:1 };
    } else this.surfaceEvidence = null;
    const surfaceConfirmed = !!this.surfaceEvidence && this.surfaceEvidence.count >= 4 && time-this.surfaceEvidence.started >= 300;
    const surfaceRealigned = surfaceConfirmed && rotation.angleTo(rawChoice) > 0.35;
    if (surfaceRealigned) { rotation = rawChoice; branchConfirmed = true; }
    // A biased reference palm may keep the two image solutions apart even at
    // a real turning point. The old near-previous gate then locks in the wrong
    // depth branch. Front cameras can reselect it from sustained, unambiguous
    // agreement of both depth outputs; one frame cannot reverse the watch.
    let depthPending = false, depthRealigned = false;
    const other = candidates.find(q=>q!==rawChoice);
    const evidence = this.depthEvidence;
    const depthConflict = next.mirror && depth && previous && !clearSurface && quality >= 0.45 &&
      (age <= 180 || (evidence && time-evidence.time <= 180 && age <= 600)) &&
      rotation !== rawChoice && rawChoice.angleTo(raw) < 0.65 &&
      other.angleTo(raw)-rawChoice.angleTo(raw) > 0.4 &&
      rawChoice.angleTo(depth) < 0.7 && other.angleTo(depth)-rawChoice.angleTo(depth) > 0.3;
    if (depthConflict) {
      const stable = evidence && time-evidence.time <= 180 && evidence.rotation.angleTo(rawChoice) < 0.3+(time-evidence.time)*0.006;
      this.depthEvidence = {rotation:rawChoice.clone(),time,started:stable?evidence.started:time,count:stable?evidence.count+1:1};
      const confirmed = this.depthEvidence.count >= 3 && time-this.depthEvidence.started >= 180;
      // Hide before a large reattachment instead of visibly sweeping the dial
      // through the wrist. The first contradictory frame only holds the pose.
      if (this.depthEvidence.count >= 2 && rawChoice.angleTo(previous) > 0.7) this.depthBlocked = true;
      if (confirmed) { rotation = rawChoice; branchConfirmed = true; depthRealigned = true; }
      else depthPending = true;
    } else { this.depthEvidence = null; this.depthBlocked = false; }
    const disagreement = rotation.angleTo(raw);
    this.diagnostics = { state: quality < 0.35 ? 'uncertain' : disagreement > 0.6 ? 'corrected' : 'tracking',
      quality, progress: 1, residual: projection.residual, disagreement, rawNormalZ,
      fittedNormalZ, surface:Math.abs(fittedNormalZ)>=0.86?surface:'edge', surfaceConfirmed, surfaceRealigned,
      memoryAgeMs: Number.isFinite(age) ? age : null, branchConfirmed,
      depthPending, depthRealigned, depthEvidenceFrames:this.depthEvidence?.count || 0,
      turnPending, turnRealigned, turnEvidenceFrames:this.turnEvidence?.count || 0 };
    if (quality < 0.35) { this.recovery = null; this.branchEvidence = null; this.surfaceEvidence = null; return null; }
    if (depthPending) { this.diagnostics.state = 'depth-check'; return null; }
    if (turnPending) { this.diagnostics.state = 'turn-check'; return null; }
    if (this.previousRotation && age > 220) {
      const longGap = age > 1500;
      const separated = candidates[0].angleTo(candidates[1]) > 0.5;
      const ambiguous = previous && separated && Math.abs(candidates[0].angleTo(previous) - candidates[1].angleTo(previous)) < 0.12;
      const tooFar = previous && rotation.angleTo(previous) > Math.min(1.2, 0.45 + age * 0.001);
      // Preserve the existing dorsal recovery, and also admit a confirmed
      // palm-facing anchor. Its dial stays on the back of the wrist, occluded.
      const backFacing = this.diagnostics.fittedNormalZ > 0.55 && this.diagnostics.rawNormalZ > 0.5;
      const nearReference = rotation.angleTo(recoveryReference) < 0.65 || this.diagnostics.fittedNormalZ > 0.95;
      if (!surfaceConfirmed && !depthRealigned && ((longGap && (!backFacing || !nearReference)) || ambiguous || tooFar)) {
        this.recovery = null; this.diagnostics.state = 'reorient'; return null;
      }
      if (!this.recovery || time-this.recovery.time > 200 || this.recovery.rotation.angleTo(rotation) > 0.3) {
        this.recovery = { rotation: rotation.clone(), started: time, time, count: 1 };
      } else { this.recovery.rotation.copy(rotation); this.recovery.time = time; this.recovery.count++; }
      this.diagnostics.state = longGap ? 'reorient' : 'reacquiring';
      if (!surfaceConfirmed && !depthRealigned && (this.recovery.count < 3 || time-this.recovery.started < (longGap ? 250 : 60))) return null;
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
    this.depthBlocked = false;
  }
  update(next, time) {
    if (!Number.isFinite(time) || time <= this.lastInput) return false;
    const frameDt = clamp((time-this.lastInput)/1000, 0.001, 0.1);
    this.lastInput = time;
    if (!next) { if (!this.orientationSign) this.initialCalibration.reset(); this.branchEvidence = null; this.surfaceEvidence = null; this.depthEvidence = null; this.turnEvidence = null; this.diagnostics = { state: 'missing', quality: 0, progress: this.orientationSign ? 1 : 0 }; return false; }
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
    const depthReset = this.diagnostics.depthRealigned && this.depthBlocked;
    if (!depthReset && !this.diagnostics.turnRealigned && oriented && this.previousRotation && this.previousRotation.angleTo(oriented) > 1.3+dt*4 && (!this.pendingRotation || this.pendingRotation.angleTo(oriented) > 0.45)) {
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
      if (time-this.lastRotationGood > 220 || depthReset) this.pose.rotation.copy(oriented);
      if (depthReset) { this.previousRotation = null; this.rotationVelocity.set(0,0,0); this.angularSpeed = 0; }
      if (this.diagnostics.turnRealigned) this.rotationVelocity.set(0,0,0);
      this.acceptRotation(oriented, time);
    }
    this.previous.copy(next.position); this.lastGood = time;
    return true;
  }
  sample(time) { return !this.depthBlocked && this.pose && time - this.lastGood <= 220 && (!this.orientationSign || time-this.lastRotationGood <= 220) ? this.pose : null; }
}
