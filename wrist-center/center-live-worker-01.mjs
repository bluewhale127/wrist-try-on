import * as ort from './ort.wasm.min.mjs';
import {boxPreprocess,decodeCenter,SIZE,GRID} from './center-preprocess.mjs';
import {selectCenter,rotatePlanes} from './center-consensus-01.mjs';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths=new URL('./',import.meta.url).href;
const models={baseline:'center-transfer-01.onnx',adapt04:'center-adapt-04.onnx',adapt08:'center-adapt-08.onnx',adapt09:'center-adapt-09.onnx'};
let session,canvas,context,busy=false;
self.onmessage=async({data})=>{
 if(busy){data.frame?.close();return;}
 busy=true;
 try{
  if(data.type==='init'){
   if(!Object.hasOwn(models,data.model))throw Error('Unknown model');
   session=await ort.InferenceSession.create(new URL(models[data.model],import.meta.url).href,{executionProviders:['wasm']});
   self.postMessage({type:'ready'});return;
  }
  if(data.type!=='frame'||!session)throw Error('Model is not ready');
  const start=performance.now();
  if(!canvas||canvas.width!==data.width||canvas.height!==data.height){canvas=new OffscreenCanvas(data.width,data.height);context=canvas.getContext('2d',{willReadFrequently:true});}
  try{context.drawImage(data.frame,0,0);}finally{data.frame.close();data.frame=null;}
  const {input}=boxPreprocess(context.getImageData(0,0,data.width,data.height).data,data.width,data.height);
  const views=[];
  let pose;
  for(const k of [0,3,1,2]){
   const tensor=new ort.Tensor('float32',rotatePlanes(input,SIZE,3,k),[1,3,SIZE,SIZE]);let output;
   try{output=await session.run({image:tensor});views.push(decodeCenter(rotatePlanes(output.center_heatmap.data,GRID,1,4-k),data.width,data.height));}
   finally{tensor.dispose();output?.center_heatmap.dispose();}
   pose=selectCenter(views,data.width,data.height);
   if(pose.accepted)break;
  }
  self.postMessage({type:'result',id:data.id,time:data.time,width:data.width,height:data.height,pose,viewCount:views.length,inferenceMs:performance.now()-start});
 }catch(error){data.frame?.close();self.postMessage({type:'error',message:error.message});}
 finally{busy=false;}
};
