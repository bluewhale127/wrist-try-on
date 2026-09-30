import * as THREE from './vendor/three/three.module.js';

// A visual estimate from the calibrated palm, not a measured wrist circumference.
// Case size is deliberately absent: resizing a watch must not resize the wrist.
export function wristDimensions(palmWidth, width = 1, depth = 1) {
  const radiusX = palmWidth * 0.43 * width;
  const radiusZ = palmWidth * 0.27 * depth;
  return { radiusX, radiusZ, length: radiusX * 2.8 };
}

const smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const SEGMENTS = 80;

// Coordinates are in the wrist frame (Y along the forearm, X across it).
// The middle of the band follows the same ellipse used by the depth occluder.
// Short end sections connect that ellipse to the actual transformed case lugs.
export function fitStrapPositions(positions, { radiusX, radiusZ, caseSize, caseRotation, lift = 0 }) {
  const offset = new THREE.Vector3(0, 0, radiusZ + lift);
  let start = new THREE.Vector3(0, -0.56, 0.015).applyQuaternion(caseRotation).multiplyScalar(caseSize).add(offset);
  let end = new THREE.Vector3(0, 0.56, 0.015).applyQuaternion(caseRotation).multiplyScalar(caseSize).add(offset);
  if (start.x < end.x) [start, end] = [end, start];
  const endWidth = new THREE.Vector3(0.19 * caseSize, 0, 0).applyQuaternion(caseRotation);
  if (endWidth.y < 0) endWidth.negate();
  const endNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(caseRotation);
  const opening = Math.max(0.25, Math.min(1.12, Math.asin(Math.min(0.92, Math.abs(start.x) / radiusX))));
  const clearance = 0.012 * caseSize, thickness = 0.035 * caseSize;
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = i / SEGMENTS, angle = opening + (Math.PI * 2 - 2 * opening) * u;
    const blend = 1 - smoothstep(Math.min(u, 1 - u) / 0.14);
    const center = new THREE.Vector3(Math.sin(angle) * (radiusX + clearance), 0, Math.cos(angle) * (radiusZ + clearance));
    center.lerp(u < 0.5 ? start : end, blend);
    const width = new THREE.Vector3(0, 0.19 * caseSize, 0).lerp(endWidth, blend);
    const normal = new THREE.Vector3(Math.sin(angle) / radiusX, 0, Math.cos(angle) / radiusZ).normalize().lerp(endNormal, blend).normalize();
    for (let j = 0; j < 4; j++) {
      const point = center.clone().addScaledVector(width, j % 2 ? 1 : -1).addScaledVector(normal, j < 2 ? 0 : thickness);
      point.toArray(positions, i * 12 + j * 3);
    }
  }
  return positions;
}

export class WristRig extends THREE.Group {
  constructor() {
    super();
    this.caseMount = new THREE.Group();
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 64, 4);
    this.occluder = new THREE.Mesh(cylinder, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }));
    this.occluder.renderOrder = -10;
    const guideCylinder = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
    this.guide = new THREE.LineSegments(new THREE.EdgesGeometry(guideCylinder), new THREE.LineBasicMaterial({ color: 0xa2efdb, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false }));
    guideCylinder.dispose();
    this.guide.renderOrder = 3; this.guide.visible = false;
    const geometry = new THREE.BufferGeometry(), indices = [];
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 12), 3).setUsage(THREE.DynamicDrawUsage));
    for (let i = 0; i < SEGMENTS; i++) for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0]]) {
      const k = i * 4; indices.push(k + a, k + b, k + a + 4, k + b, k + b + 4, k + a + 4);
    }
    for (const k of [0, SEGMENTS * 4]) indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    geometry.setIndex(indices);
    this.strap = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x19262c, roughness: 0.84, metalness: 0.08, side: THREE.DoubleSide }));
    this.add(this.occluder, this.caseMount, this.strap, this.guide);
    this.lastFit = null;
  }
  fit({ radiusX, radiusZ, length, caseSize, height = 0, sample = false, guide = false }) {
    this.occluder.scale.set(radiusX, length, radiusZ);
    this.guide.scale.copy(this.occluder.scale); this.guide.visible = guide;
    this.caseMount.position.z = radiusZ + height * caseSize;
    this.caseMount.scale.setScalar(caseSize);
    this.strap.visible = sample;
    // Work in units of wrist width, keeping vertex coordinates fixed during
    // pure camera zoom. Rebuild only when proportions or case adjustments change.
    this.strap.scale.setScalar(radiusX);
    const normalized = [radiusZ / radiusX, caseSize / radiusX, height, ...this.caseMount.quaternion.toArray()];
    if (sample && (!this.lastFit || normalized.some((v, i) => Math.abs(v - this.lastFit[i]) > 0.0001))) {
      const position = this.strap.geometry.attributes.position;
      fitStrapPositions(position.array, { radiusX: 1, radiusZ: normalized[0], caseSize: normalized[1], caseRotation: this.caseMount.quaternion, lift: height * normalized[1] });
      position.needsUpdate = true; this.strap.geometry.computeVertexNormals(); this.strap.geometry.computeBoundingSphere();
      this.lastFit = normalized;
    }
  }
}
