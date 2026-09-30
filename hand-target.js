const PALM = [0, 5, 9, 13, 17];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function describe(landmarks, handedness, view, index) {
  if (landmarks?.length !== 21 || PALM.some(i => !Number.isFinite(landmarks[i]?.x) || !Number.isFinite(landmarks[i]?.y))) return null;
  // Raw camera coordinates, before display cropping/mirroring. Use the diagonal
  // so distances have the same meaning for portrait and landscape inputs.
  const diagonal = Math.hypot(view.videoWidth, view.videoHeight);
  if (!(diagonal > 0)) return null;
  const points = PALM.map(i => ({ x: landmarks[i].x * view.videoWidth / diagonal, y: landmarks[i].y * view.videoHeight / diagonal }));
  const center = points.reduce((s, p) => ({ x: s.x + p.x / 5, y: s.y + p.y / 5 }), { x: 0, y: 0 });
  // Longest palm bone stays usable when the palm width collapses in side view.
  const size = Math.max(...points.slice(1).map(p => distance(points[0], p)));
  if (size < 0.035) return null;
  const category = handedness?.[0];
  return { index, wrist: points[0], center, size, side: category?.score >= 0.85 ? category.categoryName : null };
}

// Spatial association, not biometric identity. Losing the chosen hand must not
// silently assign its calibrated watch to an unrelated detection.
export class HandTarget {
  constructor() { this.reset(); }
  reset() { this.target = null; this.pending = null; this.relocation = null; this.lastTime = -Infinity; this.lastInput = -Infinity; this.state = 'waiting'; }
  select(result, view, time, { allowRelocation = false } = {}) {
    if (!Number.isFinite(time) || time <= this.lastInput) return null;
    this.lastInput = time;
    const hands = (result.landmarks || []).map((points, i) => describe(points, result.handedness?.[i], view, i)).filter(Boolean);
    if (!this.target) {
      const hand = hands.sort((a, b) => b.size - a.size)[0];
      if (!hand) { this.pending = null; this.state = 'waiting'; return null; }
      if (!this.pending || time - this.pending.time > 200 || distance(hand.wrist, this.pending.hand.wrist) > hand.size * 0.5 || Math.abs(Math.log(hand.size / this.pending.hand.size)) > 0.3) {
        this.pending = { hand, started: time, time, count: 1 }; this.state = 'choosing'; return null;
      }
      this.pending.hand = hand; this.pending.time = time; this.pending.count++;
      if (time - this.pending.started < 120 || this.pending.count < 3) return null;
      this.target = { ...hand, referenceSize: hand.size }; this.pending = null;
      this.lastTime = time; this.state = 'locked'; return hand.index;
    }
    const age = time - this.lastTime, target = this.target;
    const candidates = hands.map(hand => {
      const sizeRatio = hand.size / target.size;
      const referenceRatio = hand.size / target.referenceSize;
      const position = Math.max(distance(hand.wrist, target.wrist), distance(hand.center, target.center)) / Math.max(target.size, hand.size);
      const wrongSide = hand.side && target.side && hand.side !== target.side;
      // Never relax these gates just because the target has been absent longer.
      // A close continuous track may survive one noisy handedness classification.
      const limit = age > 220 ? 0.85 : 0.65 + Math.min(age / 1000, 0.2) * 2;
      if (sizeRatio < 0.58 || sizeRatio > 1.7 || referenceRatio < 0.45 || referenceRatio > 2.8 || position > limit || (wrongSide && (age > 180 || position > 0.3))) return null;
      return { hand, score: position + 0.6 * Math.abs(Math.log(sizeRatio)) + (wrongSide ? 0.35 : 0) };
    }).filter(Boolean).sort((a, b) => a.score - b.score);
    if (!candidates.length || (candidates[1] && candidates[1].score - candidates[0].score < 0.15)) {
      this.state = 'lost';
      // A selfie often moves the camera and hand together. Do not remain
      // locked forever to a stale screen location after a brief large move.
      // Front-camera opt-in only: one same-side, similarly sized hand must
      // persist at a bounded new location for 350ms. The pose tracker still
      // checks rotation memory / a dorsal view before showing the watch.
      const hand = allowRelocation && age > 220 && hands.length === 1 ? hands[0] : null;
      const ratio = hand && hand.size / target.size, reference = hand && hand.size / target.referenceSize;
      const position = hand && Math.max(distance(hand.wrist,target.wrist),distance(hand.center,target.center)) / Math.max(hand.size,target.size);
      if (!hand || !target.side || hand.side !== target.side || ratio < 0.58 || ratio > 1.7 || reference < 0.65 || reference > 1.65 || position > 2.5) {
        this.relocation = null; return null;
      }
      const prior = this.relocation;
      const consistent = prior && time-prior.time <= 200 && distance(hand.wrist,prior.hand.wrist) < hand.size*0.3 && distance(hand.center,prior.hand.center) < hand.size*0.3 && Math.abs(Math.log(hand.size/prior.hand.size)) < 0.15;
      this.relocation = { hand, time, started: consistent ? prior.started : time, count: consistent ? prior.count+1 : 1 };
      this.state = 'recovering';
      if (this.relocation.count < 4 || time-this.relocation.started < 350) return null;
      this.target = { ...hand, side: target.side, referenceSize: target.referenceSize };
      this.relocation = null; this.lastTime = time; this.state = 'reacquired'; return hand.index;
    }
    const chosen = candidates[0].hand;
    this.relocation = null;
    this.target = { ...chosen, side: target.side || chosen.side, referenceSize: target.referenceSize };
    this.lastTime = time; this.state = 'locked'; return chosen.index;
  }
}
