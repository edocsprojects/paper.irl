/** Bump when mapHtml changes so Fast Refresh remounts the WebView. */
export const MAP_HTML_REVISION = 10;

/**
 * Sentinels for verify-map-trails.js — must stay in the loaded HTML.
 * TRAIL_LAYER_OK proves the visible trail polyline layer ships to the client.
 */
export const TRAIL_RENDER_SENTINEL = "TRAIL_LAYER_OK";

/**
 * Street basemap (OpenFreeMap) — labels stripped.
 * Trails: dedicated source ABOVE fills, white casing + dark/high-contrast stroke
 * (reads on grey roads). State arrives via window.__paperPaint (injectJavaScript).
 */
export function buildMapHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet"/>
<style>
  html,body,#map{margin:0;height:100%;width:100%;background:#dfe5ea;touch-action:none}
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
<!-- ${TRAIL_RENDER_SENTINEL} revision=${MAP_HTML_REVISION} -->
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
const STYLE='https://tiles.openfreemap.org/styles/bright';
const PLAY_ZOOM=15.55;
const CAM_LERP=0.12;
const DOT_LERP=0.22;
/** High-contrast trail core — not road grey (#ccc/#eee). */
const TRAIL_CORE='#111111';
const TRAIL_CORE_WIDTH=5.5;
const TRAIL_CASE='#ffffff';
const TRAIL_CASE_WIDTH=9;
let map, ready=false;
let lastFp='';
let cam={lon:-93.23256,lat:44.97452,zoom:PLAY_ZOOM};
let target={lon:-93.23256,lat:44.97452};
let camRunning=false;
let boundaryDrawn=false;
const seatsLive={};
let rafOn=false;
let lastState=null;

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
  cam.lon += (target.lon-cam.lon)*CAM_LERP;
  cam.lat += (target.lat-cam.lat)*CAM_LERP;
  const dLon=Math.abs(target.lon-cam.lon);
  const dLat=Math.abs(target.lat-cam.lat);
  map.jumpTo({center:[cam.lon,cam.lat],zoom:PLAY_ZOOM});
  if(dLon>1e-7||dLat>1e-7) requestAnimationFrame(tickCam);
  else{
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

function trailCoords(live){
  const base=(live.trail||[]).map(p=>[p.lon,p.lat]);
  if(live.mode!=='trailing' && base.length<1) return null;
  const tip=[live.lon,live.lat];
  if(base.length===0) return null;
  if(base.length===1){
    const a=base[0];
    if(Math.abs(a[0]-tip[0])<1e-9 && Math.abs(a[1]-tip[1])<1e-9) return null;
    return [a, tip];
  }
  const last=base[base.length-1];
  if(Math.abs(last[0]-tip[0])<1e-9 && Math.abs(last[1]-tip[1])<1e-9) return base;
  return base.concat([tip]);
}

function ensureTrailLayers(){
  if(!map.getSource('trails')){
    map.addSource('trails',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  }
  if(!map.getLayer('trails-casing')){
    map.addLayer({
      id:'trails-casing',
      type:'line',
      source:'trails',
      paint:{
        'line-color':TRAIL_CASE,
        'line-opacity':1,
        'line-width':TRAIL_CASE_WIDTH,
        'line-cap':'round',
        'line-join':'round'
      }
    });
  }
  /* ${TRAIL_RENDER_SENTINEL}: visible trail polyline above territory fill */
  if(!map.getLayer('trails')){
    map.addLayer({
      id:'trails',
      type:'line',
      source:'trails',
      paint:{
        'line-color':TRAIL_CORE,
        'line-opacity':1,
        'line-width':TRAIL_CORE_WIDTH,
        'line-cap':'round',
        'line-join':'round'
      }
    });
  }
}

function flushLayers(){
  if(!ready||!map.getSource('players')||!map.getSource('owned')||!lastState) return;
  ensureTrailLayers();
  const owned={type:'FeatureCollection',features:[]};
  /* Prefer RN-built trail FeatureCollection (buildTrailPaint) when present. */
  const trails=(lastState&&lastState.trails&&lastState.trails.type==='FeatureCollection')
    ? lastState.trails
    : {type:'FeatureCollection',features:[]};
  const players={type:'FeatureCollection',features:[]};
  for(const id of Object.keys(seatsLive)){
    const live=seatsLive[id];
    const border=darken(live.color,0.22);
    for(const ring of (live.owned||[])){
      if(!ring||ring.length<3) continue;
      const coords=ringCoords(ring);
      if(coords.length&&(coords[0][0]!==coords[coords.length-1][0]||coords[0][1]!==coords[coords.length-1][1])){
        coords.push(coords[0]);
      }
      owned.features.push({type:'Feature',properties:{fill:live.color,border},geometry:{type:'Polygon',coordinates:[coords]}});
    }
    if(!(lastState&&lastState.trails&&lastState.trails.type==='FeatureCollection')){
      const tc=trailCoords(live);
      if(tc && tc.length>=2){
        trails.features.push({
          type:'Feature',
          properties:{kind:'trail',seatId:live.id||id},
          geometry:{type:'LineString',coordinates:tc}
        });
      }
    }
    players.features.push({
      type:'Feature',
      properties:{color:live.color,you:!!live.you,mode:live.mode||'player'},
      geometry:{type:'Point',coordinates:[live.lon,live.lat]}
    });
    if(live.markerLon!=null){
      players.features.push({
        type:'Feature',
        properties:{color:live.color,you:!!live.you,mode:'marker'},
        geometry:{type:'Point',coordinates:[live.markerLon,live.markerLat]}
      });
    }
  }
  map.getSource('owned').setData(owned);
  map.getSource('trails').setData(trails);
  map.getSource('players').setData(players);
  // Expose for DOM/source assertions in Simulator debugging
  window.__paperTrailFeatureCount=trails.features.length;
}

function tickFrame(){
  rafOn=true;
  let moving=false;
  for(const id of Object.keys(seatsLive)){
    const d=seatsLive[id];
    d.lon += (d.tLon-d.lon)*DOT_LERP;
    d.lat += (d.tLat-d.lat)*DOT_LERP;
    if(Math.abs(d.tLon-d.lon)>2e-8||Math.abs(d.tLat-d.lat)>2e-8) moving=true;
    else{ d.lon=d.tLon; d.lat=d.tLat; }
  }
  flushLayers();
  if(moving) requestAnimationFrame(tickFrame);
  else rafOn=false;
}

function syncSeats(seats){
  const seen={};
  for(const seat of seats||[]){
    const pos=seat.position||seat.respawnAt;
    if(!pos) continue;
    seen[seat.id]=1;
    const prev=seatsLive[seat.id];
    if(!prev){
      seatsLive[seat.id]={
        id:seat.id,
        lon:pos.lon,lat:pos.lat,tLon:pos.lon,tLat:pos.lat,
        color:seat.color,you:!!seat.you,mode:seat.mode||'player',
        trail:(seat.trail||[]).map(p=>({lat:p.lat,lon:p.lon})),
        owned:seat.owned||[],
        markerLon:seat.respawnAt?seat.respawnAt.lon:null,
        markerLat:seat.respawnAt?seat.respawnAt.lat:null
      };
    }else{
      prev.tLon=pos.lon; prev.tLat=pos.lat;
      prev.color=seat.color; prev.you=!!seat.you; prev.mode=seat.mode||'player';
      prev.trail=(seat.trail||[]).map(p=>({lat:p.lat,lon:p.lon}));
      prev.owned=seat.owned||[];
      prev.markerLon=seat.respawnAt?seat.respawnAt.lon:null;
      prev.markerLat=seat.respawnAt?seat.respawnAt.lat:null;
    }
  }
  for(const id of Object.keys(seatsLive)){
    if(!seen[id]) delete seatsLive[id];
  }
  if(!rafOn) requestAnimationFrame(tickFrame);
  else flushLayers();
}

function paint(state){
  if(!ready||!state||!state.arena) return;
  lastState=state;
  const fp=fingerprint(state);
  const you=(state.seats||[]).find(s=>s.you);
  if(fp===lastFp){
    followYou(you);
    return;
  }
  lastFp=fp;
  const arena=state.arena;
  if(!boundaryDrawn){
    const boundary={type:'FeatureCollection',features:[{
      type:'Feature',properties:{},geometry:{type:'LineString',coordinates:circleRing({lat:arena.centerLat,lon:arena.centerLon},arena.radiusM,64)}
    }]};
    map.getSource('boundary').setData(boundary);
    boundaryDrawn=true;
  }
  syncSeats(state.seats||[]);
  followYou(you);
}

/** RN injectJavaScript entry — more reliable than postMessage on iOS HTML WebViews. */
window.__paperPaint=function(msg){
  try{
    const m=typeof msg==='string'?JSON.parse(msg):msg;
    if(m && m.type==='state') paint(m.state);
  }catch(err){}
};

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
  map.addLayer({id:'boundary',type:'line',source:'boundary',paint:{'line-color':'#1b1b1b','line-opacity':0.45,'line-width':2,'line-dasharray':[2,1.4]}});
  map.addSource('owned',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'owned-fill',type:'fill',source:'owned',paint:{'fill-color':['get','fill'],'fill-opacity':0.34}});
  map.addLayer({id:'owned-border',type:'line',source:'owned',paint:{'line-color':['get','border'],'line-opacity':0.95,'line-width':2.4}});
  ensureTrailLayers();
  map.addSource('players',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'markers',type:'circle',source:'players',filter:['==',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],9,6],'circle-color':'#fff','circle-stroke-width':['case',['get','you'],3,2],'circle-stroke-color':['get','color']}});
  // You: modest size + distinct white ring (not a huge blob)
  map.addLayer({id:'players',type:'circle',source:'players',filter:['!=',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],9.5,6.5],'circle-color':['get','color'],'circle-stroke-width':['case',['get','you'],3.5,1.8],'circle-stroke-color':['case',['get','you'],'#ffffff','#f5f5f5']}});
  ready=true; post({type:'ready'});
});
map.on('styledata',()=>{
  if(!ready) return;
  declutter();
  ensureTrailLayers();
});
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
