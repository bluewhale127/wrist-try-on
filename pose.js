import { Matrix4, Quaternion, Vector3 } from './vendor/three/three.module.js';

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
  let thumbUsed = false;
  if (worldLandmarks?.length === 21 && PALM.every(i => finitePoint(worldLandmarks[i]))) {
    const worldPoint = i => {
      const p = worldLandmarks[i]; return new Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
    };
    const world = PALM.map(worldPoint);
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
  return { position, rotation, size, wristRadius: palmWidth * 0.65 * 0.46, heading, rotationQuality, thumbUsed };
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
    this.orientationSign = 0; this.angularSpeed = 0; this.reference = null; this.referenceFrames = 0;
  }
  orientedRotation(next) {
    if (next.rotationQuality < 0.5) return null;
    if (!this.orientationSign) {
      const normalZ = Z.clone().applyQuaternion(next.rotation).z;
      // Initial reference must show the back of the hand; keep this sign through later rotations and gaps.
      if (Math.abs(normalZ) < 0.35) { this.reference = null; this.referenceFrames = 0; return null; }
      if (!this.reference || this.reference.angleTo(next.rotation) > 0.45) {
        this.reference = next.rotation.clone(); this.referenceFrames = 1; return null;
      }
      this.reference.slerp(next.rotation, 0.5);
      if (++this.referenceFrames < 3) return null;
      this.orientationSign = normalZ >= 0 ? 1 : -1;
    }
    return this.orientationSign === 1 ? next.rotation.clone() : next.rotation.clone().multiply(halfTurn);
  }
  update(next, time) {
    if (!next || !Number.isFinite(time)) return false;
    const oriented = this.orientedRotation(next);
    if (!this.pose || time - this.lastGood > 250) {
      this.pose = { ...next, position: next.position.clone(), rotation: next.rotation.clone() };
      this.pose.rotation.copy(oriented || new Quaternion().setFromAxisAngle(Z, next.heading));
      this.previous = next.position.clone(); this.lastGood = time; this.speed = 0; this.velocity.set(0, 0, 0); this.pending = null;
      this.pendingRotation = null; this.angularSpeed = 0;
      return true;
    }
    const dt = clamp((time - this.lastGood) / 1000, 0.001, 0.25);
    const distance = next.position.distanceTo(this.pose.position) / this.pose.size;
    const ratio = next.size / this.pose.size;
    const jump = distance > 0.65 + dt * 9 || ratio > 1.65 || ratio < 0.6;
    if (jump && (!this.pending || next.position.distanceTo(this.pending.position) > next.size * 0.6 || Math.abs(Math.log(next.size / this.pending.size)) > 0.25)) {
      this.pending = next; return false;
    }
    this.pending = null;
    const velocity = next.position.clone().sub(this.previous).multiplyScalar(1 / dt / Math.max(next.size, 1));
    this.velocity.lerp(velocity, cutoffAlpha(dt, 1.5));
    this.speed = this.velocity.length();
    this.pose.position.lerp(next.position, cutoffAlpha(dt, 1.6 + 3.5 * this.speed));
    const sizeAlpha = cutoffAlpha(dt, 1.2 + this.speed * 0.6);
    this.pose.size = Math.exp(Math.log(this.pose.size) + sizeAlpha * Math.log(ratio));
    this.pose.wristRadius += (next.wristRadius - this.pose.wristRadius) * sizeAlpha;
    if (oriented) {
      const angle = this.pose.rotation.angleTo(oriented);
      const jump = angle > 1.3 + dt * 4;
      if (jump && (!this.pendingRotation || this.pendingRotation.angleTo(oriented) > 0.45)) {
        this.pendingRotation = oriented;
      } else {
        this.pendingRotation = null;
        this.angularSpeed += cutoffAlpha(dt, 2) * (Math.min(angle / dt, 12) - this.angularSpeed);
        this.pose.rotation.slerp(oriented, cutoffAlpha(dt, 2 + this.angularSpeed * 0.8));
      }
    }
    this.previous.copy(next.position); this.lastGood = time;
    return true;
  }
  sample(time) { return this.pose && time - this.lastGood <= 220 ? this.pose : null; }
}
