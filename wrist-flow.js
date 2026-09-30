// Sparse pyramidal Lucas-Kanade on camera pixels, never the rendered AR canvas.
// This estimates image motion only. It cannot recover an unseen 3D wrist turn.
const sample = (im, x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y), dx = x-ix, dy = y-iy, k = iy*im.width+ix;
  return (1-dy)*((1-dx)*im.data[k]+dx*im.data[k+1])+dy*((1-dx)*im.data[k+im.width]+dx*im.data[k+im.width+1]);
};
const inside = (im,x,y,r=5) => x>=r && y>=r && x<im.width-r-1 && y<im.height-r-1;
export function grayFrame(source, holder) {
  const sw=source.videoWidth||source.width, sh=source.videoHeight||source.height;
  const ratio=Math.min(1,480/Math.max(sw,sh)), width=Math.round(sw*ratio),height=Math.round(sh*ratio);
  holder.canvas ||= typeof OffscreenCanvas!=='undefined' ? new OffscreenCanvas(width,height) : document.createElement('canvas');
  const canvas=holder.canvas;
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  holder.context ||= canvas.getContext('2d',{willReadFrequently:true});
  holder.context.drawImage(source,0,0,width,height);
  const rgba=holder.context.getImageData(0,0,width,height).data, data=new Uint8Array(width*height);
  for(let i=0;i<data.length;i++)data[i]=(rgba[i*4]*77+rgba[i*4+1]*150+rgba[i*4+2]*29)>>8;
  return {width,height,data};
}
export function pyramid(frame) {
  const levels=[frame];
  for(let level=1;level<3;level++){
    const prev=levels.at(-1),width=Math.floor(prev.width/2),height=Math.floor(prev.height/2),data=new Float32Array(width*height);
    // Low-pass before decimation; the 3x3 kernel reduces aliasing during zoom.
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      let sum=0;
      for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)sum+=prev.data[Math.max(0,Math.min(prev.height-1,y*2+j))*prev.width+Math.max(0,Math.min(prev.width-1,x*2+i))]*(i===0?2:1)*(j===0?2:1);
      data[y*width+x]=sum/16;
    }
    levels.push({width,height,data});
  }
  return levels;
}
export function wristFeatures(frame, roi, max=40) {
  if(!roi||roi.rx<10||roi.ry<10)return [];
  const candidates=[];
  const left=Math.max(6,Math.ceil(roi.x-roi.rx)),right=Math.min(frame.width-7,Math.floor(roi.x+roi.rx));
  const top=Math.max(6,Math.ceil(roi.y-roi.ry)),bottom=Math.min(frame.height-7,Math.floor(roi.y+roi.ry));
  for(let y=top;y<=bottom;y+=2)for(let x=left;x<=right;x+=2){
    const dx=x-roi.x,dy=y-roi.y;
    if(roi.basis){
      const [ux,uy,vx,vy]=roi.basis,det=ux*vy-uy*vx;
      if(Math.abs(det)<20||((dx*vy-dy*vx)/det)**2+((dy*ux-dx*uy)/det)**2>1)continue;
    }else if((dx/roi.rx)**2+(dy/roi.ry)**2>1)continue;
    let xx=0,xy=0,yy=0;
    for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++){
      const k=(y+j)*frame.width+x+i,gx=(frame.data[k+1]-frame.data[k-1])/2,gy=(frame.data[k+frame.width]-frame.data[k-frame.width])/2;
      xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;
    }
    const score=(xx+yy-Math.hypot(xx-yy,2*xy))/50;
    if(score>3)candidates.push({x,y,score});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const selected=[],spacing=Math.max(4,Math.min(9,Math.min(roi.rx,roi.ry)*.18));
  for(const p of candidates){
    if(selected.every(q=>Math.hypot(q.x-p.x,q.y-p.y)>spacing))selected.push(p);
    if(selected.length>=max)break;
  }
  return selected;
}
function trackPoint(before,after,p,guess=p) {
  let q;
  // Start at the coarsest level with enough margin, including near image edges.
  let top=Math.min(before.length,after.length)-1;
  while(top>0&&!inside(before[top],p.x/2**top,p.y/2**top))top--;
  for(let level=top;level>=0;level--){
    const old=before[level],next=after[level],px=p.x/2**level,py=p.y/2**level;
    q=q?{x:q.x*2,y:q.y*2}:{x:guess.x/2**level,y:guess.y/2**level};
    if(!inside(old,px,py))return null;
    let xx=0,xy=0,yy=0;const patch=[];
    for(let j=-3;j<=3;j++)for(let i=-3;i<=3;i++){
      const gx=(sample(old,px+i+1,py+j)-sample(old,px+i-1,py+j))/2;
      const gy=(sample(old,px+i,py+j+1)-sample(old,px+i,py+j-1))/2;
      patch.push({i,j,gx,gy,value:sample(old,px+i,py+j)});xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;
    }
    const det=xx*yy-xy*xy;
    if(det<1e-4||(xx+yy-Math.hypot(xx-yy,2*xy))/98<1.5){if(level>0)continue;return null;}
    for(let iteration=0;iteration<12;iteration++){
      if(!inside(next,q.x,q.y))return null;
      let bx=0,by=0;
      for(const r of patch){const difference=r.value-sample(next,q.x+r.i,q.y+r.j);bx+=r.gx*difference;by+=r.gy*difference;}
      const dx=(yy*bx-xy*by)/det,dy=(xx*by-xy*bx)/det;
      if(!Number.isFinite(dx+dy)||Math.hypot(dx,dy)>8)return null;
      q.x+=dx;q.y+=dy;
      if(dx*dx+dy*dy<.0004)break;
    }
  }
  if(!inside(after[0],q.x,q.y))return null;
  let error=0;
  for(let j=-3;j<=3;j++)for(let i=-3;i<=3;i++)error+=Math.abs(sample(before[0],p.x+i,p.y+j)-sample(after[0],q.x+i,q.y+j));
  return error/49<18?q:null;
}
export function transformPoint(t,p){return {x:t.a*p.x-t.b*p.y+t.tx,y:t.b*p.x+t.a*p.y+t.ty};}
function fitSimilarity(pairs) {
  let px=0,py=0,qx=0,qy=0;
  for(const {p,q} of pairs){px+=p.x;py+=p.y;qx+=q.x;qy+=q.y;}
  const n=pairs.length;px/=n;py/=n;qx/=n;qy/=n;
  let dot=0,cross=0,energy=0;
  for(const {p,q} of pairs){const x=p.x-px,y=p.y-py,u=q.x-qx,v=q.y-qy;dot+=x*u+y*v;cross+=x*v-y*u;energy+=x*x+y*y;}
  if(energy<25)return null;
  const a=dot/energy,b=cross/energy;
  return {a,b,tx:qx-a*px+b*py,ty:qy-b*px-a*py};
}
export function robustMotion(pairs,total=pairs.length) {
  if(pairs.length<8)return null;
  let best=[];
  // Deterministic RANSAC pairs, followed by a fit to all agreeing observations.
  for(let i=0;i<pairs.length;i++)for(let j=i+1;j<pairs.length;j+=3){
    if(Math.hypot(pairs[i].p.x-pairs[j].p.x,pairs[i].p.y-pairs[j].p.y)<10)continue;
    const t=fitSimilarity([pairs[i],pairs[j]]);if(!t)continue;
    const good=pairs.filter(({p,q})=>{const v=transformPoint(t,p);return Math.hypot(v.x-q.x,v.y-q.y)<1.4;});
    if(good.length>best.length)best=good;
  }
  if(best.length<8||best.length/total<.5)return null;
  const motion=fitSimilarity(best);if(!motion)return null;
  const residual=Math.sqrt(best.reduce((sum,{p,q})=>{const v=transformPoint(motion,p);return sum+(v.x-q.x)**2+(v.y-q.y)**2;},0)/best.length);
  const scale=Math.hypot(motion.a,motion.b),angle=Math.atan2(motion.b,motion.a);
  if(residual>1||scale<.8||scale>1.25||Math.abs(angle)>.3)return null;
  // Reject a near-line or tiny cluster: it cannot establish reliable 2D scale.
  const mx=best.reduce((s,r)=>s+r.p.x,0)/best.length,my=best.reduce((s,r)=>s+r.p.y,0)/best.length;
  let xx=0,xy=0,yy=0;
  for(const {p} of best){xx+=(p.x-mx)**2;xy+=(p.x-mx)*(p.y-my);yy+=(p.y-my)**2;}
  const spread=Math.sqrt((xx+yy-Math.hypot(xx-yy,2*xy))/(2*best.length));
  if(spread<4)return null;
  return {...motion,scale,angle,residual,inliers:best.length,ratio:best.length/total,spread,points:best.map(r=>r.q)};
}
export function trackWrist(before,after,points) {
  const pairs=[];
  for(const p of points){
    const q=trackPoint(before,after,p);if(!q)continue;
    const back=trackPoint(after,before,q,p);
    if(back&&Math.hypot(back.x-p.x,back.y-p.y)<.8)pairs.push({p,q});
  }
  return robustMotion(pairs,points.length);
}
