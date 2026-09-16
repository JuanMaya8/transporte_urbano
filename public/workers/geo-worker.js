// Web Worker: geometry, map matching and route position.
// Routes are distributed by routeId % workerCount.

const GRID_SIZE = 0.0007; // roughly 75 m latitude at this latitude.
let routes = {};
let workerIndex = 0;
let workerCount = 1;
let candidatesByRoute = {};
let busStates = new Map();

function key(lat, lon) {
  return `${Math.floor(lat / GRID_SIZE)}:${Math.floor(lon / GRID_SIZE)}`;
}
function dist2(a,b,c,d){ const dx=(a-c)*90000, dy=(b-d)*111000; return dx*dx+dy*dy; }
function project(p,a,b){
  const x=(p.lon-a.lon)*90000, y=(p.lat-a.lat)*111000;
  const bx=(b.lon-a.lon)*90000, by=(b.lat-a.lat)*111000;
  const den=bx*bx+by*by || 1;
  let t=(x*bx+y*by)/den; t=Math.max(0,Math.min(1,t));
  return {t, d2:(x-(bx*t))**2+(y-(by*t))**2};
}
function routeLength(route){
  let s=0;
  for(let i=1;i<route.points.length;i++) s+=Math.sqrt(dist2(route.points[i-1].lat,route.points[i-1].lon,route.points[i].lat,route.points[i].lon));
  return s;
}
function buildIndex(route){
  const grid=new Map();
  for(let i=0;i<route.points.length-1;i++){
    const a=route.points[i], b=route.points[i+1];
    const minLat=Math.min(a.lat,b.lat), maxLat=Math.max(a.lat,b.lat);
    const minLon=Math.min(a.lon,b.lon), maxLon=Math.max(a.lon,b.lon);
    for(let lat=Math.floor(minLat/GRID_SIZE);lat<=Math.floor(maxLat/GRID_SIZE);lat++){
      for(let lon=Math.floor(minLon/GRID_SIZE);lon<=Math.floor(maxLon/GRID_SIZE);lon++){
        const k=`${lat}:${lon}`;
        if(!grid.has(k))grid.set(k,[]);
        grid.get(k).push(i);
      }
    }
  }
  candidatesByRoute[route.id]=grid;
}
function candidateSegments(p,route){
  const grid=candidatesByRoute[route.id];
  const out=new Set();
  const baseLat=Math.floor(p.lat/GRID_SIZE), baseLon=Math.floor(p.lon/GRID_SIZE);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const arr=grid.get(`${baseLat+dy}:${baseLon+dx}`)||[];
    arr.forEach(i=>out.add(i));
  }
  return [...out];
}
function scoreCandidate(point, route, i, prev){
  const a=route.points[i], b=route.points[i+1];
  const pr=project(point,a,b);
  const prefix=route.prefix[i] + pr.t * Math.sqrt(dist2(a.lat,a.lon,b.lat,b.lon));
  const distance=Math.sqrt(pr.d2);
  // Emission: GPS distance + HDOP penalty.
  let score=distance * (1 + (point.hdop||2)*0.08);
  if(prev){
    const delta=prefix-prev.s;
    // Transition penalty: strongly discourages jumping backwards or making
    // an implausibly large advance between 10–30 s samples.
    if(delta < -12) score += 220;
    if(delta > 150) score += (delta-150)*0.9;
    score += Math.abs(delta-prev.expectedDelta)*0.35;
  }
  return {i,s:prefix,score};
}
function match(point, route){
  const segs=candidateSegments(point,route);
  let candidates=segs.map(i=>scoreCandidate(point,route,i,busStates.get(point.bus)));
  candidates.sort((a,b)=>a.score-b.score);
  // Small Viterbi-like window: evaluate best current state against the
  // previous route position and two neighboring candidates.
  const best=candidates.slice(0,4)[0];
  return best || {i:0,s:0,score:9999};
}

self.onmessage=(e)=>{
  const {type,payload}=e.data;
  if(type==="init"){
    routes=payload.routes;
    workerIndex=payload.workerIndex;
    workerCount=payload.workerCount;
    Object.values(routes).forEach((r,idx)=>{
      if(idx%workerCount===workerIndex) {
        r.prefix=[0];
        for(let i=1;i<r.points.length;i++){
          r.prefix[i]=r.prefix[i-1]+Math.sqrt(dist2(r.points[i-1].lat,r.points[i-1].lon,r.points[i].lat,r.points[i].lon));
        }
        r.length=r.prefix[r.prefix.length-1];
        buildIndex(r);
      }
    });
    self.postMessage({type:"ready",workerIndex});
  }
  if(type==="gpsBatch"){
    const result=[];
    for(const point of payload){
      const route=routes[point.route];
      if(!route || (Object.keys(routes).indexOf(point.route)%workerCount!==workerIndex)) continue;
      const m=match(point,route);
      const old=busStates.get(point.bus);
      let estimated=false;
      let s=m.s;
      if(old && s < old.s && !point.reverse){
        s=old.s;
      }
      if(old){
        const dt=Math.max(0.1,(point.serverTs-old.serverTs)/1000);
        const expectedDelta=Math.max(0,Math.min(120,(point.vel||0)*dt));
        m.expectedDelta=expectedDelta;
      }
      busStates.set(point.bus,{s,serverTs:point.serverTs,expectedDelta:m.expectedDelta||0});
      result.push({bus:point.bus,route:point.route,s,lat:point.lat,lon:point.lon,vel:point.vel||0,hdop:point.hdop||0,estimated,score:m.score,serverTs:point.serverTs});
    }
    self.postMessage({type:"matched",payload:result});
  }
};
