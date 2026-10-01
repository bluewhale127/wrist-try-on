import * as ort from './ort.wasm.min.mjs';
import {boxPreprocess,decodeCenter,SIZE} from './center-preprocess.mjs';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths=new URL('./',import.meta.url).href;
let session,canvas,context;
self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      session=await ort.InferenceSession.create(new URL('./center-net.onnx',import.meta.url).href,{executionProviders:['wasm']});
      const input=new ort.Tensor('float32',new Float32Array(3*SIZE*SIZE),[1,3,SIZE,SIZE]);
      try{const output=await session.run({image:input});output.center_heatmap.dispose();}finally{input.dispose();}
      self.postMessage({type:'ready',bitmap:typeof OffscreenCanvas!=='undefined'});return;
    }
    if(data.type!=='frame')return;
    if(!session)throw new Error('Model not ready');
    const started=performance.now();let rgba=data.rgba;
    if(data.frame){
      try{
        if(!canvas||canvas.width!==data.width||canvas.height!==data.height){
          canvas=new OffscreenCanvas(data.width,data.height);context=canvas.getContext('2d',{willReadFrequently:true});
        }
        context.drawImage(data.frame,0,0);rgba=context.getImageData(0,0,data.width,data.height).data;
      }finally{data.frame.close();}
    }
    const {input}=boxPreprocess(rgba,data.width,data.height);
    const tensor=new ort.Tensor('float32',input,[1,3,SIZE,SIZE]);let outputs;
    try{outputs=await session.run({image:tensor});}finally{tensor.dispose();}
    const pose=decodeCenter(outputs.center_heatmap.data,data.width,data.height);outputs.center_heatmap.dispose();
    self.postMessage({type:'result',id:data.id,time:data.time,frameTime:data.frameTime,width:data.width,height:data.height,pose,inferenceMs:performance.now()-started});
  }catch(error){data.frame?.close();self.postMessage({type:'error',id:data.id,message:error?.message||String(error)});}
};
