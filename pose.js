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

export function estimateWristPose(landmarks, view, { mirror = false, offset = 0.38, scale = 1 } = {}) {
  if (!landmarks || landmarks.length !== 21) return null;
  const ids = [0, 5, 9, 17];
  if (ids.some(i => !Number.isFinite(landmarks[i].x) || !Number.isFinite(landmarks[i].y) || !Number.isFinite(landmarks[i].z))) return null;
  const [wrist, index, middle, pinky] = ids.map(i => landmarkPoint(landmarks[i], view, mirror));
  const along = middle.clone().sub(wrist);
  const palmLength = along.length();
  const across = index.clone().sub(pinky);
  const palmWidth = across.length();
  if (palmLength < 12 || palmWidth < 12) return null;
  const yAxis = along.normalize();
  const xAxis = across.addScaledVector(yAxis, -across.dot(yAxis));
  if (xAxis.length() < 8) return null;
  xAxis.normalize();
  const zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize();
  // Back-of-hand use only. Reject near-edge-on poses before the face-facing convention flips.
  if (Math.abs(zAxis.z) < 0.22) return null;
  if (zAxis.z < 0) { xAxis.negate(); zAxis.negate(); }
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis));
  const position = wrist.clone().addScaledVector(yAxis, -palmLength * offset);
  // Relative visual fit; no claim of metric measurement from a monocular camera.
  const size = palmWidth * 0.65 * scale;
  position.z = 0;
  return { position, rotation, size };
}

export function smoothingAlpha(elapsedSeconds, response = 16) {
  return 1 - Math.exp(-Math.min(0.1, Math.max(0, elapsedSeconds)) * response);
}
