// Opt-in, memory-only capture. Never silently discard the beginning of a test.
export class DiagnosticRecorder {
  constructor({ maxDurationMs = 120000, maxFrames = 3600, maxRenders = 7200, maxEvents = 500 } = {}) {
    Object.assign(this, { maxDurationMs, maxFrames, maxRenders, maxEvents });
    this.clear();
  }
  clear() {
    this.active = false;
    this.frames = []; this.renders = []; this.events = [];
    this.activeMs = 0; this.segmentStart = null; this.startedAt = null;
    this.stopReason = null; this.full = false;
    this.visibleRenders = 0; this.calibratedFrames = 0;
    this.lastRenderTime = -Infinity; this.lastVisible = null;
  }
  start(time, context = {}) {
    if (this.active || this.full) return false;
    this.active = true; this.segmentStart = time; this.stopReason = null;
    this.startedAt ??= new Date().toISOString();
    this.event(time, 'recording-start', context);
    return true;
  }
  stop(time, reason = 'user') {
    if (!this.active) return;
    this.activeMs += Math.max(0, time - this.segmentStart);
    this.active = false; this.segmentStart = null; this.stopReason = reason;
    // Reserve the final event for an explicit stop, including capacity stops.
    this.events.push({ time, type: 'recording-stop', reason });
  }
  duration(time) { return this.activeMs + (this.active ? Math.max(0, time - this.segmentStart) : 0); }
  ready(time) {
    if (!this.active) return false;
    if (this.duration(time) >= this.maxDurationMs) {
      this.full = true; this.stop(time, 'duration-limit'); return false;
    }
    return true;
  }
  capacity(time, count, limit) {
    if (count < limit) return true;
    this.full = true; this.stop(time, 'capacity-limit'); return false;
  }
  event(time, type, detail = {}) {
    if (!this.ready(time) || !this.capacity(time, this.events.length, this.maxEvents - 1)) return;
    this.events.push(structuredClone({ time, type, ...detail }));
  }
  recordFrame(frame, completedTime = frame.time) {
    if (!this.ready(completedTime) || !this.capacity(completedTime, this.frames.length, this.maxFrames)) return;
    this.frames.push(structuredClone(frame));
    if (frame.orientationSign) this.calibratedFrames++;
  }
  recordRender(sample) {
    if (!this.ready(sample.time)) return;
    // Visibility transitions must survive sampling, including a one-frame disappearance.
    if (sample.time - this.lastRenderTime < 1000 / 30 && sample.watchVisible === this.lastVisible) return;
    if (!this.capacity(sample.time, this.renders.length, this.maxRenders)) return;
    this.renders.push(structuredClone(sample));
    if (sample.watchVisible) this.visibleRenders++;
    this.lastRenderTime = sample.time; this.lastVisible = sample.watchVisible;
  }
  summary(time) {
    return { active: this.active, full: this.full, stopReason: this.stopReason,
      durationMs: this.duration(time), frames: this.frames.length, renderSamples: this.renders.length,
      calibratedFrames: this.calibratedFrames, visibleWatchSamples: this.visibleRenders };
  }
  export(time, metadata = {}) {
    return structuredClone({ ...metadata, schemaVersion: 2, recordedAt: new Date().toISOString(),
      startedAt: this.startedAt, summary: this.summary(time),
      limits: { durationMs: this.maxDurationMs, frames: this.maxFrames, renderSamples: this.maxRenders, events: this.maxEvents },
      frames: this.frames, renders: this.renders, events: this.events });
  }
}
