/** Bump when mapHtml changes so Fast Refresh remounts the WebView. */
export const MAP_HTML_REVISION = 20;

/**
 * Sentinel kept in the loaded HTML (grep-able in Safari Web Inspector).
 * TRAIL_LAYER_OK proves the visible trail polyline layer ships to the client.
 */
export const TRAIL_RENDER_SENTINEL = "TRAIL_LAYER_OK";

/**
 * Street basemap (OpenFreeMap) — labels stripped.
 * Paper.io look: each player's base colour drives four shades — solid zone
 * fill, darker zone rim, lighter trail, dark trail edge — over a washed-out
 * basemap. Dots glide between server updates; the camera rides your dot.
 * State arrives via window.__paperPaint (injectJavaScript).
 *
 * NOTE: line-cap / line-join are LAYOUT properties. Putting them in `paint`
 * makes MapLibre's addLayer validation reject the whole layer. And declutter
 * must skip OWN_LAYERS: its /rail/ basemap filter matches "trails" and used
 * to hide them on every styledata event (rev ≤11: trails never visible).
 */
export function buildMapHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet"/>
<style>
  html,body,#map{margin:0;height:100%;width:100%;background:#111417;touch-action:none}
  .maplibregl-ctrl-attrib{
    font:500 9px/1.2 Avenir Next,system-ui,sans-serif !important;
    background:rgba(20,20,20,.55) !important;
    color:#8b95a1 !important;
    padding:1px 5px !important;
    margin:0 4px 4px 0 !important;
    border-radius:2px !important;
    max-width:42vw;
    box-shadow:none !important;
  }
  .maplibregl-ctrl-attrib a{color:#8b95a1 !important}
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
let PLAY_ZOOM=17;
/** 'arena' = fit the whole circle; 'close' = street-level around you. */
let zoomMode='arena';
const CLOSE_ZOOM=17.6;
/** Zoom that fits the arena's diameter across the screen (clamped for walking). */
function zoomFor(arena){
  const w=Math.max(280,(window.innerWidth||390));
  const mPerPx=(arena.radiusM*2*1.05)/w;
  const z=Math.log2(156543.03392*Math.cos(arena.centerLat*Math.PI/180)/mPerPx);
  return Math.max(15,Math.min(17.5,z));
}
/** Trail line widths (px): light core over a dark edge, paper.io style. */
const TRAIL_CORE_WIDTH=6;
const TRAIL_CASE_WIDTH=10;
/** Fallback trail colour when a feature has none. */
const TRAIL_CORE='#111111';
let map, ready=false;
let lastFp='';
let camKey='';
let boundaryKey='';
const seatsLive={};
let rafOn=false;
let lastState=null;
let lastReport='';
/** Death bursts: [{atMs,lat,lon,color}] on the server clock; clockSkew maps to local. */
let deaths=[];
let pops=[];
let clockSkew=0;
const DEATH_MS=2600;
const POP_MS=900;
/** Metres → screen px at the play zoom (for the spawn pop). */
function mToPx(m,lat){ return m/(156543.03392*Math.cos(lat*Math.PI/180)/Math.pow(2,PLAY_ZOOM)); }
const nowMs=()=>(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();

function post(msg){ try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }catch(e){} }
window.onerror=function(m){ post({type:'error',message:String(m)}); };

/* ── paper.io palette: one base colour → fill / border / trail / trail edge ── */
function rgb(hex){const h=String(hex||'#888888').replace('#','');const f=h.length===3?h.split('').map(c=>c+c).join(''):h;const n=parseInt(f,16);return [(n>>16)&255,(n>>8)&255,n&255];}
function mix(hex,to,t){const a=rgb(hex);return 'rgb('+a.map((v,i)=>Math.round(v+(to[i]-v)*t)).join(',')+')';}
const palCache={};
function palette(hex){
  if(!palCache[hex]) palCache[hex]={
    fill:hex,
    border:mix(hex,[255,255,255],0.18),
    lip:mix(hex,[0,0,0],0.45),
    trail:mix(hex,[255,255,255],0.3),
    trailEdge:mix(hex,[0,0,0],0.55),
    head:hex
  };
  return palCache[hex];
}

/** Chaikin corner-cutting: GPS-jagged edges → soft paper.io curves (visual only). */
function chaikinRing(ring,iters){
  let pts=ring.slice(0,-1);
  if(pts.length<3) return ring;
  for(let it=0;it<iters;it++){
    const out=[];
    for(let i=0;i<pts.length;i++){
      const a=pts[i],b=pts[(i+1)%pts.length];
      out.push([a[0]*0.75+b[0]*0.25,a[1]*0.75+b[1]*0.25],[a[0]*0.25+b[0]*0.75,a[1]*0.25+b[1]*0.75]);
    }
    pts=out;
  }
  pts.push(pts[0]);
  return pts;
}
function chaikinLine(line,iters){
  let pts=line;
  if(pts.length<3) return pts;
  for(let it=0;it<iters;it++){
    const out=[pts[0]];
    for(let i=0;i<pts.length-1;i++){
      const a=pts[i],b=pts[i+1];
      out.push([a[0]*0.75+b[0]*0.25,a[1]*0.75+b[1]*0.25],[a[0]*0.25+b[0]*0.75,a[1]*0.25+b[1]*0.75]);
    }
    out.push(pts[pts.length-1]);
    pts=out;
  }
  return pts;
}

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
/** Our game layers — never touched by declutter ("trails" contains "rail"!). */
const OWN_LAYERS={'boundary':1,'owned-shadow':1,'owned-fill':1,'owned-border':1,'trails-casing':1,'trails':1,'spawn-fill':1,'spawn-ring':1,'pops':1,'deaths':1,'markers':1,'players':1};
const faded={};
/** Strip labels/transit and wash the basemap out so player colours pop. */
function declutter(){
  const layers=(map.getStyle()&&map.getStyle().layers)||[];
  for(const layer of layers){
    if(OWN_LAYERS[layer.id]) continue;
    const id=(layer.id||'').toLowerCase();
    if(layer.type==='symbol' || /label|place|poi|transit|bus|rail|ferry|airport|housenumber|water_name|road_name|shield|station/.test(id)){
      try{ map.setLayoutProperty(layer.id,'visibility','none'); }catch(e){}
      continue;
    }
    if(faded[layer.id]) continue;
    faded[layer.id]=1;
    // Permanent dark mode: recolour the street basemap to quiet charcoal tones.
    try{
      if(layer.type==='background') map.setPaintProperty(layer.id,'background-color','#121518');
      else if(layer.type==='fill'){
        const c=/water|ocean|lake|river/.test(id)?'#0e1a24'
          :/park|grass|wood|forest|landcover|green|garden|pitch/.test(id)?'#141d18'
          :/building/.test(id)?'#1b1f24':'#16191d';
        map.setPaintProperty(layer.id,'fill-color',c);
        map.setPaintProperty(layer.id,'fill-opacity',1);
        try{ map.setPaintProperty(layer.id,'fill-outline-color',c); }catch(e){}
      }
      else if(layer.type==='line'){
        const c=/water|river|stream/.test(id)?'#0e1a24':/boundary|admin/.test(id)?'#16191d'
          :/path|foot|track|cycle|steps/.test(id)?'#22272d':'#2a3037';
        map.setPaintProperty(layer.id,'line-color',c);
        map.setPaintProperty(layer.id,'line-opacity',0.9);
      }
      else if(layer.type==='fill-extrusion') map.setLayoutProperty(layer.id,'visibility','none');
    }catch(e){}
  }
}
function seatFp(seats){
  return (seats||[]).map(s=>{
    const tip=s.trail&&s.trail.length?s.trail[s.trail.length-1]:null;
    const p=s.position||s.respawnAt;
    return [s.id,s.mode,Math.round(s.areaM2||0),(s.trail||[]).length,(s.owned||[]).length,
      p?p.lat.toFixed(6)+','+p.lon.toFixed(6):'',
      tip?tip.lat.toFixed(6)+','+tip.lon.toFixed(6):'',
      s.respawnAt?s.respawnAt.lat.toFixed(6)+','+s.respawnAt.lon.toFixed(6):''].join(':');
  }).join('|');
}
function fingerprint(state){
  return (state.arena&&state.arena.id)+'#'+seatFp(state.seats);
}

/** Camera rides the smoothed "you" dot every frame (no separate lag/lerp). */
function followYou(){
  let c=null;
  for(const id of Object.keys(seatsLive)){
    const l=seatsLive[id];
    if(l.you){ c=l.hasPos?[l.lon,l.lat]:(l.markerLon!=null?[l.markerLon,l.markerLat]:[l.lon,l.lat]); break; }
  }
  if(!c && lastState && lastState.arena) c=[lastState.arena.centerLon,lastState.arena.centerLat];
  if(!c) return;
  const key=c[0].toFixed(7)+','+c[1].toFixed(7);
  if(key===camKey) return;
  camKey=key;
  map.jumpTo({center:c,zoom:PLAY_ZOOM});
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
      layout:{'line-cap':'round','line-join':'round'},
      paint:{
        'line-color':['coalesce',['get','edge'],TRAIL_CORE],
        'line-opacity':0.9,
        'line-width':TRAIL_CASE_WIDTH
      }
    });
  }
  /* ${TRAIL_RENDER_SENTINEL}: visible trail polyline above territory fill */
  if(!map.getLayer('trails')){
    map.addLayer({
      id:'trails',
      type:'line',
      source:'trails',
      layout:{'line-cap':'round','line-join':'round'},
      paint:{
        'line-color':['coalesce',['get','trail'],TRAIL_CORE],
        'line-opacity':1,
        'line-width':TRAIL_CORE_WIDTH
      }
    });
  }
}

function reportPaint(trailCount){
  const ok=!!(map.getLayer('trails')&&map.getLayer('trails-casing'));
  const key=ok+':'+trailCount;
  if(key===lastReport) return;
  lastReport=key;
  post({type:'paint',rev:${MAP_HTML_REVISION},trailsLayer:ok,trailVisible:map.getLayoutProperty('trails','visibility')!=='none',trailFeatures:trailCount});
}

function flushLayers(){
  if(!ready||!map.getSource('players')||!map.getSource('owned')||!lastState) return;
  ensureTrailLayers();
  const youId=(Object.values(seatsLive).find(l=>l.you)||{}).id;
  const owned={type:'FeatureCollection',features:[]};
  const terr=lastState.territory&&lastState.territory.type==='FeatureCollection'?lastState.territory.features:[];
  for(const f of terr){
    const pal=palette(f.properties.color);
    const rings=f.geometry.coordinates.map(r=>r.length>=4?chaikinRing(r,2):r);
    owned.features.push({type:'Feature',properties:{fill:pal.fill,border:pal.border,lip:pal.lip,you:f.properties.seatId===youId},geometry:{type:'Polygon',coordinates:rings}});
  }
  /* RN builds the trail FeatureCollection (buildTrailPaint); extend each line
     to the animated dot so the trail never lags behind the player. */
  const src=(lastState.trails&&lastState.trails.type==='FeatureCollection')?lastState.trails.features:[];
  const trails={type:'FeatureCollection',features:[]};
  for(const f of src){
    const coords=f.geometry.coordinates.slice();
    const live=seatsLive[f.properties.seatId];
    if(live && live.mode==='trailing' && coords.length){
      coords[coords.length-1]=[live.lon,live.lat];
    }
    const pal=palette(f.properties.color);
    // Smooth everything but the live tip so the line still meets the dot exactly.
    const smooth=coords.length>=3?chaikinLine(coords,2):coords;
    if(smooth.length>=2) trails.features.push({type:'Feature',properties:{seatId:f.properties.seatId,trail:pal.trail,edge:pal.trailEdge},geometry:{type:'LineString',coordinates:smooth}});
  }
  const players={type:'FeatureCollection',features:[]};
  const spawn={type:'FeatureCollection',features:[]};
  const starterR=(lastState.arena&&lastState.arena.starterRadiusM)||22;
  for(const id of Object.keys(seatsLive)){
    const live=seatsLive[id];
    const pal=palette(live.color);
    if(live.hasPos){
      players.features.push({
        type:'Feature',
        properties:{color:pal.head,edge:pal.border,you:!!live.you,mode:live.mode||'player'},
        geometry:{type:'Point',coordinates:[live.lon,live.lat]}
      });
    }
    if(live.markerLon!=null){
      players.features.push({
        type:'Feature',
        properties:{color:pal.head,edge:pal.border,you:!!live.you,mode:'marker'},
        geometry:{type:'Point',coordinates:[live.markerLon,live.markerLat]}
      });
      // Respawn zone for every waiting player: walk in → back in the game.
      spawn.features.push({type:'Feature',properties:{color:pal.border,fill:pal.fill,you:!!live.you},
        geometry:{type:'Polygon',coordinates:[circleRing({lat:live.markerLat,lon:live.markerLon},starterR,48)]}});
    }
  }
  map.getSource('owned').setData(owned);
  map.getSource('trails').setData(trails);
  map.getSource('spawn').setData(spawn);
  map.getSource('players').setData(players);
  const nowS=Date.now()+clockSkew;
  const burst={type:'FeatureCollection',features:[]};
  for(const d of deaths){
    const age=nowS-d.atMs;
    if(age<0||age>DEATH_MS) continue;
    const k=age/DEATH_MS;
    burst.features.push({type:'Feature',properties:{color:d.color,r:10+46*k,o:1-k},geometry:{type:'Point',coordinates:[d.lon,d.lat]}});
  }
  map.getSource('deaths').setData(burst);
  const popFc={type:'FeatureCollection',features:[]};
  for(const p of pops){
    const age=nowS-p.atMs;
    if(age<0||age>POP_MS) continue;
    const k=age/POP_MS;
    const ease=1-Math.pow(1-k,3);
    popFc.features.push({type:'Feature',properties:{color:palette(p.color).trail,r:mToPx(starterR*1.15,p.lat)*ease,o:0.75*(1-k)},geometry:{type:'Point',coordinates:[p.lon,p.lat]}});
  }
  map.getSource('pops').setData(popFc);
  // Exposed for Simulator / harness assertions.
  window.__paperTrailFeatureCount=trails.features.length;
  reportPaint(trails.features.length);
}

function deathsActive(){
  const nowS=Date.now()+clockSkew;
  return deaths.some(d=>nowS-d.atMs>=0&&nowS-d.atMs<=DEATH_MS) ||
    pops.some(p=>nowS-p.atMs>=0&&nowS-p.atMs<=POP_MS);
}
/**
 * Time-based glide: each dot moves from where it is drawn to its newest
 * server position over ~one update interval, so motion is continuous
 * instead of snap-and-stop between polls.
 */
function tickFrame(){
  rafOn=true;
  const t=nowMs();
  let moving=deathsActive();
  for(const id of Object.keys(seatsLive)){
    const d=seatsLive[id];
    const k=d.dur>0?Math.min(1,(t-d.t0)/d.dur):1;
    d.lon=d.fLon+(d.tLon-d.fLon)*k;
    d.lat=d.fLat+(d.tLat-d.fLat)*k;
    if(k<1) moving=true;
  }
  followYou();
  flushLayers();
  if(moving) requestAnimationFrame(tickFrame);
  else rafOn=false;
}

function syncSeats(seats){
  const seen={};
  const t=nowMs();
  for(const seat of seats||[]){
    const pos=seat.position||seat.respawnAt;
    if(!pos) continue;
    seen[seat.id]=1;
    const prev=seatsLive[seat.id];
    const marker=seat.respawnAt&&(seat.mode==='toPlant'||seat.mode==='joining'||seat.mode==='ghost')?seat.respawnAt:null;
    // Snap (don't glide) on first sight / respawn / big GPS jumps.
    const jump=prev&&(Math.abs(prev.tLat-pos.lat)>0.0005||Math.abs(prev.tLon-pos.lon)>0.0007);
    if(!prev||jump){
      seatsLive[seat.id]={
        id:seat.id,
        lon:pos.lon,lat:pos.lat,fLon:pos.lon,fLat:pos.lat,tLon:pos.lon,tLat:pos.lat,
        t0:t,dur:0,lastAt:t,
        hasPos:!!seat.position,
        color:seat.color,you:!!seat.you,mode:seat.mode||'player',
        markerLon:marker?marker.lon:null,
        markerLat:marker?marker.lat:null
      };
    }else{
      if(prev.tLon!==pos.lon||prev.tLat!==pos.lat){
        const gap=t-prev.lastAt;
        prev.fLon=prev.lon; prev.fLat=prev.lat;
        prev.tLon=pos.lon; prev.tLat=pos.lat;
        prev.t0=t;
        prev.dur=Math.max(120,Math.min(900,gap*1.1));
        prev.lastAt=t;
      }
      prev.hasPos=!!seat.position;
      prev.color=seat.color; prev.you=!!seat.you; prev.mode=seat.mode||'player';
      prev.markerLon=marker?marker.lon:null;
      prev.markerLat=marker?marker.lat:null;
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
  const zm=state.zoomMode==='close'?'close':'arena';
  const wantZoom=zm==='close'?CLOSE_ZOOM:zoomFor(state.arena);
  if(zm!==zoomMode||Math.abs(wantZoom-PLAY_ZOOM)>1e-6){
    zoomMode=zm; PLAY_ZOOM=wantZoom; camKey='';
    if(Object.keys(seatsLive).length) followYou();
  }
  if(state.serverNowMs) clockSkew=state.serverNowMs-Date.now();
  const nd=state.deaths||[];
  const newest=nd.length?nd[nd.length-1].atMs:0;
  const had=deaths.length?deaths[deaths.length-1].atMs:0;
  deaths=nd;
  const np=state.pops||[];
  const newestPop=np.length?np[np.length-1].atMs:0;
  const hadPop=pops.length?pops[pops.length-1].atMs:0;
  pops=np;
  if((newest!==had||newestPop!==hadPop) && !rafOn) requestAnimationFrame(tickFrame);
  const fp=fingerprint(state);
  if(fp===lastFp) return;
  lastFp=fp;
  const arena=state.arena;
  const bKey=arena.centerLat+','+arena.centerLon+','+arena.radiusM;
  if(bKey!==boundaryKey){
    const boundary={type:'FeatureCollection',features:[{
      type:'Feature',properties:{},geometry:{type:'LineString',coordinates:circleRing({lat:arena.centerLat,lon:arena.centerLon},arena.radiusM,128)}
    }]};
    map.getSource('boundary').setData(boundary);
    boundaryKey=bKey;
  }
  syncSeats(state.seats||[]);
  followYou();
}

/** RN injectJavaScript entry — more reliable than postMessage on iOS HTML WebViews. */
window.__paperPaint=function(msg){
  try{
    const m=typeof msg==='string'?JSON.parse(msg):msg;
    if(m && m.type==='state') paint(m.state);
  }catch(err){ post({type:'error',message:'paint: '+String(err)}); }
};

map=new maplibregl.Map({
  container:'map',
  style:STYLE,
  center:[-93.23256,44.97452],
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
map.on('error',(e)=>{ post({type:'error',message:String((e&&e.error&&e.error.message)||e)}); });
map.on('load',()=>{
  declutter();
  map.addSource('boundary',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'boundary',type:'line',source:'boundary',layout:{'line-join':'round'},paint:{'line-color':'#8b95a1','line-opacity':0.75,'line-width':2.5,'line-dasharray':[2.5,1.5]}});
  map.addSource('owned',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  // paper.io look: solid colour slab with a darker "lip" just below it (3D),
  // and a thin lighter rim. Your own land gets a slightly bolder rim.
  map.addLayer({id:'owned-shadow',type:'fill',source:'owned',paint:{'fill-color':['get','lip'],'fill-opacity':1,'fill-translate':[0,5],'fill-antialias':true}});
  map.addLayer({id:'owned-fill',type:'fill',source:'owned',paint:{'fill-color':['get','fill'],'fill-opacity':1,'fill-antialias':true}});
  map.addLayer({id:'owned-border',type:'line',source:'owned',layout:{'line-join':'round'},paint:{'line-color':['get','border'],'line-opacity':0.9,'line-width':['case',['get','you'],2.5,1.5]}});
  ensureTrailLayers();
  map.addSource('spawn',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'spawn-fill',type:'fill',source:'spawn',paint:{'fill-color':['get','fill'],'fill-opacity':['case',['get','you'],0.28,0.18]}});
  map.addLayer({id:'spawn-ring',type:'line',source:'spawn',paint:{'line-color':['get','color'],'line-width':['case',['get','you'],3,2.2],'line-opacity':0.95,'line-dasharray':[1.5,1.2]}});
  map.addSource('pops',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'pops',type:'circle',source:'pops',paint:{'circle-radius':['get','r'],'circle-color':['get','color'],'circle-opacity':['get','o'],'circle-stroke-width':3,'circle-stroke-color':'#ffffff','circle-stroke-opacity':['get','o']}});
  map.addSource('deaths',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'deaths',type:'circle',source:'deaths',paint:{'circle-radius':['get','r'],'circle-color':'rgba(0,0,0,0)','circle-stroke-width':4,'circle-stroke-color':['get','color'],'circle-stroke-opacity':['get','o']}});
  map.addSource('players',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'markers',type:'circle',source:'players',filter:['==',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],9,6],'circle-color':'#fff','circle-stroke-width':['case',['get','you'],3,2],'circle-stroke-color':['get','color']}});
  // Heads: player colour with a dark rim; you get a white halo. Ghosts are see-through.
  map.addLayer({id:'players',type:'circle',source:'players',filter:['!=',['get','mode'],'marker'],paint:{'circle-radius':['case',['get','you'],10,7.5],'circle-color':['get','color'],'circle-opacity':['case',['==',['get','mode'],'ghost'],0.35,1],'circle-stroke-opacity':['case',['==',['get','mode'],'ghost'],0.35,1],'circle-stroke-width':['case',['get','you'],3.5,2.5],'circle-stroke-color':['case',['get','you'],'#ffffff',['get','edge']]}});
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
