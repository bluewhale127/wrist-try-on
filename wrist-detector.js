// The vendor singleton owns its inference loop; the app owns the camera stream.
let lifecycle = Promise.resolve();

// Evaluate this frame ourselves. The SDK's direction-constrained solver can
// report ok while retaining the previous error when no direction fits.
export function wristReprojectionError(points, imagePoints, solved, focal) {
  if (!solved?.ok || !solved.rotation || !solved.translation) return Infinity;
  const r = solved.rotation, t = solved.translation;
  if (r.length !== 3 || r.some(row => row?.length !== 3) || t.length !== 3 || points.length !== imagePoints.length ||
    ![focal, ...t, ...r.flatMap(row => Array.from(row))].every(Number.isFinite)) return Infinity;
  let error = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, y, z] = points[i];
    // Undo the SDK output's Z-axis convention to recover its camera projection.
    const depth = -r[2][0] * x - r[2][1] * y + r[2][2] * z + t[2];
    if (!(depth > 0)) return Infinity;
    const u = focal * (r[0][0] * x + r[0][1] * y - r[0][2] * z + t[0]) / depth;
    const v = focal * (r[1][0] * x + r[1][1] * y - r[1][2] * z + t[1]) / depth;
    error += Math.hypot(u - imagePoints[i][0], v - imagePoints[i][1]);
  }
  return points.length ? error / points.length : Infinity;
}
export class WristDetector {
  constructor() {
    this.closed = false; this.ready = false; this.api = null; this.canvas = null; this.backend = 'wrist-WebGL';
    this.finished = new Promise(resolve => { this.finish = resolve; });
  }
  async initialize(video, onResult) {
    const previous = lifecycle;
    lifecycle = new Promise(resolve => { this.release = resolve; });
    await previous;
    try {
    if (this.closed) return this;
    const { default: api } = await import('./vendor/wrist/WebARRocksHand.module.js');
    if (this.closed) return this;
    this.api = api;
    let width, height, focal;
    this.canvas = document.createElement('canvas'); this.video = video;
    this.onResize = () => {
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      const nextWidth = Math.max(1, Math.round(video.videoWidth * scale));
      const nextHeight = Math.max(1, Math.round(video.videoHeight * scale));
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth; height = nextHeight;
      this.canvas.width = width; this.canvas.height = height;
      focal = Math.max(width, height) * 0.5 / Math.tan(45 * Math.PI / 360);
      if (this.ready && !this.closed) { api.resize(); api.reset(); }
    };
    this.onResize(); video.addEventListener('resize', this.onResize);
    let objectPoints, modelWidth;
    await new Promise((resolve, reject) => {
      let settled = false;
      api.init({
        canvas: this.canvas, maxHandsDetected: 1, freeZRot: true,
        NNsPaths: [new URL('./vendor/wrist/NN_WRISTBACK_45.json', import.meta.url).href],
        videoSettings: { videoElement: video }, animateDelay: 30,
        scanSettings: { threshold: 0.85, translationScalingFactors: [0.3, 0.3, 1] },
        stabilizationSettings: { switchNNErrorThreshold: 0.7, NNSwitchMask: { isRightHand: true, isFlipped: false } },
        callbackReady: error => {
          if (error) { if (!settled) { settled = true; reject(new Error(String(error))); } return; }
          this.ready = true;
          const points = api.get_LM().map(p => p.position);
          const mean = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
          objectPoints = points.map(p => p.map((v, axis) => v - mean[axis]));
          modelWidth = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
          if (!settled) { settled = true; resolve(); }
        },
        callbackTrack: raw => {
          if (this.closed || !this.ready) return;
          const state = Array.isArray(raw) ? raw[0] : raw;
          const time = performance.now();
          if (!state.isDetected || state.detected < 0.85) { onResult({ detected: state.detected, isDetected: false, solved: null }, time); return; }
          const landmarks = state.landmarks.map(p => p.slice());
          const points = state.isRightHand ? objectPoints : objectPoints.map(p => [-p[0], p[1], p[2]]);
          const imagePoints = landmarks.map(p => [-p[0] * width / 2, -p[1] * height / 2]);
          // Let image geometry solve the pose; temporal acceptance is handled
          // by our tracker instead of the SDK's camera-facing direction lock.
          const rawPose = api.compute_pose(points, imagePoints, focal, focal);
          // The SDK reuses typed arrays on its next frame. Own our diagnostic snapshot.
          const solved = rawPose?.rotation && rawPose?.translation && { ok: rawPose.ok, sdkRepError: rawPose.repError,
            repError: wristReprojectionError(points, imagePoints, rawPose, focal),
            rotation: rawPose.rotation.map(row => Array.from(row)), translation: Array.from(rawPose.translation) };
          onResult({ solved, landmarks, width, height, focal, modelWidth, isRightHand: state.isRightHand, detected: state.detected }, time);
        },
      });
    });
    return this;
    } finally { this.finish(); }
  }
  reset() { if (this.ready && !this.closed) this.api.reset(); }
  close() {
    this.closed = true;
    this.video?.removeEventListener('resize', this.onResize);
    if (!this.closing) this.closing = (async () => {
      await this.finished;
      try { if (this.ready) { this.ready = false; await this.api.destroy(); } }
      catch {} finally { this.release?.(); }
    })();
    return this.closing;
  }
}
