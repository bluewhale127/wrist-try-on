import './prepare-assets.mjs';
import { cp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
// Clean only retired build artifacts, including when upgrading an existing dist/.
const actualRoot = await realpath(root), actualOutput = await realpath(output);
if (path.relative(actualRoot, actualOutput) !== 'dist') throw new Error('Build output must remain inside the project.');
for (const name of ['wrist-detector.js', 'direct-wrist-pose.js', 'vendor/wrist']) {
  const target = path.resolve(output, name);
  let actualTarget;
  try { actualTarget = await realpath(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!actualTarget.startsWith(actualOutput + path.sep)) throw new Error('Retired asset is outside dist/.');
  await rm(target, { recursive: true, force: true });
}
for (const name of ['index.html', 'app.js', 'diagnostic-recorder.js', 'fit-settings.js', 'pose.js', 'initial-calibration.js', 'palm-projection.js', 'hand-target.js', 'wrist-rig.js', 'hand-detector.js', 'hand-worker.js', 'rear-assist.js', 'rear-axis.js', 'wrist-flow.js', 'watch.js', 'style.css', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
// Centre-only wrist try-on is a separate validation page, leaving the hand app intact.
for (const name of ['wrist-watch.html', 'wrist-watch.mjs', 'wrist-watch-fit.mjs', 'wrist-watch-diagnostics.mjs', 'wrist-center-live.html', 'wrist-center-live.mjs', 'wrist-center']) {
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
// GLB fitting is a separate mobile experiment. No private training photos are published.
for (const name of ['wrist-glb.html', 'wrist-glb.mjs', 'wrist-glb-placement.mjs', 'wrist-fit-geometry.mjs', 'wrist-glb-center-test.html', 'wrist-glb-center-test.mjs','wrist-model10.html','hand-wrist-center.mjs','wrist-center-client.mjs','wrist-center-continuation.mjs','datejust-bracelet.mjs','watch-size-lock.mjs','wrist-roll-correction.mjs','fist-surface-guard.mjs']) {
  await cp(path.join(root, name), path.join(output, name));
}
// Only active runtime assets are published; retired experiments stay out of the site.
for (const name of ['wrist-teacher.html', 'wrist-teacher.mjs', 'watch-teacher-axes.mjs', 'teacher-capture.mjs', 'teacher-store.mjs']) {
  await cp(path.join(root, name), path.join(output, name));
}
for (const name of ['three', 'vision']) await cp(path.join(root, 'vendor', name), path.join(output, 'vendor', name), { recursive: true });
await cp(path.join(root, 'datejust-ar.glb'), path.join(output, 'datejust-ar.glb'));
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Static site built in dist/.');
