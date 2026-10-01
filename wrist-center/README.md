# Wrist center 06 — validation experiment

Predicts one 2D wrist contact point. Scale, width, handedness, surface, depth and 3D orientation are not estimated. `wrist-watch.html` provides manual size and orientation controls.

Training: 31 frames (27 existing plus 4 from a new environment), including 19 user-confirmed centers. Two additional user-confirmed frames were excluded from training. They share the new recording with training frames and are development checks, not independent tests. Their errors are 31.43 and 25.15 pixels at 406×720. The user accepted these known limitations for experimental deployment. No images or annotation coordinates are published.

Original/augmented training inputs include mirroring, rotation, center-preserving aspect crops, brightness, contrast, saturation, channel gains, gamma, blur and noise. Background-only training patches include the new scene. Acceptance remains 0.55; it is not a calibrated probability.

The deployed model has a versioned filename `center-net-06.onnx`, loaded by `center-worker-06.mjs`, so old cached model 05 files cannot substitute for it. Model 05 and its worker remain available at their original filenames.

Model 06 SHA-256: `6a7675c798fae61a8ab2e7b355e6d7320db8eb4f3c74ddbfbc7e7c242caaf546`.

Input: RGB float32 NCHW `[1,3,192,192]`, integer-box downsampling and letterboxing in `center-preprocess.mjs`. Output: `center_heatmap`, 48×48, decoded using a weighted 3×3 peak neighborhood.

ONNX Runtime Web 1.23.0 uses the included MIT license. Inference runs locally in a dedicated single-threaded WASM worker. Camera frames remain in the browser. An explicit diagnostic photo action creates a local download only.

This page is separate from the stable hand-based application. Missing or older-than-350ms observations hide the watch; a new accepted center reattaches without hand calibration. Size and orientation settings use `viver-wrist-center-watch-v1` storage.
