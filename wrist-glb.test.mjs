import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3} from './vendor/three/three.module.js';
import {watchPlacement} from './wrist-glb-placement.mjs';
import {fitGeometry} from './wrist-fit-geometry.mjs';
const settings={scale:1,roll:0,tilt:0,heading:0,dial:90,width:1,depth:1,height:0};
const view={width:580,height:650,videoWidth:406,videoHeight:720};
const center=[218.19,359.309],point={x:center[0],y:center[1]};
const points=Object.fromEntries(Object.entries({A:[148,337],B:[286,381],C:[183,469]}).map(([k,center])=>[k,{center,score:.9,accepted:true}]));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('flat GLB twelve axis points toward A, and six toward B, after each mirror mode',()=>{
  for(const mirror of [false,true]){
    const g=fitGeometry(points,center,406,720,mirror),p=watchPlacement(point,view,settings,g,mirror);
    const twelve=new Vector3(0,1,0).applyAxisAngle(new Vector3(0,0,1),p.dialRadians).applyQuaternion(p.rotation);
    near(twelve.x,(g.A[0]-g.B[0])/g.projectedWidth);near(-twelve.y,(g.A[1]-g.B[1])/g.projectedWidth);
    near(p.dimensions.radiusX*2,g.projectedWidth*650/720);near(p.caseSize,g.projectedWidth*.68*650/720);
  }
});
test('manual roll, tilt and lift preserve the GLB case-back contact at the detected wrist centre',()=>{
  const g=fitGeometry(points,center,406,720);
  for(const roll of [-90,0,90])for(const tilt of [-50,0,50]){
    const p=watchPlacement(point,view,{...settings,roll,tilt,height:.2},g);
    const anchor=new Vector3(0,0,p.dimensions.radiusZ+p.height*p.caseSize).applyQuaternion(p.rotation).add(p.position);
    near(anchor.distanceTo(p.target),0);
  }
});
test('missing A cannot supply automatic width or a fabricated dial direction',()=>{
  const partial={...points,A:null},g=fitGeometry(partial,center,406,720);
  assert.equal(g,null);const manual={...settings,heading:-90,dial:-90};
  const p=watchPlacement(point,view,manual,g);near(p.heading,-Math.PI/2);near(p.dialRadians,-Math.PI/2);
  near(p.sourceWidth,406*.36);
});
test('case scale controls never resize the wrist occlusion mask',()=>{
  const g=fitGeometry(points,center,406,720),a=watchPlacement(point,view,settings,g),b=watchPlacement(point,view,{...settings,scale:.65},g);
  near(b.caseSize,a.caseSize*.65);assert.deepEqual(a.dimensions,b.dimensions);
  assert.equal(watchPlacement(null,view,settings),null);
});
