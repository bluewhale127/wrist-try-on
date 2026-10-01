export const TRACKING=Object.freeze({acquireScore:.55,continueScore:.4,acquireFrames:2,pairGapMs:200,holdMs:220,weakWindowMs:650});

export class CenterObservation {
  constructor(){this.reset();}
  reset(){
    this.pose=null;this.time=-Infinity;this.lastInput=-Infinity;this.strongTime=-Infinity;
    this.size=null;this.candidate=null;this.reason='waiting';this.received=-Infinity;this.latency=0;this.cadence=80;
  }
  sample(now){return this.pose&&now>=this.time&&now-this.time<=350&&now-this.received<=Math.min(220,Math.max(140,this.cadence+40,TRACKING.holdMs-this.latency))?this.pose:null;}
  state(now){
    const visible=!!this.sample(now);
    const acquiring=!visible&&!!this.candidate&&now>=this.candidate.time&&now-this.candidate.time<=TRACKING.pairGapMs;
    const recent=now-this.time<=140;
    return {phase:visible?(recent&&this.reason==='strong'?'tracking':recent&&this.reason==='weak'?'assisted':'holding'):acquiring?'acquiring':'searching',
      reason:this.reason,visible,observationAgeMs:Number.isFinite(this.time)?Math.max(0,now-this.time):null,
      strongAgeMs:Number.isFinite(this.strongTime)?Math.max(0,now-this.strongTime):null,acquireCount:acquiring?this.candidate.count:0};
  }
  update(pose,time,sourceWidth,sourceHeight,now=time){
    if(!Number.isFinite(time)||!Number.isFinite(now)||time>now||time<=this.lastInput)return false;
    if(this.size&&(this.size[0]!==sourceWidth||this.size[1]!==sourceHeight))this.reset();
    this.cadence=Number.isFinite(this.lastInput)?Math.min(200,Math.max(0,time-this.lastInput)):80;this.lastInput=time;
    this.size=[sourceWidth,sourceHeight];
    const inside=[pose?.x,pose?.y,pose?.score,sourceWidth,sourceHeight].every(Number.isFinite)
      &&sourceWidth>0&&sourceHeight>0&&pose.score>=0&&pose.score<=1
      &&pose.x>0&&pose.y>0&&pose.x<sourceWidth&&pose.y<sourceHeight;
    if(!inside){this.pose=null;this.candidate=null;this.reason='invalid';return false;}
    if(now-time>TRACKING.holdMs){this.candidate=null;this.reason='stale';return false;}
    if(time-this.time>TRACKING.holdMs)this.pose=null;
    const strong=pose.accepted&&(pose.score>=TRACKING.acquireScore||pose.evidence==='corroborated');
    const short=Math.min(sourceWidth,sourceHeight),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    if(this.pose){
      const dt=Math.min(.2,Math.max(0,(time-this.time)/1000));
      // Lower scores may update only a smaller neighbourhood of a recent strong
      // observation. They cannot initialize, relocate or prolong a lock forever.
      const radius=short*(strong ? .08+.6*dt : .04+.35*dt);
      if(distance(pose,this.pose)<=radius&&(strong||(pose.score>=TRACKING.continueScore&&pose.score<TRACKING.acquireScore&&time-this.strongTime<=TRACKING.weakWindowMs))){
        const alpha=1-Math.exp(-(time-this.time)/(strong?35:65));
        this.pose={...pose,x:this.pose.x+(pose.x-this.pose.x)*alpha,y:this.pose.y+(pose.y-this.pose.y)*alpha};
        this.time=time;this.received=now;this.latency=now-time;this.candidate=null;this.reason=strong?'strong':'weak';
        if(strong)this.strongTime=time;
        return true;
      }
    }
    if(strong){
      const previous=this.candidate;
      const consistent=previous&&time-previous.time<=TRACKING.pairGapMs&&distance(pose,previous.pose)<=short*.1;
      this.candidate={pose:{...pose},time,count:consistent?previous.count+1:1};
      this.reason=this.pose?'jump':'acquiring';
      // Never interpolate a rejected jump across the arm. A new location can
      // attach only after the old observation expires and two observations agree.
      if(!this.pose&&this.candidate.count>=(pose.evidence==='corroborated'?3:TRACKING.acquireFrames)){
        this.pose={...pose};this.time=time;this.received=now;this.latency=now-time;this.strongTime=time;this.candidate=null;this.reason='strong';return true;
      }
    }else{
      this.candidate=null;this.reason=pose.score>=TRACKING.continueScore?'weak-unconfirmed':'low-score';
    }
    return false;
  }
}
