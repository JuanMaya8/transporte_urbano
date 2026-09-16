// Shared Worker: keeps route ordering and frequency calculations in one place.
let ports=[];
let buses=new Map();
let routeBuses=new Map();
let frequencies={R01:6,R02:7,R03:8,R04:6,R05:10,R06:9,R07:6,R08:8,R09:7,R10:12,R11:10,R12:9,R13:8,R14:7,R15:12,R16:10,R17:8,R18:9,R19:12,R20:10,R21:8,R22:7};

function notify(msg){ports.forEach(p=>p.postMessage(msg));}
function updateOrder(b){
  if(b.inService===false)return;
  if(!routeBuses.has(b.route))routeBuses.set(b.route,[]);
  const arr=routeBuses.get(b.route);
  const idx=arr.indexOf(b.bus);
  if(idx>=0)arr.splice(idx,1);
  let lo=0,hi=arr.length;
  while(lo<hi){const mid=(lo+hi)>>1; if((buses.get(arr[mid])?.s||0)<b.s)lo=mid+1;else hi=mid;}
  arr.splice(lo,0,b.bus);
}
function recalc(){
  const alerts=[];
  routeBuses.forEach((arr,route)=>{
    for(let i=1;i<arr.length;i++){
      const lead=buses.get(arr[i-1]), follow=buses.get(arr[i]);
      if(!lead||!follow)continue;
      const gap=Math.max(0,lead.s-follow.s);
      const scheduled=(frequencies[route]||8)*1000;
      const ratio=gap/scheduled;
      if(ratio<0.40)alerts.push({bus:follow.bus,route,gap,scheduled,type:"bunching",hold:Math.min(4,Math.max(1,Math.round((0.40*scheduled-gap)/60000*10)/10))});
      else if(ratio>1.60)alerts.push({bus:follow.bus,route,gap,scheduled,type:"service gap",hold:0});
    }
  });
  notify({type:"alerts",payload:alerts.slice(0,25)});
}
onconnect=(e)=>{
  const port=e.ports[0]; ports.push(port); port.start();
  port.onmessage=(ev)=>{
    if(ev.data.type==="matched"){
      for(const b of ev.data.payload){
        buses.set(b.bus,b);
        if(b.inService===false){
          const arr=routeBuses.get(b.route);
          const idx=arr?arr.indexOf(b.bus):-1;
          if(idx>=0)arr.splice(idx,1);
        } else {
          updateOrder(b);
        }
      }
      recalc();
    }
    if(ev.data.type==="clear"){buses.clear();routeBuses.clear();}
  };
};
