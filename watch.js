import * as THREE from './vendor/three/three.module.js';

function cylinder(radius, depth, material, z) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 64), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = z;
  return mesh;
}

export function makeSampleWatch() {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xa9b8c0, metalness: 0.94, roughness: 0.24 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x3b4e57, metalness: 0.86, roughness: 0.3 });
  const dial = new THREE.MeshStandardMaterial({ color: 0x102f37, metalness: 0.25, roughness: 0.38 });
  const bright = new THREE.MeshStandardMaterial({ color: 0xd1eee4, metalness: 0.3, roughness: 0.3 });
  group.add(cylinder(0.5, 0.16, metal, 0.055));
  group.add(cylinder(0.455, 0.03, darkMetal, 0.146));
  group.add(cylinder(0.409, 0.012, dial, 0.164));
  const crown = cylinder(0.07, 0.1, metal, 0);
  crown.rotation.set(0, 0, Math.PI / 2); crown.position.set(0.536, 0, 0.054); group.add(crown);
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(i % 3 === 0 ? 0.025 : 0.014, i % 3 === 0 ? 0.067 : 0.042, 0.008), bright);
    tick.position.set(Math.sin(angle) * 0.348, Math.cos(angle) * 0.348, 0.177);
    tick.rotation.z = -angle; group.add(tick);
  }
  // Visible dial labels make a half-turn distinguishable from hand movement.
  if (typeof document !== 'undefined') for (const [text, y, width] of [['12',0.25,0.14],['6',-0.25,0.09]]) {
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=160;
    const context=canvas.getContext('2d');context.fillStyle='#d1eee4';context.font='600 120px sans-serif';context.textAlign='center';context.textBaseline='middle';context.fillText(text,128,84);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const label=new THREE.Mesh(new THREE.PlaneGeometry(width,0.09),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false}));
    label.name=`dial-${text}`;label.position.set(0,y,0.181);group.add(label);
  }
  for (const [length, width, angle, z] of [[0.22, 0.025, 0.95, 0.185], [0.31, 0.018, -1.05, 0.199]]) {
    const pivot = new THREE.Group(); pivot.rotation.z = angle;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(width, length, 0.012), bright);
    hand.position.set(0, length * 0.37, z); pivot.add(hand); group.add(pivot);
  }
  group.add(cylinder(0.031, 0.022, metal, 0.21));
  for (const sign of [-1, 1]) for (const x of [-0.205, 0.205]) {
    const lug = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.20, 0.1), metal); lug.position.set(x, sign * 0.48, 0.025); group.add(lug);
  }
  // Put the case back on Z=0. WristRig creates the fitted bracelet separately.
  for (const child of group.children) child.position.z += 0.025;
  group.userData.sample = true;
  return group;
}

export function disposeModel(root) {
  const materials = new Set(), geometries = new Set(), textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m);
  });
  for (const m of materials) for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
  for (const t of textures) { t.source?.data?.close?.(); t.dispose(); }
  for (const m of materials) m.dispose();
  for (const g of geometries) g.dispose();
}

export function inspectGLB(buffer) {
  const data = new DataView(buffer);
  if (buffer.byteLength < 24 || data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== buffer.byteLength) throw new Error('glTF 2.0 형식의 GLB 파일을 선택해 주세요.');
  const jsonLength = data.getUint32(12, true);
  if (data.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > buffer.byteLength) throw new Error('GLB 파일 구조를 확인해 주세요.');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  if ([...(json.buffers || []), ...(json.images || [])].some(resource => resource.uri && !resource.uri.startsWith('data:'))) throw new Error('텍스처와 데이터를 파일 안에 포함한 GLB로 내보내 주세요.');
  if (json.extensionsRequired?.some(x => ['KHR_texture_basisu', 'EXT_meshopt_compression'].includes(x))) throw new Error('이번 버전은 KTX2·Meshopt 압축을 지원하지 않습니다. 압축 없이 GLB로 내보내 주세요.');
  return json;
}
