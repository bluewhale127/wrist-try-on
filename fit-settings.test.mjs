import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FitSettings,defaultFit,sanitizeFit} from './fit-settings.js';

test('fit profiles persist independently by tracker and model; corrupt/blocked storage stays usable',()=>{
  let data;const storage={getItem:()=>data,setItem:(k,v)=>{data=v;}};
  const settings=new FitSettings(storage);
  settings.save('hand','sample',{scale:1.62,'wrist-width':1.8,occlusion:false});
  settings.save('wrist','sample',{scale:1.11});
  assert.equal(settings.load('hand','sample').scale,1.62);
  assert.equal(settings.load('hand','sample').occlusion,false);
  assert.equal(settings.load('wrist','sample').scale,1.11);
  assert.equal(settings.load('hand','new.glb').scale,defaultFit('hand').scale);
  data='{bad';assert.deepEqual(settings.load('hand'),defaultFit('hand'));
  assert.equal(new FitSettings({setItem(){throw Error();}}).save('hand','sample',{}),false);
  assert.equal(sanitizeFit({scale:NaN,'wrist-width':200,offset:'0.2'},'hand')['wrist-width'],2);
});
