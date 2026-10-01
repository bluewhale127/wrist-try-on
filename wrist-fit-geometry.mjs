// A/B are named landmarks, never screen-left/right slots.
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function fitGeometry(points,center,width,height,mirror=false){
  if(![center?.[0],center?.[1],width,height].every(Number.isFinite)||width<=0||height<=0)return null;
  if(!['A','B','C'].every(k=>points[k]?.accepted&&points[k].score>=.55&&points[k].center?.length===2&&points[k].center.every(Number.isFinite)))return null;
  const reflected=p=>[mirror?width-p[0]:p[0],p[1]],c=reflected(center);
  const [A,B,C]=['A','B','C'].map(k=>reflected(points[k].center));
  if([A,B,C,c].some(p=>p[0]<=0||p[0]>=width||p[1]<=0||p[1]>=height))return null;
  const dx=B[0]-A[0],dy=B[1]-A[1],w=Math.hypot(dx,dy);
  const fx=C[0]-c[0],fy=C[1]-c[1],length=Math.hypot(fx,fy);
  if(w<Math.min(width,height)*.06||w>Math.min(width,height)*1.1||length<w*.25||length>w*1.3)return null;
  const along=((c[0]-A[0])*dx+(c[1]-A[1])*dy)/(w*w);
  const offset=Math.abs((c[0]-A[0])*dy-(c[1]-A[1])*dx)/w;
  const perpendicularError=Math.abs(dx*fx+dy*fy)/(w*length);
  if(along<.15||along>.85||offset>w*.2||perpendicularError>.45)return null;
  const heading=Math.atan2(fx,fy);
  // Watch local +Y points at 12. Image Y is down; scene Y is up.
  const clockRotation=Math.atan2(-(A[1]-B[1]),A[0]-B[0])-Math.PI/2;
  return {A,B,C,center:c,projectedWidth:w,heading,clockRotation:wrap(clockRotation),dial:wrap(clockRotation-heading),
    score:Math.min(...['A','B','C'].map(k=>points[k].score)),perpendicularError};
}
