// RT-2 reference: double-buffered SharedArrayBuffer.
// This file is intentionally small so it is easy to explain in class.
export function createFleetSharedState(busCount=310){
  const fields=8;
  const sab=new SharedArrayBuffer(busCount*fields*Float64Array.BYTES_PER_ELEMENT*2);
  const versions=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*2);
  return {
    sab,
    versions,
    read:new Float64Array(sab,0,busCount*fields),
    write:new Float64Array(sab,busCount*fields*Float64Array.BYTES_PER_ELEMENT,busCount*fields),
    version:new Int32Array(versions)
  };
}

// Writer: write to the inactive buffer, then publish atomically.
export function publish(state, slot){
  Atomics.store(state.version,0,slot);
  Atomics.add(state.version,1,1);
}

// Reader: if version changes while copying, discard the copy and retry.
export function readStable(state, target){
  while(true){
    const before=Atomics.load(state.version,1);
    const slot=Atomics.load(state.version,0);
    const source=slot===0?state.read:state.write;
    target.set(source);
    const after=Atomics.load(state.version,1);
    if(before===after)return true;
  }
}
