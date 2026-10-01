import {LIMITS,CAPTURE_VERSION} from './teacher-capture.mjs';
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Storage transaction aborted'));tx.onerror=()=>{};});

export async function openTeacherStore(name='wrist-teacher-01'){
  const r=indexedDB.open(name,1);
  r.onupgradeneeded=()=>{
    const db=r.result;db.createObjectStore('sessions',{keyPath:'id'});
    db.createObjectStore('frames',{keyPath:['sessionId','index']}).createIndex('sessionId','sessionId');
  };
  const db=await request(r);db.onversionchange=()=>db.close();
  return new TeacherStore(db);
}

class TeacherStore {
  constructor(db){this.db=db;}
  async create(meta){
    const session={...meta,id:crypto.randomUUID(),version:CAPTURE_VERSION,createdAt:new Date().toISOString(),count:0,crops:0,bytes:0};
    const tx=this.db.transaction('sessions','readwrite'),done=complete(tx);tx.objectStore('sessions').add(session);await done;return session;
  }
  async sessions(){return (await request(this.db.transaction('sessions').objectStore('sessions').getAll())).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async frames(id){return request(this.db.transaction('frames').objectStore('frames').index('sessionId').getAll(id));}
  async save(id,record){
    // Budget and data are committed atomically across tabs. Counts mean committed writes.
    const tx=this.db.transaction(['sessions','frames'],'readwrite'),done=complete(tx);
    const s=tx.objectStore('sessions'),get=s.getAll();let updated,failure;
    get.onsuccess=()=>{
      try{
        const sessions=get.result,session=sessions.find(v=>v.id===id);
        const bytes=record.image.size+(record.cropImage?.size||0)+new Blob([JSON.stringify(record.label)]).size;
        if(!session)throw Error('Session missing');
        if(session.count>=LIMITS.frames||session.bytes+bytes>LIMITS.bytes||sessions.reduce((n,v)=>n+v.bytes,0)+bytes>LIMITS.totalBytes)throw Error('저장 한도에 도달했어요. 먼저 파일을 내보내 주세요.');
        updated={...session,count:session.count+1,crops:session.crops+(record.cropImage?1:0),bytes:session.bytes+bytes};
        tx.objectStore('frames').add({...record,sessionId:id,index:session.count});s.put(updated);
      }catch(e){failure=e;tx.abort();}
    };
    try{await done;}catch(e){throw failure||e;}return updated;
  }
  async delete(id){
    const tx=this.db.transaction(['sessions','frames'],'readwrite'),done=complete(tx);
    tx.objectStore('sessions').delete(id);
    const r=tx.objectStore('frames').index('sessionId').openKeyCursor(IDBKeyRange.only(id));
    r.onsuccess=()=>{const cursor=r.result;if(cursor){tx.objectStore('frames').delete(cursor.primaryKey);cursor.continue();}};
    await done;
  }
  close(){this.db.close();}
}

const encoder=new TextEncoder();
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const header=length=>{const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};};

// ZIP STORE avoids re-compressing JPEG and has no external/network dependency.
export async function makeZip(files){
  const locals=[],central=[];let offset=0,centralSize=0;
  for(const [path,value] of files){
    if(path.startsWith('/')||path.split('/').includes('..'))throw Error('Unsafe archive path');
    const name=encoder.encode(path),blob=value instanceof Blob?value:new Blob([value]),bytes=new Uint8Array(await blob.arrayBuffer());
    const crc=crc32(bytes),local=header(30),directory=header(46),l=local.view,d=directory.view;
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);
    l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,name.length,true);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);
    d.setUint32(16,crc,true);d.setUint32(20,bytes.length,true);d.setUint32(24,bytes.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);
    locals.push(local.bytes,name,blob);central.push(directory.bytes,name);offset+=30+name.length+bytes.length;centralSize+=46+name.length;
  }
  if(files.length>65535||offset+centralSize>0xffffffff)throw Error('Archive too large');
  const end=header(22),e=end.view;e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...locals,...central,end.bytes],{type:'application/zip'});
}

export async function sessionArchive(session,records){
  const files=[],frames=records.map(r=>{
    const stem=String(r.index).padStart(5,'0'),image=`frames/${stem}.jpg`,cropImage=r.cropImage?`crops/${stem}.jpg`:null;
    files.push([image,r.image]);if(cropImage)files.push([cropImage,r.cropImage]);
    return {index:r.index,image,cropImage,...r.label};
  });
  files.push(['manifest.json',JSON.stringify({schema:CAPTURE_VERSION,session,frames},null,2)]);
  files.push(['README.txt','Teacher pseudo-labels, not independent ground truth. No student training has been run.\nImages and labels share one captured, unmirrored source frame. Pixel coordinates refer to imageSize.\n+Y=twelve, -Y=six, +Z=dial outward, -Z=opposite dial normal, +X=three. Camera +X right, +Y up, +Z toward camera.\ncenter2d is the projected GLB case-contact origin. Z is relative renderer depth, NOT measured camera distance.\nReview wrist centers, rotations, and candidate crops before training. A crop excludes predicted hand landmarks, not a verified segmentation.\nSplit evaluation by recording session/person/environment, not adjacent frames.\n']);
  return makeZip(files);
}
