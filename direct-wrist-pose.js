import { Matrix4, Quaternion, Vector3 } from './vendor/three/three.module.js';
import { coverTransform } from './pose.js?v=6';

const modelToWrist = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const alpha = (dt, cutoff) => 1 - Math.exp(-2 * Math.PI * cutoff * dt);

// WebAR.rocks uses +Y for the dorsal surface and Z along the forearm.
// Match our rig's +Z surface normal and +Y forearm axis, then project to CSS pixels.
export function directWristPose(result, view, { mirror = false, scale = 1.2, offset = 0.5 } = {}) {
  if (!result?.solved?.ok || !result.landmarks?.length) return null;
  const { rotation: r, translation: t, repError } = result.solved;
  if (!t || !r || t.length !== 3 || r.length !== 3 || r.some(row => row.length !== 3)) return null;
  if (![...t, ...r.flatMap(row => Array.from(row))].every(Number.isFinite) || t[2] <= 0 || !Number.isFinite(repError)) return null;
  const projectedWidth = result.modelWidth * result.focal / t[2];
  if (projectedWidth < 8 || repError > projectedWidth * 0.12) return null;
  const matrix = new Matrix4().set(-r[0][0], -r[0][1], r[0][2], 0, -r[1][0], -r[1][1], r[1][2], 0, -r[2][0], -r[2][1], r[2][2], 0, 0, 0, 0, 1);
  const rotation = new Quaternion().setFromRotationMatrix(matrix).multiply(modelToWrist).normalize();
  if (mirror) rotation.set(rotation.x, -rotation.y, -rotation.z, rotation.w);
  const fit = coverTransform(result.width, result.height, view.width, view.height);
  const pixelScale = result.focal / t[2] * fit.scale;
  const wristWidth = result.modelWidth * pixelScale;
  const palmWidth = wristWidth / 0.86;
  const position = new Vector3(-t[0] * result.focal / t[2] * fit.scale, -t[1] * result.focal / t[2] * fit.scale, 0);
  if (mirror) position.x *= -1;
  const along = new Vector3(0, 1, 0).applyQuaternion(rotation);
  position.addScaledVector(along, -(offset - 0.5) * wristWidth * 1.5).setZ(0);
  return { position, rotation, size: palmWidth * 0.65 * scale, wristRadius: palmWidth * 0.65 * 0.46,
    quality: clamp(1 - repError / (projectedWidth * 0.12), 0, 1), isRightHand: result.isRightHand, landmarks: result.landmarks };
}

// Translation/scale and rotation have separate acceptance clocks. A questionable
// orientation may hold briefly while measured wrist translation keeps updating.
export class DirectWristTracker {
  constructor() { this.reset(); }
  reset() { this.pose = null; this.lastPosition = -Infinity; this.lastRotation = -Infinity; this.lastInput = -Infinity; this.pending = null; this.pendingOrientation = null; this.orientationSign = 1; this.diagnostics = { state: 'missing', quality: 0 }; }
  update(next, time) {
    if (!Number.isFinite(time) || time <= this.lastInput) return false;
    const dt = clamp((time - this.lastInput) / 1000, 0.001, 0.15); this.lastInput = time;
    if (!next) { this.pending = null; this.diagnostics = { state: 'missing', quality: 0 }; return false; }
    const width = Math.max(1, next.wristRadius / (0.65 * 0.46) * 0.86);
    const lost = !this.pose || time - this.lastPosition > 450;
    if (lost && this.pose && (next.isRightHand !== this.pose.isRightHand || next.wristRadius < this.pose.wristRadius * 0.55 || next.position.distanceTo(this.pose.position) > this.pose.wristRadius / (0.65 * 0.46) * 1.7)) {
      this.pending = null; this.diagnostics = { state: 'target-lost', quality: next.quality }; return false;
    }
    const jump = !lost && (next.position.distanceTo(this.pose.position) > width * 0.65 || Math.abs(Math.log(next.wristRadius / this.pose.wristRadius)) > 0.3 || next.isRightHand !== this.pose.isRightHand);
    if (lost || jump) {
      const previous = this.pending;
      const consistent = previous && time - previous.time < 200 && previous.pose.isRightHand === next.isRightHand && next.position.distanceTo(previous.pose.position) < width * 0.3 && next.rotation.angleTo(previous.pose.rotation) < 0.45;
      this.pending = { pose: next, time, started: consistent ? previous.started : time, count: consistent ? previous.count + 1 : 1 };
      this.diagnostics = { state: 'reacquiring', quality: next.quality };
      if (this.pending.count < 3 || time - this.pending.started < 80) return false;
      if (lost) {
        this.pose = { ...next, position: next.position.clone(), rotation: next.rotation.clone() };
        this.lastPosition = this.lastRotation = time; this.pending = null; this.diagnostics.state = 'tracking'; return true;
      }
    }
    this.pending = null;
    const displacement = next.position.distanceTo(this.pose.position) / width;
    this.pose.position.lerp(next.position, alpha(dt, 2 + Math.min(10, displacement / dt)));
    const sizeAlpha = alpha(dt, 2);
    this.pose.size += (next.size - this.pose.size) * sizeAlpha;
    this.pose.wristRadius += (next.wristRadius - this.pose.wristRadius) * sizeAlpha;
    this.lastPosition = time;
    const angle = this.pose.rotation.angleTo(next.rotation);
    // Large unsupported flips cannot renew the orientation expiry indefinitely.
    if (angle > 1.1 && displacement < 0.08) {
      const p = this.pendingOrientation;
      const consistent = p && time - p.time < 200 && p.rotation.angleTo(next.rotation) < 0.25;
      this.pendingOrientation = { rotation: next.rotation.clone(), time, started: consistent ? p.started : time, count: consistent ? p.count + 1 : 1 };
      if (this.pendingOrientation.count < 3 || time - this.pendingOrientation.started < 120) {
        this.diagnostics = { state: 'orientation-held', quality: next.quality }; return true;
      }
    }
    else this.pendingOrientation = null;
    this.pose.rotation.rotateTowards(next.rotation, Math.min(angle * alpha(dt, 2 + angle / dt * 0.2), 5 * dt));
    this.pose.isRightHand = next.isRightHand;
    this.lastRotation = time; this.diagnostics = { state: 'tracking', quality: next.quality }; return true;
  }
  sample(time) { return this.pose && time - this.lastPosition <= 220 && time - this.lastRotation <= 350 ? this.pose : null; }
}
