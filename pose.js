import { Euler, Quaternion, Vector3 } from './vendor/three/three.module.js';

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
const rotationFrom = (heading, pitch, yaw) => new Quaternion().setFromEuler(new Euler(pitch, yaw, heading, 'ZXY'));

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
  const y2 = along.clone().normalize(), x2 = new Vector3(y2.y, -y2.x, 0);
  const heading = Math.atan2(-y2.x, y2.y);
  let palmWidth = index.distanceTo(pinky), pitch = 0, yaw = 0, tiltQuality = 0;
  if (worldLandmarks?.length === 21 && PALM.every(i => finitePoint(worldLandmarks[i]))) {
    const world = PALM.map(i => {
      const p = worldLandmarks[i]; return new Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
    });
    const wy = world[1].clone().add(world[2]).add(world[3]).add(world[4]).multiplyScalar(0.25).sub(world[0]);
    const wx = world[1].clone().sub(world[4]);
    if (wy.length() > 0.005 && wx.length() > 0.005) {
      wy.normalize(); wx.addScaledVector(wy, -wx.dot(wy));
      if (wx.length() > 0.005) {
        wx.normalize();
        if (wx.dot(x2) < 0) wx.negate();
        const normal = new Vector3().crossVectors(wx, wy).normalize();
        tiltQuality = clamp((Math.abs(normal.z) - 0.12) / 0.43, 0, 1);
        // Keep the in-plane heading independent of an ambiguous palm normal.
        // Conservative tilt is intentional: no 180-degree hemisphere flip at edge-on views.
        pitch = clamp(Math.asin(clamp(wy.z, -1, 1)), -0.85, 0.85);
        yaw = clamp(Math.atan2(-wx.z, Math.hypot(wx.x, wx.y)), -0.95, 0.95);
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
  return { position, rotation: rotationFrom(heading, pitch, yaw), size, heading, pitch, yaw, tiltQuality };
}

export function smoothingAlpha(elapsedSeconds, response = 16) {
  return 1 - Math.exp(-Math.min(0.1, Math.max(0, elapsedSeconds)) * response);
}

function cutoffAlpha(dt, hz) { return 1 - Math.exp(-2 * Math.PI * hz * dt); }
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Adaptive filtering: steady hands get stronger smoothing, moving hands respond quickly.
// Hold only brief gaps; never extrapolate a watch indefinitely after a hand leaves the frame.
export class WristPoseTracker {
  constructor() { this.reset(); }
  reset() { this.pose = null; this.previous = null; this.lastGood = -Infinity; this.speed = 0; this.velocity = new Vector3(); this.pending = null; }
  update(next, time) {
    if (!next || !Number.isFinite(time)) return false;
    if (!this.pose || time - this.lastGood > 250) {
      this.pose = { ...next, position: next.position.clone(), rotation: next.rotation.clone() };
      this.pose.pitch = next.tiltQuality >= 0.3 ? next.pitch : 0;
      this.pose.yaw = next.tiltQuality >= 0.3 ? next.yaw : 0;
      this.pose.rotation.copy(rotationFrom(next.heading, this.pose.pitch, this.pose.yaw));
      this.previous = next.position.clone(); this.lastGood = time; this.speed = 0; this.velocity.set(0, 0, 0); this.pending = null;
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
    this.pose.size = Math.exp(Math.log(this.pose.size) + cutoffAlpha(dt, 1.2 + this.speed * 0.6) * Math.log(ratio));
    this.pose.heading += angleDelta(next.heading, this.pose.heading) * cutoffAlpha(dt, 3 + this.speed);
    if (next.tiltQuality >= 0.3) {
      const alpha = cutoffAlpha(dt, 1.3);
      const limit = 2.6 * dt;
      this.pose.pitch += clamp((next.pitch - this.pose.pitch) * alpha, -limit, limit);
      this.pose.yaw += clamp((next.yaw - this.pose.yaw) * alpha, -limit, limit);
    }
    this.pose.rotation.copy(rotationFrom(this.pose.heading, this.pose.pitch, this.pose.yaw));
    this.previous.copy(next.position); this.lastGood = time;
    return true;
  }
  sample(time) { return this.pose && time - this.lastGood <= 220 ? this.pose : null; }
}
