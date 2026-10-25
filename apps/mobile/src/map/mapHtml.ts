/** Street-map WebView (OpenFreeMap) — no Google key. */
export function buildMapHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet"/>
<style>
  html,body,#map{margin:0;height:100%;width:100%;background:#e8ecef}
  .hud{position:absolute;z-index:2;left:10px;top:10px;right:10px;display:flex;justify-content:space-between;pointer-events:none}
  .board,.timer{background:rgba(255,255,255,.94);border-radius:14px;padding:8px 10px;font:700 13px Manrope,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.12)}
  .board{min-width:150px}
  .board div{display:flex;gap:6px;align-items:center;margin-top:4px}
  .dot{width:8px;height:8px;border-radius:99px}
  .snacks{position:absolute;z-index:3;left:50%;bottom:24px;transform:translateX(-50%);width:min(340px,92vw);display:flex;flex-direction:column;gap:6px;pointer-events:none}
  .snack{background:rgba(27,27,27,.92);color:#fff;border-radius:12px;padding:10px 12px;font:650 13px Manrope,system-ui,sans-serif}
  .snack.good{background:rgba(22,101,52,.95)}
  .snack.bad{background:rgba(153,27,27,.95)}
  .snack.warn{background:rgba(146,64,14,.95)}
</style>
</head>
<body>
<div id="map"></div>
<div class="hud">
  <div class="board" id="board"></div>
  <div class="timer" id="timer">--:--</div>
</div>
<div class="snacks" id="snacks"></div>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
const STYLE='https://tiles.openfreemap.org/styles/bright';
let map, ready=false;
function post(msg){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
function darken(hex,a){const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);
  const r=Math.max(0,((n>>16)&255)*(1-a)),g=Math.max(0,((n>>8)&255)*(1-a)),b=Math.max(0,(n&255)*(1-a));
  return 'rgb('+Math.round(r)+','+Math.round(g)+','+Math.round(b)+')';}
function fmt(ms){const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function edgeLine(graph,id){const e=graph.edges[id],a=graph.nodes[e.a],b=graph.nodes[e.b];return [[a.lon,a.lat],[b.lon,b.lat]];}
function paint(state){
  if(!ready||!state||!state.graph) return;
  const g=state.graph;
  const owned={type:'FeatureCollection',features:[]};
  for(const seat of state.seats||[]){
    const border=darken(seat.color,0.32);
    for(const id of (seat.ownedEdges||[])){
      owned.features.push({type:'Feature',properties:{fill:seat.color,border,kind:'owned'},geometry:{type:'LineString',coordinates:edgeLine(g,id)}});
    }
    for(const id of (seat.trail||[])){
      owned.features.push({type:'Feature',properties:{fill:seat.color,border,kind:'trail'},geometry:{type:'LineString',coordinates:edgeLine(g,id)}});
    }
  }
  const players={type:'FeatureCollection',features:[]};
  for(const seat of state.seats||[]){
    const node=g.nodes[seat.headNode??seat.respawnNode??0];
    if(!node) continue;
    players.features.push({type:'Feature',properties:{color:seat.color,you:!!seat.you},geometry:{type:'Point',coordinates:[node.lon,node.lat]}});
    if(seat.respawnNode!=null){
      const m=g.nodes[seat.respawnNode];
      players.features.push({type:'Feature',properties:{color:seat.color,mode:'marker'},geometry:{type:'Point',coordinates:[m.lon,m.lat]}});
    }
  }
  map.getSource('owned').setData(owned);
  map.getSource('players').setData(players);
  const you=state.seats.find(s=>s.you);
  if(you){
    const n=g.nodes[you.headNode??you.respawnNode??0];
    if(n) map.easeTo({center:[n.lon,n.lat],duration:250});
  }
  const board=document.getElementById('board');
  board.innerHTML='<div style="font-size:10px;letter-spacing:.12em;color:#6b7280">LEADERBOARD</div>'+
    (state.top3||[]).map((s,i)=>'<div><span class="dot" style="background:'+s.color+'"></span><span>'+(i+1)+' '+s.nickname+'</span><span style="margin-left:auto;color:#6b7280">'+Math.round(s.areaM2)+' m²</span></div>').join('');
  document.getElementById('timer').textContent=fmt(state.remainingMs||0);
}
function snack(text,tone){
  const el=document.createElement('div');
  el.className='snack '+(tone||'');
  el.textContent=text;
  document.getElementById('snacks').prepend(el);
  setTimeout(()=>el.remove(),4000);
}
map=new maplibregl.Map({container:'map',style:STYLE,center:[-93.23256,44.97452],zoom:15.5});
map.on('load',()=>{
  map.addSource('owned',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'owned-fill',type:'line',source:'owned',filter:['==',['get','kind'],'owned'],paint:{'line-color':['get','fill'],'line-opacity':0.38,'line-width':14}});
  map.addLayer({id:'owned-border',type:'line',source:'owned',filter:['==',['get','kind'],'owned'],paint:{'line-color':['get','border'],'line-opacity':0.95,'line-width':4.5}});
  map.addLayer({id:'trails',type:'line',source:'owned',filter:['==',['get','kind'],'trail'],paint:{'line-color':['get','border'],'line-width':3.2,'line-dasharray':[1.4,1.1]}});
  map.addSource('players',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'markers',type:'circle',source:'players',filter:['==',['get','mode'],'marker'],paint:{'circle-radius':7,'circle-color':'#fff','circle-stroke-width':3,'circle-stroke-color':['get','color']}});
  map.addLayer({id:'players',type:'circle',source:'players',filter:['!=',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],10,7],'circle-color':['get','color'],'circle-stroke-width':2,'circle-stroke-color':'#fff'}});
  ready=true; post({type:'ready'});
});
document.addEventListener('message',onMsg);
window.addEventListener('message',onMsg);
function onMsg(e){
  try{
    const msg=typeof e.data==='string'?JSON.parse(e.data):e.data;
    if(msg.type==='state') paint(msg.state);
    if(msg.type==='snack') snack(msg.text,msg.tone);
  }catch(err){}
}
</script>
</body>
</html>`;
}
