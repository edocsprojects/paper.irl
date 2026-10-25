/** Bump when mapHtml changes so Fast Refresh remounts the WebView. */
export const MAP_HTML_REVISION = 4;

/**
 * Street basemap (OpenFreeMap) — labels stripped, compact OSM credit,
 * camera lerps to P1 at neighborhood zoom. Map stays; watermarks/labels go.
 */
export function buildMapHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet"/>
<style>
  html,body,#map{margin:0;height:100%;width:100%;background:#dfe5ea}
  .maplibregl-ctrl-attrib{
    font:500 9px/1.2 Avenir Next,system-ui,sans-serif !important;
    background:rgba(255,255,255,.45) !important;
    color:#555 !important;
    padding:1px 5px !important;
    margin:0 4px 4px 0 !important;
    border-radius:2px !important;
    max-width:42vw;
    box-shadow:none !important;
  }
  .maplibregl-ctrl-attrib a{color:#666 !important}
  .maplibregl-ctrl-logo{display:none !important}
  .maplibregl-ctrl-bottom-left{display:none !important}
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
const STYLE='https://tiles.openfreemap.org/styles/bright';
const PLAY_ZOOM=16.35;
const LERP=0.14;
let map, ready=false;
let lastFp='';
let cam={lon:-93.23256,lat:44.97452,zoom:PLAY_ZOOM};
let target={lon:-93.23256,lat:44.97452};
let camRunning=false;
let boundaryDrawn=false;

function post(msg){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
function darken(hex,a){const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);
  const r=Math.max(0,((n>>16)&255)*(1-a)),g=Math.max(0,((n>>8)&255)*(1-a)),b=Math.max(0,(n&255)*(1-a));
  return 'rgb('+Math.round(r)+','+Math.round(g)+','+Math.round(b)+')';}
function ringCoords(ring){return (ring||[]).map(p=>[p.lon,p.lat]);}
function circleRing(center,radiusM,steps){
  const out=[];
  const mLat=111320;
  const mLon=111320*Math.cos(center.lat*Math.PI/180);
  for(let i=0;i<=steps;i++){
    const t=(i/steps)*Math.PI*2;
    out.push([center.lon+(radiusM*Math.cos(t))/mLon, center.lat+(radiusM*Math.sin(t))/mLat]);
  }
  return out;
}
/** Hide street / bus / POI / neighborhood / place labels — keep road geometry. */
function declutter(){
  const layers=(map.getStyle()&&map.getStyle().layers)||[];
  for(const layer of layers){
    const id=(layer.id||'').toLowerCase();
    if(layer.type==='symbol'){
      try{ map.setLayoutProperty(layer.id,'visibility','none'); }catch(e){}
      continue;
    }
    if(/label|place|poi|transit|bus|rail|ferry|airport|housenumber|water_name|road_name|shield|station/.test(id)){
      try{ map.setLayoutProperty(layer.id,'visibility','none'); }catch(e){}
    }
  }
}
function seatFp(seats){
  return (seats||[]).map(s=>{
    const tip=s.trail&&s.trail.length?s.trail[s.trail.length-1]:null;
    const p=s.position||s.respawnAt;
    return [s.id,s.mode,Math.round(s.areaM2||0),(s.trail||[]).length,(s.owned||[]).length,
      p?p.lat.toFixed(6)+','+p.lon.toFixed(6):'',
      tip?tip.lat.toFixed(6)+','+tip.lon.toFixed(6):'',
      s.respawnAt?s.respawnAt.lat.toFixed(6):''].join(':');
  }).join('|');
}
function fingerprint(state){
  return (state.arena&&state.arena.id)+'#'+seatFp(state.seats);
}
function tickCam(){
  camRunning=true;
  cam.lon += (target.lon-cam.lon)*LERP;
  cam.lat += (target.lat-cam.lat)*LERP;
  const dLon=Math.abs(target.lon-cam.lon);
  const dLat=Math.abs(target.lat-cam.lat);
  map.jumpTo({center:[cam.lon,cam.lat],zoom:PLAY_ZOOM});
  if(dLon>1e-7||dLat>1e-7){
    requestAnimationFrame(tickCam);
  }else{
    cam.lon=target.lon; cam.lat=target.lat;
    map.jumpTo({center:[cam.lon,cam.lat],zoom:PLAY_ZOOM});
    camRunning=false;
  }
}
function followYou(you){
  const p=you&&(you.position||you.respawnAt);
  if(!p) return;
  target={lon:p.lon,lat:p.lat};
  if(!camRunning) requestAnimationFrame(tickCam);
}
function paint(state){
  if(!ready||!state||!state.arena) return;
  const fp=fingerprint(state);
  if(fp===lastFp){
    followYou((state.seats||[]).find(s=>s.you));
    return;
  }
  lastFp=fp;
  const arena=state.arena;
  const owned={type:'FeatureCollection',features:[]};
  for(const seat of state.seats||[]){
    const border=darken(seat.color,0.32);
    for(const ring of (seat.owned||[])){
      if(!ring||ring.length<3) continue;
      const coords=ringCoords(ring);
      if(coords.length&&(coords[0][0]!==coords[coords.length-1][0]||coords[0][1]!==coords[coords.length-1][1])){
        coords.push(coords[0]);
      }
      owned.features.push({type:'Feature',properties:{fill:seat.color,border,kind:'owned'},geometry:{type:'Polygon',coordinates:[coords]}});
    }
    if((seat.trail||[]).length>=2){
      owned.features.push({type:'Feature',properties:{fill:seat.color,border,kind:'trail'},geometry:{type:'LineString',coordinates:ringCoords(seat.trail)}});
    }
  }
  const players={type:'FeatureCollection',features:[]};
  for(const seat of state.seats||[]){
    const pos=seat.position||seat.respawnAt;
    if(pos){
      players.features.push({type:'Feature',properties:{color:seat.color,you:!!seat.you,mode:seat.mode||'player'},geometry:{type:'Point',coordinates:[pos.lon,pos.lat]}});
    }
    if(seat.respawnAt){
      players.features.push({type:'Feature',properties:{color:seat.color,you:!!seat.you,mode:'marker'},geometry:{type:'Point',coordinates:[seat.respawnAt.lon,seat.respawnAt.lat]}});
    }
  }
  if(!boundaryDrawn || (state.arena&&state.arena.id)){
    const boundary={type:'FeatureCollection',features:[{
      type:'Feature',properties:{},geometry:{type:'LineString',coordinates:circleRing({lat:arena.centerLat,lon:arena.centerLon},arena.radiusM,64)}
    }]};
    map.getSource('boundary').setData(boundary);
    boundaryDrawn=true;
  }
  map.getSource('owned').setData(owned);
  map.getSource('players').setData(players);
  followYou((state.seats||[]).find(s=>s.you));
}
map=new maplibregl.Map({
  container:'map',
  style:STYLE,
  center:[cam.lon,cam.lat],
  zoom:PLAY_ZOOM,
  attributionControl:{compact:true,customAttribution:'© OpenStreetMap'},
  dragPan:false,
  dragRotate:false,
  scrollZoom:false,
  boxZoom:false,
  doubleClickZoom:false,
  touchZoomRotate:false,
  keyboard:false
});
map.on('load',()=>{
  declutter();
  map.addSource('boundary',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'boundary',type:'line',source:'boundary',paint:{'line-color':'#1b1b1b','line-opacity':0.5,'line-width':2,'line-dasharray':[2,1.4]}});
  map.addSource('owned',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'owned-fill',type:'fill',source:'owned',filter:['==',['get','kind'],'owned'],paint:{'fill-color':['get','fill'],'fill-opacity':0.38}});
  map.addLayer({id:'owned-border',type:'line',source:'owned',filter:['==',['get','kind'],'owned'],paint:{'line-color':['get','border'],'line-opacity':0.95,'line-width':2.8}});
  map.addLayer({id:'trails',type:'line',source:'owned',filter:['==',['get','kind'],'trail'],paint:{'line-color':['get','border'],'line-opacity':0.95,'line-width':3.4,'line-dasharray':[1.4,1.1]}});
  map.addSource('players',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'markers',type:'circle',source:'players',filter:['==',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],9,6],'circle-color':'#fff','circle-stroke-width':3,'circle-stroke-color':['get','color']}});
  map.addLayer({id:'players',type:'circle',source:'players',filter:['!=',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],10,7],'circle-color':['get','color'],'circle-stroke-width':2,'circle-stroke-color':'#fff'}});
  ready=true; post({type:'ready'});
});
map.on('styledata',()=>{ if(ready) declutter(); });
document.addEventListener('message',onMsg);
window.addEventListener('message',onMsg);
function onMsg(e){
  try{
    const msg=typeof e.data==='string'?JSON.parse(e.data):e.data;
    if(msg.type==='state') paint(msg.state);
  }catch(err){}
}
</script>
</body>
</html>`;
}
