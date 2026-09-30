import './prepare-assets.mjs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'app.js', 'pose.js', 'palm-projection.js', 'hand-detector.js', 'hand-worker.js', 'watch.js', 'style.css', 'vendor', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Static site built in dist/.');
