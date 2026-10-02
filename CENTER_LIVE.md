# Wrist center live comparison 1

`wrist-center-live.html` is an isolated, center-only camera experiment. It does not replace the existing watch, GLB or teacher pages, or the VIVER deployment.

- Default: adapted center model 04. Comparison: existing transfer model 01.
- Both use unchanged integer-box preprocessing, rotation consensus and `CenterObservation` temporal acceptance. A rejected candidate is never presented as a green tracked center.
- RGB camera frames are processed locally by ONNX Runtime WASM in a worker. There are no image uploads. JSON diagnostics contain up to 3,000 events with positions, confidence, timing and acquisition state, not image data.
- One inference request at a time; generation checks discard results from earlier camera/model sessions. Camera and worker stop when the page becomes hidden.
- Coordinates share the video's contain layout. Front camera mirrors video and overlay together. Model input remains unmirrored.

## Model provenance and limits

Adapted model checkpoint SHA-256: `53b49829d040c3e5ae64bafcb0dd5a94499edd01cb6fd024f52ffbede7b89c9b`.

Exported ONNX SHA-256: `7b18c30030de50bc815b20772f5b8598d4b169994d88d3054ded830768b0b6d5`.

ONNX opset 17; output parity checked on 272 real-image/orientation inputs, maximum heatmap difference 0.00001723. No new fitting was performed for this export. The latest separate six labeled validation frames were not used for training: 5/6 accepted within 20 source pixels; palm-side error remains in one frame. Older development frames showed regressions. These small static checks do not prove live robustness, performance on other wrists, or correct 3D orientation/scale.

## Mobile check

Use Android Chrome and grant camera access. Start with rear camera and adapted model. Check hand back, side, palm, cropped fingers, vertical wrist, removal and return. Repeat with baseline under the same conditions. Download diagnostics after a failure and record what the green marker did; score is not an accuracy percentage.

Validation: existing 159 tests and static build pass. Browser WASM replay checks cover acquisition, blank rejection, automatic return, selfie mirroring, reset, both model transitions and camera cleanup. Real Android camera testing remains necessary.
