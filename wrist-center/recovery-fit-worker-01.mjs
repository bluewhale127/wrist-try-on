import * as ort from './ort.wasm.min.mjs';
import {boxPreprocess,decodeCenter,SIZE,GRID} from './center-preprocess.mjs';
import {selectCenter,rotatePlanes} from './center-consensus-01.mjs';
ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths=new URL('./',import.meta.url).href;
let session,fit,canvas,context,model;
self.onmessage=async({data})=>{try{
 if(data.type==='init'){
  model=data.model;if(!['baseline','candidate','recovery'].includes(model))throw Error('Unknown model');
  session=await ort.InferenceSession.create(new URL('./center-transfer-01.onnx',import.meta.url).href,{executionProviders:['wasm']});
  fit=await ort.InferenceSession.create(new URL('./fit-net-03.onnx',import.meta.url).href,{executionProviders:['wasm']});
  self.postMessage({type:'ready'});return;
 }
 const start=performance.now();
 try{
  if(!canvas||canvas.width!==data.width||canvas.height!==data.height){canvas=new OffscreenCanvas(data.width,data.height);context=canvas.getContext('2d',{willReadFrequently:true});}
  context.drawImage(data.frame,0,0);
 }finally{data.frame.close();}
 const {input}=boxPreprocess(context.getImageData(0,0,data.width,data.height).data,data.width,data.height);
 const views=[];
 for(const k of [0,3,1,2]){
  const t=new ort.Tensor('float32',rotatePlanes(input,SIZE,3,k),[1,3,SIZE,SIZE]);let output;
  try{output=await session.run({image:t});views.push(decodeCenter(rotatePlanes(output.center_heatmap.data,48,1,4-k),data.width,data.height));}
  finally{t.dispose();output?.center_heatmap.dispose();}
  if(k===0&&(model!=='recovery'||views[0]?.accepted))break;
  if(k!==0&&selectCenter(views,data.width,data.height).accepted)break;
 }
 const pose=model==='recovery'?selectCenter(views,data.width,data.height):views[0],centerMs=performance.now()-start;
 const t=new ort.Tensor('float32',input,[1,3,SIZE,SIZE]);let geometry;
 const points={};
 try{
  geometry=await fit.run({image:t});
  for(const [i,k] of ['A','B','C'].entries()){
   const p=decodeCenter(geometry.fit_heatmaps.data.slice(i*GRID*GRID,(i+1)*GRID*GRID),data.width,data.height);
   points[k]=p?{center:[p.x,p.y],score:p.score,accepted:p.accepted}:null;
  }
 }finally{t.dispose();geometry?.fit_heatmaps.dispose();}
 self.postMessage({type:'result',id:data.id,time:data.time,width:data.width,height:data.height,pose,points,viewCount:views.length,inferenceMs:performance.now()-start,centerMs});
}catch(error){data.frame?.close();self.postMessage({type:'error',message:error.message});}};
