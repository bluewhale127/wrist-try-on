export class WristCenterClient {
 constructor(){this.worker=null;this.pending=null;this.sequence=0;}
 async initialize(){
  this.worker=new Worker(new URL('./wrist-center/center-live-worker-01.mjs?v=3',import.meta.url),{type:'module'});
  this.worker.onmessage=({data})=>{
   const p=this.pending;if(!p)return;
   if(data.type==='result'&&data.id!==p.id)return;
   clearTimeout(p.timer);this.pending=null;
   data.type==='error'?p.reject(Error(data.message)):p.resolve(data);
  };
  this.worker.onerror=()=>this.close(Error('손목 모델 실행 오류'));
  await this.request({type:'init',model:'adapt09'},[],45000);return this;
 }
 request(data,transfer=[],timeout=1200){
  if(!this.worker||this.pending)return Promise.reject(Error('손목 모델을 사용할 수 없습니다.'));
  return new Promise((resolve,reject)=>{
   const id=++this.sequence;
   const timer=setTimeout(()=>this.close(Error('손목 모델 응답 시간 초과')),timeout);
   this.pending={resolve,reject,timer,id};
   try{this.worker.postMessage({...data,id},transfer);}catch(error){this.close(error);}
  });
 }
 async detect(image,time){
  const frame=await createImageBitmap(image);
  try{return await this.request({type:'frame',frame,time,width:frame.width,height:frame.height},[frame]);}
  catch(error){frame.close();throw error;}
 }
 close(error=Error('손목 모델 종료')){
  this.worker?.terminate();this.worker=null;
  if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
 }
}
