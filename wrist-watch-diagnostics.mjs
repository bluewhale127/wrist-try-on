export function describeObservation(pose,age){
  if(!pose||![pose.x,pose.y,pose.score,age].every(Number.isFinite))return {code:'invalid',text:'손목 후보를 계산하지 못했어요'};
  if(age>350)return {code:'stale',text:'분석 결과 도착이 늦어 표시를 보류했어요'};
  if(pose.score<.55)return {code:'low-score',text:'인식 점수가 낮아요 · 조명·배경·손목 방향이 학습 장면과 다를 수 있어요'};
  if(!pose.accepted)return {code:'outside',text:'손목 후보가 화면 밖에 있어요'};
  return {code:'accepted',text:'손목 중심 추적 중 · 크기·방향 수동'};
}

export function trackingMessage(state,raw){
  if(state.phase==='tracking')return '손목 중심 추적 중 · 크기·방향 수동';
  if(state.phase==='assisted')return '가까운 손목 위치로 추적 유지 중 · 크기·방향 수동';
  if(state.phase==='holding')return '마지막 위치를 잠깐 유지하며 다시 확인 중';
  if(state.phase==='acquiring')return `손목 위치 확인 중 · ${state.acquireCount}/2`;
  if(state.reason==='jump')return '위치가 크게 바뀌어 손목을 다시 확인하고 있어요';
  if(state.reason==='weak-unconfirmed')return '손목 위치를 다시 확인해야 해요 · 잠깐 가만히 보여 주세요';
  if(state.reason==='stale')return '새 손목 관측이 늦어 표시를 멈췄어요';
  if(raw?.code==='accepted')return '새 손목 위치를 다시 확인하고 있어요';
  return raw?.text||'카메라의 첫 입력을 기다리고 있어요';
}

export function diagnosticRecord(data,now,{sourceMode,mirror,capturePath,settings,tracking}){
  const age=Math.max(0,now-data.time),reason=describeObservation(data.pose,age);
  return {version:4,model:'wrist-center-06',threshold:.55,continuationThreshold:.4,sourceMode,mirror,capturePath,tracking,
    width:data.width,height:data.height,frameTime:data.frameTime,
    inferenceMs:data.inferenceMs,resultAgeMs:age,reason:reason.code,
    candidate:data.pose?{x:data.pose.x,y:data.pose.y,score:data.pose.score,accepted:!!data.pose.accepted}:null,
    settings:{...settings},notice:'Candidate is a model prediction, not a verified wrist label. No image was uploaded.'};
}
