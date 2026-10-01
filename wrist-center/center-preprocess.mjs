export const SIZE=192,GRID=48,THRESHOLD=.55;
export function boxPreprocess(rgba,width,height){
  if(!(width>0&&height>0)||rgba.length!==width*height*4)throw Error('Invalid RGB input');
  const nw=Math.max(1,Math.floor(width*SIZE/Math.max(width,height)+.5)),nh=Math.max(1,Math.floor(height*SIZE/Math.max(width,height)+.5));
  const px=Math.floor((SIZE-nw)/2),py=Math.floor((SIZE-nh)/2),area=SIZE*SIZE;
  const lo=Math.floor(height*30/720+.5),hi=Math.min(height,Math.max(lo+1,Math.floor(height*100/720+.5)));
  const color=[0,0,0];
  for(let y=lo;y<hi;y++)for(let x=0;x<width;x++){const q=(y*width+x)*4;for(let c=0;c<3;c++)color[c]+=rgba[q+c];}
  for(let c=0;c<3;c++)color[c]=Math.floor(color[c]/((hi-lo)*width));
  const input=new Float32Array(area*3);
  for(let c=0;c<3;c++)input.fill(color[c]/255,c*area,(c+1)*area);
  for(let dy=0;dy<nh;dy++){
    const y0=Math.floor(dy*height/nh),y1=Math.max(y0+1,Math.floor((dy+1)*height/nh));
    for(let dx=0;dx<nw;dx++){
      const x0=Math.floor(dx*width/nw),x1=Math.max(x0+1,Math.floor((dx+1)*width/nw)),sum=[0,0,0];
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const q=(y*width+x)*4;sum[0]+=rgba[q];sum[1]+=rgba[q+1];sum[2]+=rgba[q+2];}
      const count=(x1-x0)*(y1-y0),p=(dy+py)*SIZE+dx+px;
      for(let c=0;c<3;c++)input[c*area+p]=Math.floor(sum[c]/count)/255;
    }
  }
  return {input,map:{w:width,h:height,nw,nh,px,py,sx:nw/width,sy:nh/height}};
}
export function decodeCenter(heat,width,height){
  if(heat.length!==GRID*GRID||!heat.every(Number.isFinite))return null;
  let peak=0;for(let i=1;i<heat.length;i++)if(heat[i]>heat[peak])peak=i;
  const iy=Math.floor(peak/GRID),ix=peak%GRID;let den=0,cx=0,cy=0;
  for(let y=Math.max(0,iy-1);y<Math.min(GRID,iy+2);y++)for(let x=Math.max(0,ix-1);x<Math.min(GRID,ix+2);x++){
    const weight=heat[y*GRID+x]**2;den+=weight;cx+=(x+.5)*weight;cy+=(y+.5)*weight;
  }
  if(den<=0)return null;
  const nw=Math.max(1,Math.floor(width*SIZE/Math.max(width,height)+.5)),nh=Math.max(1,Math.floor(height*SIZE/Math.max(width,height)+.5));
  const x=(cx/den*4-Math.floor((SIZE-nw)/2))/(nw/width),y=(cy/den*4-Math.floor((SIZE-nh)/2))/(nh/height);
  return {x,y,score:heat[peak],accepted:heat[peak]>=THRESHOLD&&x>0&&y>0&&x<width&&y<height};
}
export class CenterFilter{
  constructor(){this.reset();}
  reset(){this.value=null;this.time=-Infinity;}
  push(p,time){if(!p?.accepted||time<=this.time){this.reset();return null;}
    const a=1-Math.exp(-(time-this.time)/35);
    this.value=!this.value||time-this.time>250?{...p}:{...p,x:this.value.x+(p.x-this.value.x)*a,y:this.value.y+(p.y-this.value.y)*a};
    this.time=time;return this.value;
  }
  sample(time){return time>=this.time&&time-this.time<=180?this.value:null;}
}
