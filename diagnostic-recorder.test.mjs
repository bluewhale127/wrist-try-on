import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticRecorder } from './diagnostic-recorder.js';

test('recording is opt-in and camera resets preserve earlier attached-watch evidence', () => {
  const r = new DiagnosticRecorder();
  r.recordFrame({ time: 0, orientationSign: 1 });
  assert.equal(r.frames.length, 0);
  r.start(10, { orientationSign: 1 });
  r.recordFrame({ time: 20, orientationSign: 1 });
  r.recordRender({ time: 21, watchVisible: true });
  r.event(30, 'tracking-reset', { reason: 'camera-mode', nextMode: 'loading' });
  r.recordFrame({ time: 40, orientationSign: 0 });
  r.recordRender({ time: 41, watchVisible: false });
  const saved = r.export(50);
  assert.deepEqual(saved.frames.map(f => f.orientationSign), [1, 0]);
  assert.equal(saved.summary.visibleWatchSamples, 1);
  assert.equal(saved.summary.calibratedFrames, 1);
  assert.equal(saved.events[1].reason, 'camera-mode');
});

test('capacity freezes capture instead of evicting the failure at its beginning', () => {
  const r = new DiagnosticRecorder({ maxFrames: 3 });
  r.start(0);
  for (let i = 1; i <= 5; i++) r.recordFrame({ time: i, orientationSign: i === 1 ? 1 : 0 });
  assert.deepEqual(r.frames.map(f => f.time), [1, 2, 3]);
  assert.equal(r.active, false); assert.equal(r.full, true);
  assert.equal(r.stopReason, 'capacity-limit');
  assert.equal(r.start(6), false);
  assert.equal(r.events.at(-1).type, 'recording-stop');
});

test('pauses and exports retain immutable coordinates and exclude paused time', () => {
  const r = new DiagnosticRecorder({ maxDurationMs: 100 });
  const context = { template: [[1, 2, 0]] }, frame = { time: 20, diagnostic: { state: 'tracking' }, landmarks: [{ x: 1 }] };
  r.start(0, context); r.recordFrame(frame); r.stop(40);
  context.template[0][0] = 9; frame.diagnostic.state = 'missing'; frame.landmarks[0].x = 9;
  r.recordFrame({ time: 80 });
  assert.equal(r.frames.length, 1);
  r.start(1000); r.recordRender({ time: 1050, watchVisible: false });
  assert.equal(r.duration(1050), 90);
  r.recordRender({ time: 1060, watchVisible: true });
  assert.equal(r.full, true); assert.equal(r.stopReason, 'duration-limit');
  const saved = r.export(2000);
  assert.equal(saved.summary.durationMs, 100);
  assert.equal(saved.frames[0].landmarks[0].x, 1);
  assert.equal(saved.frames[0].diagnostic.state, 'tracking');
  assert.equal(saved.events[0].template[0][0], 1);
  r.clear(); assert.equal(saved.frames.length, 1); assert.equal(r.frames.length, 0);
  assert.equal(r.start(2001), true);
});

test('render samples retain rapid visibility changes without counting the idle preview as attachment', () => {
  const r = new DiagnosticRecorder(); r.start(0);
  for (const [time, mode, watchVisible] of [[1, 'idle', false], [2, 'idle', false], [3, 'live', true], [4, 'live', false], [5, 'live', true], [6, 'live', true]]) {
    r.recordRender({ time, mode, watchVisible });
  }
  assert.deepEqual(r.renders.map(f => f.time), [1, 3, 4, 5]);
  assert.equal(r.visibleRenders, 2);
});

test('render and event limits stop explicitly without silently deleting earlier evidence', () => {
  const r = new DiagnosticRecorder({ maxRenders: 1 }); r.start(0);
  r.recordRender({ time: 1, watchVisible: true }); r.recordRender({ time: 50, watchVisible: false });
  assert.equal(r.renders[0].watchVisible, true); assert.equal(r.full, true);
  const e = new DiagnosticRecorder({ maxEvents: 3 }); e.start(0);
  e.event(1, 'tracking-reset'); e.event(2, 'tracking-reset');
  assert.equal(e.events.length, 3); assert.equal(e.events.at(-1).reason, 'capacity-limit');
});

test('saving stops further capture and resuming keeps both sessions', () => {
  const r = new DiagnosticRecorder(); r.start(0);
  r.recordFrame({ time: 1, orientationSign: 1 }); r.stop(2, 'save');
  const saved = r.export(2, { version: 'test', timeOrigin: 123 });
  r.recordFrame({ time: 3 }); r.start(4); r.recordFrame({ time: 5, orientationSign: 1 });
  assert.equal(saved.frames.length, 1); assert.equal(saved.summary.active, false);
  assert.equal(saved.summary.stopReason, 'save'); assert.equal(saved.timeOrigin, 123);
  assert.equal(r.frames.length, 2);
});
