const CACHE="case3-v2";
const SHELL=["/","/index.html","/styles.css","/app.js","/workers/geo-worker.js","/workers/fleet-worker.js"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{
    const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)); return r;
  }).catch(()=>cached)));
});
self.addEventListener("sync",e=>{
  if(e.tag==="supervisor-actions") e.waitUntil(flushQueue());
});
async function flushQueue(){
  const db=await openDB();
  const actions=await getAll(db);
  if(!navigator.onLine)return;
  for(const a of actions){
    try{
      await fetch("/api/actions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a)});
      await del(db,a.id);
    }catch(_){}
  }
}
function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open("case3",1);r.onupgradeneeded=()=>r.result.createObjectStore("actions",{keyPath:"id"});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function getAll(db){return new Promise((res,rej)=>{const q=db.transaction("actions").objectStore("actions").getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}
function del(db,id){return new Promise((res,rej)=>{const q=db.transaction("actions","readwrite").objectStore("actions").delete(id);q.onsuccess=()=>res();q.onerror=()=>rej(q.error)})}
