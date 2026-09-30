# Third-party components

## Three.js

- Version: 0.180.0
- Source: https://github.com/mrdoob/three
- Package: https://www.npmjs.com/package/three/v/0.180.0
- License: MIT; included at `vendor/three/LICENSE`.
- The included Draco decoding files originate from the Three.js package's `examples/jsm/libs/draco/gltf` directory; retain the notices in those files. Draco project: https://github.com/google/draco (Apache-2.0).

## MediaPipe Tasks Vision

- Version: 0.10.32
- Source: https://github.com/google-ai-edge/mediapipe
- Package: https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.32
- License: Apache-2.0; included at `vendor/vision/LICENSE`.
- JavaScript bundle and WASM files are copied from that package.
- Hand Landmarker model, float16, version 1: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Model documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker

## Original reference project

- Project reviewed: https://github.com/VeinSyct/Wrist-AR
- Commit reviewed: b21e71ae69edeafab22da277b27f4b8282254bb2
- No reference-project SDK binaries, license keys, watch assets, or custom source files are redistributed here. The reference's DeepAR dependency is not part of this prototype.

The bundled sample watch is procedural geometry authored for this prototype. It contains no brand logos or third-party watch assets.
