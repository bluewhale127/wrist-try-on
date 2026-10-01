# Wrist center 05

This locally trained model predicts a single 2D wrist contact point. It does not estimate wrist scale, width, handedness, surface, depth, or 3D orientation. The `wrist-watch.html` experiment uses manual size and orientation controls.

Training: 27 frames from two recordings of one person's wrist, including 15 user-confirmed contact points. Evaluation on these recordings is a training/integration check, not evidence of accuracy on unseen people, cameras, backgrounds or poses. Images and annotation coordinates are not distributed with this runtime.

Input: RGB float32 NCHW `[1,3,192,192]`, integer box downsampling and letterboxing in `center-preprocess.mjs`. Output: `center_heatmap`, 48×48. Decode a weighted 3×3 neighborhood of the peak. Acceptance threshold: 0.55 (a model score, not a calibrated probability).

Model SHA-256: `36b186fd86e5c866082142228c5805bfe8d3ce4a72957c501f37cc4e9f7e6bdc`.

ONNX Runtime Web 1.23.0 is provided under the included MIT license. The inference module and WASM runtime are served locally. Inference runs in a dedicated worker with one WASM thread; no paid API or inference server is required. Camera frames remain in the browser.

The validation page is separate from the existing hand-based application. Stop/restart, seek, and source switching invalidate observations; missing or older-than-350ms observations hide the watch. A newly accepted wrist centre reattaches immediately without hand calibration. Manual controls are stored under `viver-wrist-center-watch-v1`.
