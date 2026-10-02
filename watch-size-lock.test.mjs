import test from 'node:test';import assert from 'node:assert/strict';
import {WatchSizeLock} from './watch-size-lock.mjs';
test('rotation scale noise and hand loss do not resize the case or wrist mask',()=>{
 const lock=new WatchSizeLock();const first=lock.dimensions({size:65,wristRadius:30},1);
 assert.equal(lock.dimensions(null,1),null);
 assert.deepEqual(lock.dimensions({size:110,wristRadius:51},1),first);
 assert.deepEqual(lock.dimensions({size:40,wristRadius:19},1),first);
});
test('manual size changes the case without changing the wrist circumference',()=>{
 const lock=new WatchSizeLock();lock.dimensions({size:52,wristRadius:30},.8);
 assert.deepEqual(lock.dimensions({size:140,wristRadius:90},1.2),{size:78,wristRadius:30});
});
test('only an explicit reset replaces the captured size; invalid observations cannot capture it',()=>{
 const lock=new WatchSizeLock();assert.equal(lock.dimensions({size:NaN,wristRadius:30},1),null);
 lock.dimensions({size:65,wristRadius:30},1);lock.reset();
 assert.deepEqual(lock.dimensions({size:80,wristRadius:40},1),{size:80,wristRadius:40});
});
