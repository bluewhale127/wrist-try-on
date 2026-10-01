// Experimental recovery. Heatmap scores are retained, never relabelled probabilities.
export const POLICY=Object.freeze({single:.55,primary:.4,support:.2,radius:.06});
export function selectCenter(views,width,height){
 const valid=p=>p&&[p.x,p.y,p.score].every(Number.isFinite)&&p.x>0&&p.y>0&&p.x<width&&p.y<height&&p.score>=0&&p.score<=1;
 const first=views[0];
 if(valid(first)&&first.score>=POLICY.single)return {...first,accepted:true,evidence:'single',viewCount:1};
 let best=null;
 for(let i=0;i<views.length;i++)for(let j=i+1;j<views.length;j++){
  const a=views[i],b=views[j];if(!valid(a)||!valid(b))continue;
  if(Math.max(a.score,b.score)<POLICY.primary||Math.min(a.score,b.score)<POLICY.support)continue;
  const separation=Math.hypot(a.x-b.x,a.y-b.y);
  if(separation>POLICY.radius*Math.min(width,height))continue;
  const quality=Math.sqrt(a.score*b.score);
  if(!best||quality>best.quality){
   const total=a.score+b.score;
   best={x:(a.x*a.score+b.x*b.score)/total,y:(a.y*a.score+b.y*b.score)/total,
    score:Math.max(a.score,b.score),accepted:true,evidence:'corroborated',quality,separation,views:[i,j],viewCount:views.length};
  }
 }
 return best||{...first,accepted:false,evidence:'unconfirmed',viewCount:views.length};
}
// Rotate the already letterboxed tensor, so padding and source mapping are identical.
export function rotatePlanes(input,size,channels,turns){
 turns=((turns%4)+4)%4;
 if(!turns)return input;
 const output=new Float32Array(input.length),area=size*size;
 for(let c=0;c<channels;c++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  let dx=x,dy=y;
  for(let k=0;k<turns;k++){const previous=dx;dx=dy;dy=size-1-previous;}
  output[c*area+dy*size+dx]=input[c*area+y*size+x];
 }
 return output;
}
