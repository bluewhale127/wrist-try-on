export function describeObservation(pose,age){
  if(!pose||![pose.x,pose.y,pose.score,age].every(Number.isFinite))return {code:'invalid',text:'손목 후보를 계산하지 못했어요'};
  if(age>350)return {code:'stale',text:'분석 결과 도착이 늦어 표시를 보류했어요'};
  if(pose.score<.55)return {code:'low-score',text:'인식 점수가 낮아요 · 조명·배경·손목 방향이 학습 장면과 다를 수 있어요'};
  if(!pose.accepted)return {code:'outside',text:'손목 후보가 화면 밖에 있어요'};
  return {code:'accepted',text:'손목 중심 추적 중 · 크기·방향 수동'};
}

export function diagnosticRecord(data,now,{sourceMode,mirror,capturePath,settings}){
  const age=Math.max(0,now-data.time),reason=describeObservation(data.pose,age);
  return {version:3,model:'wrist-center-06',threshold:.55,sourceMode,mirror,capturePath,
    width:data.width,height:data.height,frameTime:data.frameTime,
    inferenceMs:data.inferenceMs,resultAgeMs:age,reason:reason.code,
    candidate:data.pose?{x:data.pose.x,y:data.pose.y,score:data.pose.score,accepted:!!data.pose.accepted}:null,
    settings:{...settings},notice:'Candidate is a model prediction, not a verified wrist label. No image was uploaded.'};
}
