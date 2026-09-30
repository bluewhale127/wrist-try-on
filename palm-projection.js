import { Matrix4, Quaternion, Vector3 } from './vendor/three/three.module.js';

// A calibrated palm plane under weak perspective. Image foreshortening determines
// the tilt magnitude; inferred depth only resolves the two possible depth signs.
const center = points => points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / points.length);
export function palmTemplate(points, rotation) {
  const origin = center(points);
  const x = new Vector3(1,0,0).applyQuaternion(rotation), y = new Vector3(0,1,0).applyQuaternion(rotation);
  const determinant=x.x*y.y-x.y*y.x;
  if(Math.abs(determinant)<0.5)return null;
  // Unproject the observed reference, rather than trusting the model's changing
  // world-space bone lengths. Calibration requires a reasonably frontal hand.
  const local=points.map(p=>{
    const dx=p.x-origin.x,dy=p.y-origin.y;
    return new Vector3((dx*y.y-dy*y.x)/determinant,(dy*x.x-dx*x.y)/determinant,0);
  });
  const length=local.slice(1).reduce((sum,p)=>sum.add(p),new Vector3()).multiplyScalar(0.25).distanceTo(local[0]);
  if(length<12)return null;
  return local.map(p=>p.multiplyScalar(1/length));
}

export function fitPalmProjection(template, imagePoints) {
  if (!template || template.length !== 5 || imagePoints?.length !== 5) return null;
  const origin = center(imagePoints);
  let uu=0,uv=0,vv=0,xu=0,xv=0,yu=0,yv=0;
  for(let i=0;i<5;i++) {
    const {x:u,y:v}=template[i], x=imagePoints[i].x-origin.x, y=imagePoints[i].y-origin.y;
    uu+=u*u;uv+=u*v;vv+=v*v;xu+=x*u;xv+=x*v;yu+=y*u;yv+=y*v;
  }
  const determinant=uu*vv-uv*uv;
  if(determinant<1e-8)return null;
  const a=(xu*vv-xv*uv)/determinant,b=(xv*uu-xu*uv)/determinant;
  const c=(yu*vv-yv*uv)/determinant,d=(yv*uu-yu*uv)/determinant;
  const xx=a*a+c*c,xy=a*b+c*d,yy=b*b+d*d;
  const scale=Math.sqrt((xx+yy+Math.hypot(xx-yy,2*xy))/2);
  if(!Number.isFinite(scale)||scale<8)return null;
  let error=0;
  for(let i=0;i<5;i++) {
    const {x:u,y:v}=template[i];
    error+=(imagePoints[i].x-origin.x-a*u-b*v)**2+(imagePoints[i].y-origin.y-c*u-d*v)**2;
  }
  const residual=Math.sqrt(error/5)/scale;
  const x=new Vector3(a/scale,c/scale,0), y=new Vector3(b/scale,d/scale,0);
  x.z=Math.sqrt(Math.max(0,1-x.lengthSq()));
  y.z=x.z>1e-5?-x.dot(y)/x.z:Math.sqrt(Math.max(0,1-y.lengthSq()));
  const rotations=[];
  for(const sign of [1,-1]) {
    const wx=x.clone(),wy=y.clone();wx.z*=sign;wy.z*=sign;
    wx.normalize();wy.addScaledVector(wx,-wx.dot(wy)).normalize();
    const normal=new Vector3().crossVectors(wx,wy).normalize();
    rotations.push(new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(wx,wy,normal)));
  }
  return {rotations,scale,residual,normalZ:(a*d-b*c)/(scale*scale),origin};
}
