import {Group,Mesh,Vector3} from './vendor/three/three.module.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// Asset-specific visual fitting. Preserve the authored case and lug region;
// only the separate Datejust bracelet changes. Units are case widths.
export function fitBraceletPoint(point,ry,depth){
 const out=point.clone();
 const below=clamp((-point.z-.025)/.22,0,1),weight=below*below*(3-2*below);
 const yScale=clamp(ry/1.075,.72,1.3),zScale=clamp(depth/1.30,.65,1.45);
 out.y*=1+(yScale-1)*weight;
 if(point.z<0)out.z*=1+(zScale-1)*weight;
 return out;
}
export class DatejustBracelet {
 constructor(normalized){
  this.parts=[];this.original=[];this.last=null;
  normalized.updateMatrixWorld(true);
  this.object=new Group();this.object.add(normalized);
  normalized.traverse(mesh=>{
   if(!mesh.isMesh||mesh.parent?.name!=='@bra-U-12')return;
   const g=mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
   if(mesh.matrixWorld.determinant()<0&&g.index){const a=g.index.array;for(let i=0;i<a.length;i+=3)[a[i+1],a[i+2]]=[a[i+2],a[i+1]];}
   const fitted=new Mesh(g,mesh.material);fitted.name='Fitted '+mesh.name;
   this.parts.push({mesh:fitted,positions:g.attributes.position.array.slice()});this.original.push(mesh);
  });
  for(const p of this.parts)this.object.add(p.mesh);
  this.object.userData={...normalized.userData,braceletFit:this};this.setEnabled(false);
 }
 setEnabled(on){this.enabled=!!on&&this.parts.length>0;for(const m of this.original)m.visible=!this.enabled;for(const p of this.parts)p.mesh.visible=this.enabled;}
 fit(radiusX,radiusZ,caseSize,rotation,enabled){
  // The prepared bracelet encircles the wrist at the normal 90-degree case
  // mounting. Retain the authored asset if the user changes its tilt/yaw.
  const axis=new Vector3(0,1,0).applyQuaternion(rotation),normal=new Vector3(0,0,1).applyQuaternion(rotation);
  const compatible=Math.abs(axis.x)>.96&&normal.z>.98;
  this.setEnabled(enabled&&compatible);
  if(!this.enabled||caseSize<=0)return;
  const values=[radiusX/caseSize+.03,2*radiusZ/caseSize+.04];
  if(this.last&&values.every((v,i)=>Math.abs(v-this.last[i])<.005))return;
  this.last=values;const point=new Vector3();
  for(const p of this.parts){
   const a=p.mesh.geometry.attributes.position;
   for(let i=0;i<a.count;i++){point.fromArray(p.positions,i*3);fitBraceletPoint(point,...values).toArray(a.array,i*3);}
   a.needsUpdate=true;p.mesh.geometry.computeVertexNormals();p.mesh.geometry.computeBoundingBox();p.mesh.geometry.computeBoundingSphere();
  }
 }
}
