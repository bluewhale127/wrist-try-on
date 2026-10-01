import * as ort from './ort.wasm.min.mjs';
import {boxPreprocess,decodeCenter,SIZE,GRID} from './center-preprocess.mjs';
ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths=new URL('./',import.meta.url).href;
let center,fit,canvas,context;
self.onmessage=async({data})=>{try{
  if(data.type==='init'){
    center=await ort.InferenceSession.create(new URL('./center-net-07.onnx',import.meta.url).href,{executionProviders:['wasm']});
    fit=await ort.InferenceSession.create(new URL('./fit-net-03.onnx',import.meta.url).href,{executionProviders:['wasm']});
    self.postMessage({type:'ready'});return;
  }
  if(data.type!=='frame')return;
  const start=performance.now();
  try{
    if(!canvas||canvas.width!==data.width||canvas.height!==data.height){canvas=new OffscreenCanvas(data.width,data.height);context=canvas.getContext('2d',{willReadFrequently:true});}
    context.drawImage(data.frame,0,0);
  }finally{data.frame.close();}
  const {input}=boxPreprocess(context.getImageData(0,0,data.width,data.height).data,data.width,data.height);
  const tensor=new ort.Tensor('float32',input,[1,3,SIZE,SIZE]);let a,b;
  try{a=await center.run({image:tensor});b=await fit.run({image:tensor});}finally{tensor.dispose();}
  try{
    const pose=decodeCenter(a.center_heatmap.data,data.width,data.height),points={};
    for(const [i,k] of ['A','B','C'].entries()){
      const p=decodeCenter(b.fit_heatmaps.data.slice(i*GRID*GRID,(i+1)*GRID*GRID),data.width,data.height);
      points[k]=p?{center:[p.x,p.y],score:p.score,accepted:p.accepted}:null;
    }
    self.postMessage({type:'result',id:data.id,time:data.time,width:data.width,height:data.height,pose,points,inferenceMs:performance.now()-start});
  }finally{a.center_heatmap.dispose();b.fit_heatmaps.dispose();}
}catch(error){data.frame?.close();self.postMessage({type:'error',id:data.id,message:error.message});}};
