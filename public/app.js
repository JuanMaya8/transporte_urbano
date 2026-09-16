const $=id=>document.getElementById(id);
const canvas=$("mapCanvas"),ctx=canvas.getContext("2d");
let running=false,offline=false,forceBunch=false,simTime=0,lastFrame=performance.now();
let buses=new Map(),history=new Map(),alerts=[],workerReady=0;
const workerCount=Math.min(4,Math.max(2,(navigator.hardwareConcurrency||4)-1));
const geoWorkers=Array.from({length:workerCount},(_,i)=>{
  const w=new Worker("workers/geo-worker.js");w.onmessage=onGeo;return w;
});
const fleet=new SharedWorker("workers/fleet-worker.js");
fleet.port.start();fleet.port.onmessage=e=>{if(e.data.type==="alerts"){alerts=e.data.payload;renderAlerts()}};

const routes=makeRoutes();
const routeIds=Object.keys(routes);

function makeRoutes(){
  const out={};
  for(let r=1;r<=22;r++){
    const id=`R${String(r).padStart(2,"0")}`, pts=[];
    // Three corridors with a 25 m parallel pair in the center.
    const baseLat=1.2122+(r%6)*0.00035;
    const baseLon=-77.2830+(Math.floor(r/6))*0.0009;
    for(let i=0;i<120;i++){
      const t=i/119;
      let lat=baseLat+0.006*t+Math.sin(t*8+r)*0.00010;
      let lon=baseLon+0.008*t+Math.cos(t*6+r)*0.00010;
      if(r%4===0 && t>.38&&t<.66) lon+=0.00023; // parallel street
      pts.push({lat,lon});
    }
    out[id]={id,points:pts};
  }
  return out;
}
function initWorkers(){
  geoWorkers.forEach((w,i)=>w.postMessage({type:"init",payload:{routes,workerIndex:i,workerCount:workerCount}}));
}
function onGeo(e){
  if(e.data.type==="matched"){
    e.data.payload.forEach(b=>{
      buses.set(b.bus,b);
      if(!history.has(b.bus))history.set(b.bus,[]);
      const h=history.get(b.bus);
      h.push({...b,t:simTime});
      if(h.length>720)h.shift();
    });
    fleet.port.postMessage({type:"matched",payload:e.data.payload});
    updateMetrics();
  }
}
function generateFleet(){
  const arr=[];
  for(let i=0;i<310;i++){
    const route=routeIds[i%22];
    let s=(i*137)%8000;
    if(forceBunch && i<12)s=3500+(i%3)*50;
    const p=pointAt(routes[route],s);
    arr.push({bus:i+1,route,lat:p.lat,lon:p.lon,vel:6+(i%5)*.5,hdop:2+(i%5)*.6,serverTs:Date.now()});
  }
  return arr;
}
function pointAt(route,s){
  let acc=0;
  for(let i=1;i<route.points.length;i++){
    const a=route.points[i-1],b=route.points[i],len=Math.hypot((a.lat-b.lat)*111000,(a.lon-b.lon)*90000);
    if(acc+len>=s){const t=(s-acc)/len;return{lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t}}
    acc+=len;
  }
  return route.points.at(-1);
}
function tick(){
  if(!running)return;
  simTime+=1;
  const points=[];
  buses.forEach(b=>{
    const delta=(b.vel||6)*1.0;
    let s=b.s+delta;
    if(forceBunch && b.bus<=12)s=3500+(b.bus%3)*50+Math.sin(simTime/3)*12;
    const p=pointAt(routes[b.route],s);
    points.push({...b,lat:p.lat,lon:p.lon,serverTs:Date.now(),s:undefined});
  });
  // Add a little noise and occasional bad data.
  points.forEach(p=>{
    p.lat+=(Math.random()-.5)*0.00010*(p.hdop/3);
    p.lon+=(Math.random()-.5)*0.00010*(p.hdop/3);
    if(Math.random()<.03)p.serverTs-=5000;
  });
  for(let i=0;i<geoWorkers.length;i++)geoWorkers[i].postMessage({type:"gpsBatch",payload:points.filter((_,idx)=>idx%workerCount===i)});
  setTimeout(tick,1000);
}
function draw(){
  resizeCanvas();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // Background grid / city blocks.
  ctx.strokeStyle="#dce2e8";ctx.lineWidth=1;
  for(let x=0;x<canvas.width;x+=45){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}
  for(let y=0;y<canvas.height;y+=45){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}
  const visible=Array.from(buses.values()).filter(b=>b.lat>1.211&&b.lat<1.220&&b.lon>-77.284&&b.lon<-77.273);
  // routes
  Object.values(routes).forEach(r=>{
    ctx.beginPath();
    r.points.forEach((p,i)=>{const q=projectCanvas(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y)});
    ctx.strokeStyle="#b6bec8";ctx.lineWidth=1;ctx.stroke();
  });
  visible.forEach(b=>{
    const q=projectCanvas(b);const risk=alerts.some(a=>a.bus===b.bus&&a.type==="bunching");
    ctx.beginPath();ctx.arc(q.x,q.y,4,0,Math.PI*2);
    ctx.fillStyle=risk?"#d94b3d":"#268b57";ctx.fill();
  });
  requestAnimationFrame(draw);
}
function projectCanvas(p){
  const x=(p.lon+77.284)/.011*canvas.width;
  const y=canvas.height-(p.lat-1.211)/.009*canvas.height;
  return{x,y};
}
function resizeCanvas(){const d=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==w*d||canvas.height!==h*d){canvas.width=w*d;canvas.height=h*d;ctx.setTransform(d,0,0,d,0,0)}}
function updateMetrics(){
  $("busCount").textContent=`${buses.size} buses`;
  $("activeCount").textContent=[...buses.values()].filter(b=>b.route).length;
  $("riskCount").textContent=alerts.filter(a=>a.type==="bunching").length;
  $("gapCount").textContent=alerts.filter(a=>a.type==="service gap").length;
  $("lastKnown").textContent=`Last known state: ${new Date().toLocaleTimeString()} · ${buses.size} vehicles`;
}
function renderAlerts(){
  $("alerts").innerHTML=alerts.length?alerts.slice(0,10).map(a=>`<div class="alert"><b>${a.type.toUpperCase()}</b> · ${a.route} · Bus ${a.bus}<br>Gap: ${(a.gap/1000).toFixed(1)} m equivalent · Hold suggestion: ${a.hold||0} min</div>`).join(""):"<span>No current alerts.</span>";
  updateMetrics();
}
function setupPerformance(){
  if(!("PerformanceObserver" in window))return;
  try{
    const po=new PerformanceObserver(list=>{
      const entries=list.getEntries();
      const long=entries.filter(e=>e.duration>50).length;
      $("performanceLog").innerHTML=`<span>Long tasks: ${long}</span><span>Isolation: ${crossOriginIsolated}</span><span>Workers: ${workerCount}</span>`;
    });
    po.observe({entryTypes:["longtask"]});
  }catch(_){}
}
async function queueAction(action){
  const item={id:crypto.randomUUID(),action,time:new Date().toISOString()};
  const req=indexedDB.open("case3",1);req.onupgradeneeded=()=>req.result.createObjectStore("actions",{keyPath:"id"});
  req.onsuccess=()=>{const db=req.result;db.transaction("actions","readwrite").objectStore("actions").put(item);$("queueInfo").textContent="Offline queue: saved action";navigator.serviceWorker?.ready.then(r=>r.sync?.register("supervisor-actions")).catch(()=>{})};
}
$("startBtn").onclick=()=>{running=true;$("startBtn").disabled=true;$("stopBtn").disabled=false;tick()};
$("stopBtn").onclick=()=>{running=false;$("startBtn").disabled=false;$("stopBtn").disabled=true};
$("bunchBtn").onclick=()=>{forceBunch=true;setTimeout(()=>forceBunch=false,15000)};
$("offlineBtn").onclick=()=>{offline=!offline;navigator.onLine=offline?false:true;$("connectionText").textContent=offline?"Offline (simulated)":"Online";$("connectionDot").style.background=offline?"#d94b3d":"#32b46b"};
$("historyRange").oninput=e=>$("historyLabel").textContent=e.target.value==="120"?"Live":`${120-e.target.value} min ago`;
document.querySelectorAll("[data-action]").forEach(b=>b.onclick=()=>queueAction(b.dataset.action));
window.addEventListener("resize",resizeCanvas);
$("isolationBadge").textContent=`crossOriginIsolated: ${crossOriginIsolated}`;
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js");
initWorkers();
generateFleet().forEach(b=>buses.set(b.bus,b));
setupPerformance();renderAlerts();updateMetrics();draw();
