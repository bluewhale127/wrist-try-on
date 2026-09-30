export class HandDetector {
  constructor() { this.worker = null; this.main = null; this.pending = new Map(); this.sequence = 0; this.backend = ''; }
  async initialize() {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        this.worker = new Worker(new URL('./hand-worker.js?v=75', import.meta.url));
        this.worker.onmessage = ({ data }) => {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(data.id);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data);
        };
        this.worker.onerror = () => this.stopWorker(new Error('Tracking worker unavailable'));
        const ready = await this.request({ type: 'init' }, [], 30000);
        this.backend = ready.backend;
        return this;
      } catch { this.stopWorker(); }
    }
    await this.initializeMain();
    return this;
  }
  request(message, transfer = [], timeout = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Tracking timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ ...message, id }, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  stopWorker(error = new Error('Tracking worker closed')) {
    this.worker?.terminate(); this.worker = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  async initializeMain() {
    const { FilesetResolver, HandLandmarker } = await import('./vendor/vision/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks(new URL('./vendor/vision/wasm/', import.meta.url).href);
    const options = {
      baseOptions: { modelAssetPath: new URL('./vendor/vision/hand_landmarker.task', import.meta.url).href, delegate: 'GPU' },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    };
    try { this.main = await HandLandmarker.createFromOptions(files, options); this.backend = 'main-GPU'; }
    catch { options.baseOptions.delegate = 'CPU'; this.main = await HandLandmarker.createFromOptions(files, options); this.backend = 'main-CPU'; }
  }
  async detect(video, time, {captureGray=false}={}) {
    if (this.worker) {
      let frame;
      try {
        const w = video.videoWidth || video.width, h = video.videoHeight || video.height;
        const scale = Math.min(1, 640 / Math.max(w, h));
        frame = await createImageBitmap(video, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)), resizeQuality: 'low' });
        return await this.request({ type: 'frame', frame, time, captureGray }, [frame]);
      } catch {
        frame?.close(); this.stopWorker(); await this.initializeMain();
      }
    }
    const started = performance.now();
    let gray=null;
    if(captureGray){
      this.grayCapture ||= (await import('./wrist-flow.js?v=75')).grayFrame;
      this.grayHolder ||= {};
      try { gray=this.grayCapture(video,this.grayHolder); } catch { /* Optional camera pixels are unavailable. */ }
    }
    const result = this.main.detectForVideo(video, time);
    return { result, gray, elapsed: performance.now() - started };
  }
  close() { this.stopWorker(); this.main?.close(); this.main = null; }
}
