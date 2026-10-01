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
// Only active runtime assets are published; retired experiments stay out of the site.
for (const name of ['three', 'vision']) await cp(path.join(root, 'vendor', name), path.join(output, 'vendor', name), { recursive: true });
await cp(path.join(root, 'datejust-ar.glb'), path.join(output, 'datejust-ar.glb'));
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Static site built in dist/.');
