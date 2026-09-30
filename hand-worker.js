// Classic worker: the WASM loader uses importScripts, which module workers disallow.
let detector, captureGray;
const grayHolder={};
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const { FilesetResolver, HandLandmarker } = await import('./vendor/vision/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks(new URL('./vendor/vision/wasm/', self.location.href).href);
      const options = {
        canvas: new OffscreenCanvas(1, 1),
        baseOptions: { modelAssetPath: new URL('./vendor/vision/hand_landmarker.task', self.location.href).href, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      };
      let delegate = 'GPU';
      try { detector = await HandLandmarker.createFromOptions(files, options); }
      catch {
        delegate = 'CPU'; options.baseOptions.delegate = 'CPU'; options.canvas = new OffscreenCanvas(1, 1);
        detector = await HandLandmarker.createFromOptions(files, options);
      }
      self.postMessage({ id: data.id, backend: `worker-${delegate}` });
    } else if (data.type === 'frame') {
      const started = performance.now();
      let gray=null;
      if(data.captureGray){
        captureGray ||= (await import('./wrist-flow.js?v=75')).grayFrame;
        try { gray=captureGray(data.frame,grayHolder); } catch { /* Hand tracking can continue without the optional bridge. */ }
      }
      const result = detector.detectForVideo(data.frame, data.time);
      self.postMessage({ id: data.id, result, gray, elapsed: performance.now() - started },gray?[gray.data.buffer]:[]);
    }
  } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }); }
  finally { data.frame?.close(); }
};
