export const FIT_LIMITS = {
  scale: [0.55, 2], offset: [0.1, 0.95], rotation: [-180, 180],
  'tilt-x': [-180, 180], 'tilt-y': [-180, 180], height: [-0.6, 0.8],
  'wrist-width': [0.65, 2], 'wrist-depth': [0.6, 2],
};
export const FIT_CONTROLS = Object.keys(FIT_LIMITS);
export function defaultFit(engine = 'hand') {
  return { scale: engine === 'wrist' ? 1.2 : 1.35, offset: 0.5, rotation: 90,
    'tilt-x': 0, 'tilt-y': 0, height: 0,
    'wrist-width': engine === 'wrist' ? 1 : 1.3,
    'wrist-depth': engine === 'wrist' ? 1 : 1.4, occlusion: true };
}
export function sanitizeFit(value, engine) {
  const result = defaultFit(engine);
  for (const [name, [min, max]] of Object.entries(FIT_LIMITS)) {
    if (typeof value?.[name] === 'number' && Number.isFinite(value[name])) result[name] = Math.max(min, Math.min(max, value[name]));
  }
  if (typeof value?.occlusion === 'boolean') result.occlusion = value.occlusion;
  return result;
}
export class FitSettings {
  constructor(storage) { this.storage = storage; this.key = 'wrist-studio-fit-v7'; }
  read() { try { const data = JSON.parse(this.storage?.getItem(this.key)); return data?.version === 1 ? data : { version: 1, profiles: {} }; } catch { return { version: 1, profiles: {} }; } }
  load(engine, model = 'sample') { return sanitizeFit(this.read().profiles?.[`${engine}:${model}`], engine); }
  save(engine, model, value) {
    try {
      const data = this.read(); data.profiles ||= {};
      delete data.profiles[`${engine}:${model}`];
      data.profiles[`${engine}:${model}`] = sanitizeFit(value, engine);
      const entries = Object.entries(data.profiles).slice(-20);
      this.storage?.setItem(this.key, JSON.stringify({ version: 1, profiles: Object.fromEntries(entries) }));
      return !!this.storage;
    } catch { return false; }
  }
}
