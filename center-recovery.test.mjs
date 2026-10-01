import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCenter,rotatePlanes} from './wrist-center/center-consensus-01.mjs';
import {CenterObservation} from './wrist-center/recovery-observation-01.mjs';
const p=(x=100,y=100,score=.7,evidence='single')=>({x,y,score,accepted:true,evidence});
test('right-angle tensor rotation and inverse preserve pixel and channel coordinates',()=>{
 const a=Float32Array.from({length:27},(_,i)=>i);
 assert.deepEqual([...rotatePlanes(a,3,3,1)].slice(0,9),[2,5,8,1,4,7,0,3,6]);
 for(let k=0;k<4;k++)assert.deepEqual(rotatePlanes(rotatePlanes(a,3,3,k),3,3,4-k),a);
});
test('weak isolated or disagreeing views cannot authorize acquisition',()=>{
 assert.equal(selectCenter([p(100,100,.49)],400,600).accepted,false);
 assert.equal(selectCenter([p(100,100,.49),p(240,300,.5)],400,600).accepted,false);
 assert.equal(selectCenter([p(-1,100,.8),p(100,100,.4)],400,600).accepted,false);
 const r=selectCenter([p(100,100,.45),p(110,100,.3)],400,600);
 assert.equal(r.evidence,'corroborated');assert.equal(r.score,.45);assert.equal(r.x,104);
});
test('recovery needs three captures, ordinary high confidence two',()=>{
 const t=new CenterObservation();
 assert.equal(t.update(p(100,100,.45,'corroborated'),0,400,600,100),false);
 assert.equal(t.update(p(100,100,.45,'corroborated'),80,400,600,180),false);
 assert.equal(t.update(p(100,100,.45,'corroborated'),160,400,600,260),true);
});
test('160ms inference latency does not break capture continuity',()=>{
 const t=new CenterObservation();
 for(let i=0;i<8;i++){t.update(p(),i*166,400,600,i*166+160);if(i>0)assert.ok(t.sample(i*166+160));}
 assert.ok(t.sample(7*166+160+166));
 assert.equal(t.sample(7*166+160+191),null);
});
test('stale, out-of-order and missing detections cannot keep a lock alive',()=>{
 const t=new CenterObservation();t.update(p(),0,400,600,100);t.update(p(),80,400,600,180);
 assert.equal(t.update(p(),79,400,600,190),false);
 assert.equal(t.update(p(),160,400,600,400),false);
 assert.equal(t.sample(431),null);
});
test('a sudden remote peak does not interpolate across the scene',()=>{
 const t=new CenterObservation();t.update(p(),0,400,600);t.update(p(),80,400,600);
 assert.equal(t.update(p(350,450),160,400,600),false);
 assert.equal(t.sample(160).x,100);
});
test('camera dimension change clears old center and evidence',()=>{
 const t=new CenterObservation();t.update(p(),0,400,600);t.update(p(),80,400,600);
 t.update(p(),160,600,400);assert.equal(t.sample(160),null);
});
