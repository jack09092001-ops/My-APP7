'use strict';

// ── 設定 ─────────────────────────────────────────────
const API_KEY_STORAGE_KEY = 'api_key_v1';
const SETTINGS_STORAGE_KEY = 'settings_v1';
const DRAFTS_STORAGE_KEY = 'draft_routes_v1';
const SAVED_STORAGE_KEY = 'saved_routes_v1';
const COUNTER_STORAGE_KEY = 'route_counter_v1';

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.5319 }; // 台北車站
const DEFAULT_ZOOM = 14;
const MIN_DRAW_ZOOM = 14; // 低於此縮放級別手繪誤差太大，會貼錯路

const DRAW_MIN_PX = 4; // 手指移動超過幾像素才記一個點
const SIMPLIFY_PX = 3; // Douglas-Peucker 容許誤差（以當下縮放的像素換算公尺）
const RESAMPLE_M = 40; // 送去貼路前的最大點距
const SNAP_BATCH = 100; // Roads API 單次最多 100 點
const MERGE_GAP_M = 30; // 段與段首尾距離超過此值才補接縫
const BRIDGE_MAX_M = 3000; // 接縫超過此距離不嘗試貼路，直接直線連接
const OVERLAP_M = 25; // 後段開頭離前段路線在此距離內，視為交會，直接剪接
const OVERLAP_WINDOW_M = 2000; // 只在前段尾端 / 後段開頭這段長度內找交會點
const ELEVATION_BATCH = 256;

const ROUTE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0ea5b7', '#b8860b', '#e83e8c'];
const DRAW_COLOR = '#d64545';
const SNAP_COLOR = '#2f6fed';
const FOCUS_COLOR = '#2f6fed';

// ── 狀態 ─────────────────────────────────────────────
const state = {
  tab: 'draw',
  drawMode: false,
  strokes: [], // 已完成的手繪筆畫：[[lat,lng],...][]
  current: null, // 正在畫的筆畫
  currentPx: null, // 正在畫的筆畫最後一點像素座標
  snapped: null, // 貼路結果
  busy: false,
  selectedDrafts: [], // 勾選順序即預設合併順序
  focusedDraftId: null,
  focusedSavedId: null,
  merge: null, // { items: [{ id, reversed }] }
};

let map = null;
let projOverlay = null;
let HtmlMarker = null;
let layers = [];
let liveLine = null;
let myLocation = { watchId: null, marker: null, circle: null, last: null, centerOnFix: false };

const $ = (id) => document.getElementById(id);

// ── 儲存 ─────────────────────────────────────────────
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    toast('儲存失敗：手機瀏覽器空間不足');
    return false;
  }
}

function getApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

const getSettings = () => loadJson(SETTINGS_STORAGE_KEY, { elevation: false });
const getDrafts = () => loadJson(DRAFTS_STORAGE_KEY, []);
const getSaved = () => loadJson(SAVED_STORAGE_KEY, []);
const setDrafts = (list) => saveJson(DRAFTS_STORAGE_KEY, list);
const setSaved = (list) => saveJson(SAVED_STORAGE_KEY, list);

function nextRouteNumber() {
  const n = (Number(loadJson(COUNTER_STORAGE_KEY, 0)) || 0) + 1;
  saveJson(COUNTER_STORAGE_KEY, n);
  return n;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const roundPoints = (pts) => pts.map(([lat, lng]) => [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);

// ── 幾何工具 ─────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Douglas-Peucker，先投影成近似平面公尺座標再計算
function simplify(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const lat0 = (pts[0][0] * Math.PI) / 180;
  const xy = pts.map(([lat, lng]) => [lng * 111320 * Math.cos(lat0), lat * 110540]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segmentDistance(xy[i], xy[s], xy[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tolM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 在過長的線段中補點，使點距不超過 maxGap 公尺
function resample(pts, maxGap) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.ceil(haversine(a, b) / maxGap);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    out.push(b);
  }
  return out;
}

// 接上一串點，略過與前一點幾乎重疊的點
function appendPoints(out, pts) {
  for (const p of pts) {
    if (!out.length || haversine(out[out.length - 1], p) > 0.5) out.push(p);
  }
  return out;
}

// 找出前段尾端與後段開頭的交會處，回傳 { k, j }：前段保留到 out[k]，後段從 next[j] 接上。
// 有多個交會點時取剪掉最多重複路段的那個，避免合併後出現「折返」的來回路線。
function findOverlapJoin(out, next) {
  const tailLen = new Array(out.length).fill(0); // out[i] 到終點的距離
  for (let i = out.length - 2; i >= 0; i--) tailLen[i] = tailLen[i + 1] + haversine(out[i], out[i + 1]);
  let kStart = out.length - 1;
  while (kStart > 0 && tailLen[kStart] < OVERLAP_WINDOW_M) kStart--;

  const lat0 = (next[0][0] * Math.PI) / 180;
  const xy = ([lat, lng]) => [lng * 111320 * Math.cos(lat0), lat * 110540];
  const outXy = out.map(xy);

  let best = null;
  let headLen = 0;
  for (let j = 0; j < next.length && headLen <= OVERLAP_WINDOW_M; j++) {
    if (j > 0) headLen += haversine(next[j - 1], next[j]);
    const p = xy(next[j]);
    for (let k = kStart; k < out.length; k++) {
      let d;
      let tail;
      if (k === out.length - 1) {
        d = Math.hypot(p[0] - outXy[k][0], p[1] - outXy[k][1]);
        tail = 0;
      } else {
        const a = outXy[k];
        const b = outXy[k + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
        d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
        tail = tailLen[k + 1] + (1 - t) * Math.sqrt(len2);
      }
      if (d <= OVERLAP_M) {
        const trimmed = tail + headLen;
        if (!best || trimmed > best.trimmed) best = { k, j, trimmed };
      }
    }
  }
  return best;
}

// ── Google Roads API ────────────────────────────────
function roadsErrorMessage(error) {
  const msg = error.message || error.status || '';
  const reason = JSON.stringify(error.details || '');
  if (/referer/i.test(msg) || reason.includes('HTTP_REFERRER_BLOCKED')) {
    return `Roads API 拒絕了這個網址。請在金鑰的「網站限制」加入 ${location.origin}/*`;
  }
  if (reason.includes('SERVICE_BLOCKED') || /not authorized to use this service/i.test(msg)) {
    return 'Roads API 被金鑰的「API 限制」擋下，請在金鑰的 API 限制中勾選 Roads API。';
  }
  if (/has not been used|is disabled/i.test(msg)) {
    return '此專案尚未啟用 Roads API，請到 Google Cloud Console「API 和服務 → 程式庫」啟用 Roads API。';
  }
  return `Roads API 錯誤：${msg}`;
}

// allowSparse：接縫等短距離用，Roads API 只回傳少數點也接受（兩端點本來就在道路上）
async function snapToRoads(points, { allowSparse = false } = {}) {
  if (points.length < 2) throw new Error('點數不足');
  const key = getApiKey();
  const out = [];
  let start = 0;
  for (;;) {
    const chunk = points.slice(start, start + SNAP_BATCH);
    const path = chunk.map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join('|');
    const url = `https://roads.googleapis.com/v1/snapToRoads?interpolate=true&path=${encodeURIComponent(path)}&key=${encodeURIComponent(key)}`;
    let data;
    try {
      // 瀏覽器預設跨網域只送網域當 Referer；改送完整網址，金鑰限制寫到子路徑（如 /My-APP7/*）也能通過
      const res = await fetch(url, { referrerPolicy: 'no-referrer-when-downgrade' });
      data = await res.json();
    } catch {
      throw new Error('無法連線到 Roads API，請檢查網路');
    }
    if (data.error) throw new Error(roadsErrorMessage(data.error));
    appendPoints(
      out,
      (data.snappedPoints || []).map((sp) => [sp.location.latitude, sp.location.longitude])
    );
    if (start + SNAP_BATCH >= points.length) break;
    start += SNAP_BATCH - 1; // 重疊一點避免批次之間斷線
  }
  if (out.length < 2 && !allowSparse) throw new Error('附近找不到可貼齊的道路');
  return out;
}

// ── Elevation（透過 Maps JS 的 ElevationService）─────
async function fetchElevations(points) {
  const { ElevationService } = await google.maps.importLibrary('elevation');
  const svc = new ElevationService();
  const out = [];
  for (let i = 0; i < points.length; i += ELEVATION_BATCH) {
    const locations = points.slice(i, i + ELEVATION_BATCH).map(([lat, lng]) => ({ lat, lng }));
    const { results } = await svc.getElevationForLocations({ locations });
    for (const r of results) out.push(r.elevation);
  }
  return out;
}

// ── GPX ─────────────────────────────────────────────
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function buildGpx(name, points, elevations) {
  const trkpts = points
    .map(([lat, lng], i) => {
      const ele = elevations && Number.isFinite(elevations[i]) ? `<ele>${elevations[i].toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele}</trkpt>`;
    })
    .join('\n');
  const n = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RoutePlanner PWA" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${n}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${n}</name>
    <type>cycling</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

async function exportGpx(route) {
  let elevations = null;
  if (getSettings().elevation) {
    try {
      toast('取得海拔資料中…', 0);
      elevations = await fetchElevations(route.points);
    } catch (err) {
      toast('海拔取得失敗，將匯出不含海拔的 GPX');
      console.warn(err);
    }
  }
  const gpx = buildGpx(route.name, route.points, elevations);
  const filename = `${route.name.replace(/[\\/:*?"<>|]/g, '_') || 'route'}.gpx`;
  const file = new File([gpx], filename, { type: 'application/gpx+xml' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: route.name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`已下載 ${filename}`);
}

// ── UI 小工具 ───────────────────────────────────────
let toastTimer = null;
function toast(msg, ms = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.appendChild(c);
  return node;
}

// ── 地圖載入 ─────────────────────────────────────────
function loadMapsScript(key) {
  // Google 只把確切的錯誤代碼印在 console，攔截下來顯示給手機使用者看
  let mapsErrorCode = '';
  let authFailed = false;
  const origConsoleError = console.error;
  console.error = (...args) => {
    const m = args.map(String).join(' ').match(/\b([A-Za-z]+MapError)\b/);
    if (m) {
      mapsErrorCode = m[1];
      if (authFailed) showMapsAuthError(mapsErrorCode);
    }
    origConsoleError.apply(console, args);
  };
  window.gm_authFailure = () => {
    authFailed = true;
    showMapsAuthError(mapsErrorCode);
  };
  window.onMapsLoaded = () => {
    setupMap().catch((err) => {
      console.error(err);
      toast('地圖初始化失敗');
    });
  };
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=zh-TW&region=TW&loading=async&callback=onMapsLoaded`;
  s.async = true;
  s.onerror = () => toast('無法載入 Google 地圖，請檢查網路');
  document.head.appendChild(s);
}

function showMapsAuthError(code) {
  const allowed = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}*`;
  const reasons = {
    RefererNotAllowedMapError: `這個網址沒有被金鑰允許。請在金鑰的「網站限制」加入：${allowed}`,
    ApiNotActivatedMapError: '此專案尚未啟用 Maps JavaScript API，請到 Google Cloud Console「API 和服務 → 程式庫」啟用。',
    BillingNotEnabledMapError: '此專案尚未開啟計費，請到 Google Cloud Console「帳單」連結計費帳戶。',
    InvalidKeyMapError: '金鑰不正確，可能貼錯或少了字元（注意大寫 I 與小寫 l）。建議從 Google Cloud Console 直接複製貼上。',
    ApiTargetBlockedMapError: '金鑰的「API 限制」沒有勾選 Maps JavaScript API。',
    ExpiredKeyMapError: '金鑰已過期或已被刪除，請重新建立金鑰。',
    DeletedApiProjectMapError: '金鑰所屬的專案已被刪除，請重新建立金鑰。',
  };
  const detail =
    reasons[code] ||
    `請確認：① 金鑰「網站限制」包含 ${allowed} ② 已啟用 Maps JavaScript API ③ 已開啟計費 ④ 金鑰沒有貼錯。`;
  const ph = $('map-placeholder');
  ph.querySelector('p').textContent = `Google 拒絕了這把金鑰${code ? `（${code}）` : ''}。${detail}`;
  ph.classList.remove('hidden');
  ph.style.zIndex = 7;
  $('draw-fab').classList.add('hidden');
}

async function setupMap() {
  await google.maps.importLibrary('core');
  await google.maps.importLibrary('maps');

  map = new google.maps.Map($('map'), {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    gestureHandling: 'greedy',
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    mapTypeControl: true,
    mapTypeControlOptions: {
      position: google.maps.ControlPosition.TOP_RIGHT,
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
      mapTypeIds: ['roadmap', 'satellite', 'terrain'],
    },
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
  });

  // 只用來做像素 ↔ 經緯度換算
  projOverlay = new google.maps.OverlayView();
  projOverlay.onAdd = () => {};
  projOverlay.draw = () => {};
  projOverlay.onRemove = () => {};
  projOverlay.setMap(map);

  HtmlMarker = class extends google.maps.OverlayView {
    constructor(pos, className, text) {
      super();
      this.pos = pos;
      this.div = document.createElement('div');
      this.div.className = `html-marker ${className}`;
      if (text) this.div.textContent = text;
    }
    onAdd() {
      this.getPanes().overlayLayer.appendChild(this.div);
    }
    draw() {
      const p = this.getProjection().fromLatLngToDivPixel(this.pos);
      if (p) {
        this.div.style.left = `${p.x}px`;
        this.div.style.top = `${p.y}px`;
      }
    }
    onRemove() {
      this.div.remove();
    }
    setPosition(pos) {
      this.pos = pos;
      if (this.getProjection()) this.draw();
    }
  };

  const locBtn = el('button', { type: 'button', class: 'map-ctrl-btn', title: '目前位置', text: '📍', onclick: locateMe });
  map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(locBtn);

  liveLine = new google.maps.Polyline({ map, strokeColor: DRAW_COLOR, strokeWeight: 4, strokeOpacity: 0.9, clickable: false });

  $('map-placeholder').classList.add('hidden');
  $('draw-fab').classList.remove('hidden');
  setupDrawing();
  refreshMap();
}

// ── 目前位置 ─────────────────────────────────────────
function locateMe() {
  if (!navigator.geolocation) {
    toast('此裝置不支援定位');
    return;
  }
  if (myLocation.last) {
    map.panTo(myLocation.last);
    if (map.getZoom() < 15) map.setZoom(16);
  } else {
    myLocation.centerOnFix = true;
    toast('定位中…');
  }
  if (myLocation.watchId !== null) return;
  myLocation.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      myLocation.last = ll;
      if (!myLocation.marker) {
        myLocation.marker = new HtmlMarker(new google.maps.LatLng(ll), 'me');
        myLocation.marker.setMap(map);
        myLocation.circle = new google.maps.Circle({
          map,
          center: ll,
          radius: pos.coords.accuracy,
          fillColor: '#4285f4',
          fillOpacity: 0.15,
          strokeColor: '#4285f4',
          strokeOpacity: 0.4,
          strokeWeight: 1,
          clickable: false,
        });
      } else {
        myLocation.marker.setPosition(new google.maps.LatLng(ll));
        myLocation.circle.setCenter(ll);
        myLocation.circle.setRadius(pos.coords.accuracy);
      }
      if (myLocation.centerOnFix) {
        myLocation.centerOnFix = false;
        map.panTo(ll);
        if (map.getZoom() < 15) map.setZoom(16);
        $('toast').classList.add('hidden');
      }
    },
    (err) => {
      toast(err.code === err.PERMISSION_DENIED ? '定位權限被拒絕，請在瀏覽器設定中允許' : '無法取得目前位置');
      navigator.geolocation.clearWatch(myLocation.watchId);
      myLocation.watchId = null;
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// ── 手繪 ─────────────────────────────────────────────
function setupDrawing() {
  const overlay = $('draw-overlay');
  const fab = $('draw-fab');

  fab.addEventListener('click', () => setDrawMode(!state.drawMode));

  const toLatLng = (e) => {
    const rect = overlay.getBoundingClientRect();
    const px = new google.maps.Point(e.clientX - rect.left, e.clientY - rect.top);
    const ll = projOverlay.getProjection().fromContainerPixelToLatLng(px);
    return { ll: [ll.lat(), ll.lng()], px };
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || !projOverlay.getProjection()) return;
    overlay.setPointerCapture(e.pointerId);
    const { ll, px } = toLatLng(e);
    // 多筆畫依序串接成一條路線（上一筆終點直接連到下一筆起點）
    state.current = [ll];
    state.currentPx = px;
    renderLiveLine();
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!e.isPrimary || !state.current) return;
    const { ll, px } = toLatLng(e);
    if (Math.hypot(px.x - state.currentPx.x, px.y - state.currentPx.y) < DRAW_MIN_PX) return;
    state.current.push(ll);
    state.currentPx = px;
    renderLiveLine();
  });

  const finish = (e) => {
    if (!e.isPrimary || !state.current) return;
    if (state.current.length >= 2) {
      state.strokes.push(state.current);
      state.snapped = null;
    }
    state.current = null;
    renderLiveLine();
    updateDrawUi();
    refreshMap();
  };
  overlay.addEventListener('pointerup', finish);
  overlay.addEventListener('pointercancel', finish);
}

function setDrawMode(on) {
  if (on && map.getZoom() < MIN_DRAW_ZOOM) {
    toast(`請先放大地圖（目前 ${map.getZoom()} 級，建議 ${MIN_DRAW_ZOOM} 級以上），手繪才準確`, 3500);
  }
  state.drawMode = on;
  $('draw-overlay').classList.toggle('hidden', !on);
  const fab = $('draw-fab');
  fab.setAttribute('aria-pressed', String(on));
  fab.textContent = on ? '✋ 移動地圖' : '✏️ 手繪';
  if (on && state.tab !== 'draw') switchTab('draw');
}

function renderLiveLine() {
  if (!liveLine) return;
  const pts = state.strokes.flat();
  if (state.current) pts.push(...state.current);
  liveLine.setPath(pts.map(([lat, lng]) => ({ lat, lng })));
  liveLine.setOptions({ strokeOpacity: state.snapped ? 0.35 : 0.9 });
}

function updateDrawUi() {
  const raw = state.strokes.flat();
  const status = $('draw-status');
  if (state.busy) {
    status.textContent = '貼齊道路中…';
  } else if (state.snapped) {
    status.textContent = `已貼齊道路：${formatDistance(pathLength(state.snapped))}（藍線）。滿意請按「存為暫存路線」，或繼續畫 / 復原。`;
  } else if (raw.length) {
    status.textContent = `手繪中：${state.strokes.length} 筆、約 ${formatDistance(pathLength(raw))}。畫完按「貼齊道路」。`;
  } else {
    status.textContent = '按地圖左上角「✏️ 手繪」後，用手指在地圖上畫出路線。可分多筆畫，離開手繪模式即可移動地圖。';
  }
  $('undo-btn').disabled = state.busy || !state.strokes.length;
  $('clear-btn').disabled = state.busy || !state.strokes.length;
  $('snap-btn').disabled = state.busy || raw.length < 2 || !map;
  $('save-draft-btn').disabled = state.busy || !state.snapped;
}

async function snapDrawing() {
  const raw = state.strokes.flat();
  if (raw.length < 2) return;
  const mpp = (156543.03392 * Math.cos((raw[0][0] * Math.PI) / 180)) / 2 ** map.getZoom();
  const sampled = resample(simplify(raw, Math.max(mpp * SIMPLIFY_PX, 2)), RESAMPLE_M);
  state.busy = true;
  updateDrawUi();
  try {
    state.snapped = await snapToRoads(sampled);
    if (state.drawMode) setDrawMode(false);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    state.busy = false;
    updateDrawUi();
    renderLiveLine();
    refreshMap();
  }
}

function saveDraft() {
  if (!state.snapped) return;
  const points = roundPoints(state.snapped);
  const draft = {
    id: newId(),
    name: `路線${nextRouteNumber()}`,
    points,
    distanceM: Math.round(pathLength(points)),
    createdAt: Date.now(),
  };
  const drafts = getDrafts();
  drafts.push(draft);
  if (!setDrafts(drafts)) return;
  state.strokes = [];
  state.snapped = null;
  renderLiveLine();
  updateDrawUi();
  renderLists();
  refreshMap();
  toast(`已存為「${draft.name}」`);
}

// ── 地圖圖層 ─────────────────────────────────────────
function clearLayers() {
  for (const l of layers) l.setMap(null);
  layers = [];
}

const toLL = (pts) => pts.map(([lat, lng]) => ({ lat, lng }));

function addPolyline(pts, opts = {}) {
  const line = new google.maps.Polyline({
    map,
    path: toLL(pts),
    strokeColor: opts.color || SNAP_COLOR,
    strokeWeight: opts.weight || 5,
    strokeOpacity: opts.opacity ?? 0.9,
    clickable: false,
    icons: opts.arrows
      ? [{ icon: { path: google.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 2.5, strokeColor: '#fff', strokeWeight: 2 }, repeat: '90px' }]
      : undefined,
  });
  layers.push(line);
  return line;
}

function addMarker(pt, className, text) {
  const m = new HtmlMarker(new google.maps.LatLng(pt[0], pt[1]), className, text);
  m.setMap(map);
  layers.push(m);
}

function addStartEnd(pts) {
  addMarker(pts[0], 'start', '起');
  addMarker(pts[pts.length - 1], 'end', '終');
}

function fitPoints(pts) {
  if (!pts.length) return;
  const b = new google.maps.LatLngBounds();
  for (const [lat, lng] of pts) b.extend({ lat, lng });
  map.fitBounds(b, 40);
}

function refreshMap() {
  if (!map) return;
  clearLayers();
  liveLine.setVisible(state.tab === 'draw');

  if (state.tab === 'draw') {
    if (state.snapped) {
      addPolyline(state.snapped, { color: SNAP_COLOR, arrows: true });
      addStartEnd(state.snapped);
    }
  } else if (state.tab === 'drafts') {
    if (state.merge) {
      const pts = buildMergedPreview();
      if (pts.length >= 2) {
        addPolyline(pts, { color: FOCUS_COLOR, weight: 6, arrows: true });
        addStartEnd(pts);
      }
      return;
    }
    getDrafts().forEach((d, i) => {
      const focused = d.id === state.focusedDraftId;
      addPolyline(d.points, {
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        weight: focused ? 7 : 4,
        opacity: state.focusedDraftId && !focused ? 0.45 : 0.9,
        arrows: focused,
      });
      addMarker(d.points[Math.floor(d.points.length / 2)], 'label', d.name);
      if (focused) addStartEnd(d.points);
    });
  } else if (state.tab === 'saved') {
    const r = getSaved().find((x) => x.id === state.focusedSavedId);
    if (r) {
      addPolyline(r.points, { color: FOCUS_COLOR, weight: 6, arrows: true });
      addStartEnd(r.points);
    }
  }
}

// ── 分頁 / 清單 ──────────────────────────────────────
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  for (const name of ['draw', 'drafts', 'saved']) $(`tab-${name}`).classList.toggle('hidden', name !== tab);
  if (tab !== 'draw' && state.drawMode) setDrawMode(false);
  refreshMap();
}

function renderLists() {
  renderDrafts();
  renderSaved();
}

function renderDrafts() {
  const drafts = getDrafts();
  const ids = new Set(drafts.map((d) => d.id));
  state.selectedDrafts = state.selectedDrafts.filter((id) => ids.has(id));
  $('drafts-count').textContent = drafts.length;
  $('drafts-empty').classList.toggle('hidden', drafts.length > 0);

  const list = $('drafts-list');
  list.replaceChildren(
    ...drafts.map((d, i) => {
      const checkbox = el('input', {
        type: 'checkbox',
        checked: state.selectedDrafts.includes(d.id),
        onchange: (e) => {
          if (e.target.checked) state.selectedDrafts.push(d.id);
          else state.selectedDrafts = state.selectedDrafts.filter((x) => x !== d.id);
          updateMergeButton();
        },
      });
      const swatch = el('span', { class: 'swatch' });
      swatch.style.background = ROUTE_COLORS[i % ROUTE_COLORS.length];
      return el('li', { class: `route-item${d.id === state.focusedDraftId ? ' focused' : ''}` }, [
        checkbox,
        swatch,
        el('div', { class: 'route-info', onclick: () => focusDraft(d.id) }, [
          el('div', { class: 'route-name', text: d.name }),
          el('div', { class: 'route-meta', text: `${formatDistance(d.distanceM)} · ${formatDate(d.createdAt)}` }),
        ]),
        el('button', { type: 'button', class: 'mini-btn secondary', text: '改名', onclick: () => renameRoute('draft', d.id) }),
        el('button', { type: 'button', class: 'mini-btn danger', text: '刪除', onclick: () => deleteRoute('draft', d.id) }),
      ]);
    })
  );
  updateMergeButton();
}

function updateMergeButton() {
  const n = state.selectedDrafts.length;
  const btn = $('merge-start-btn');
  btn.disabled = n === 0;
  btn.textContent = n > 1 ? `🔗 合併所選 (${n})` : `🔗 合併 / 命名所選 (${n})`;
}

function renderSaved() {
  const saved = getSaved();
  $('saved-count').textContent = saved.length;
  $('saved-empty').classList.toggle('hidden', saved.length > 0);
  $('saved-list').replaceChildren(
    ...saved.map((r) =>
      el('li', { class: `route-item${r.id === state.focusedSavedId ? ' focused' : ''}` }, [
        el('div', { class: 'route-info', onclick: () => focusSaved(r.id) }, [
          el('div', { class: 'route-name', text: r.name }),
          el('div', { class: 'route-meta', text: `${formatDistance(r.distanceM)} · ${formatDate(r.createdAt)}` }),
        ]),
        el('button', { type: 'button', class: 'mini-btn', text: 'GPX', onclick: () => exportGpx(r) }),
        el('button', { type: 'button', class: 'mini-btn secondary', text: '改名', onclick: () => renameRoute('saved', r.id) }),
        el('button', { type: 'button', class: 'mini-btn danger', text: '刪除', onclick: () => deleteRoute('saved', r.id) }),
      ])
    )
  );
}

function focusDraft(id) {
  state.focusedDraftId = state.focusedDraftId === id ? null : id;
  renderDrafts();
  refreshMap();
  const d = getDrafts().find((x) => x.id === state.focusedDraftId);
  if (d && map) fitPoints(d.points);
}

function focusSaved(id) {
  state.focusedSavedId = id;
  renderSaved();
  refreshMap();
  const r = getSaved().find((x) => x.id === id);
  if (r && map) fitPoints(r.points);
}

function renameRoute(kind, id) {
  const list = kind === 'draft' ? getDrafts() : getSaved();
  const r = list.find((x) => x.id === id);
  if (!r) return;
  const name = prompt('新的路線名稱', r.name);
  if (name === null || !name.trim()) return;
  r.name = name.trim().slice(0, 60);
  if (kind === 'draft') setDrafts(list);
  else setSaved(list);
  renderLists();
  refreshMap();
}

function deleteRoute(kind, id) {
  const list = kind === 'draft' ? getDrafts() : getSaved();
  const r = list.find((x) => x.id === id);
  if (!r || !confirm(`確定刪除「${r.name}」？`)) return;
  const rest = list.filter((x) => x.id !== id);
  if (kind === 'draft') setDrafts(rest);
  else setSaved(rest);
  renderLists();
  refreshMap();
}

// ── 合併 ─────────────────────────────────────────────
function segmentPoints(item, draftsById) {
  const d = draftsById.get(item.id);
  if (!d) return [];
  return item.reversed ? d.points.slice().reverse() : d.points;
}

// 後段與前段尾端交會時，剪掉前段多出的尾巴與後段重複的開頭；回傳剪接後要接上的後段點，沒交會則回傳 null
function trimAtOverlap(out, pts) {
  const join = findOverlapJoin(out, pts);
  if (!join) return null;
  out.length = join.k + 1;
  return pts.slice(join.j);
}

// 預覽用：交會處剪接，沒交會的空隙先以直線相接
function buildMergedPreview() {
  const byId = new Map(getDrafts().map((d) => [d.id, d]));
  const out = [];
  for (const item of state.merge.items) {
    let pts = segmentPoints(item, byId);
    if (!pts.length) continue;
    if (out.length) pts = trimAtOverlap(out, pts) || pts;
    appendPoints(out, pts);
  }
  return out;
}

// 儲存用：交會處剪接；真的沒交會的空隙才沿道路補接縫
async function buildMergedFinal() {
  const byId = new Map(getDrafts().map((d) => [d.id, d]));
  const out = [];
  let straightJoins = 0;
  for (const item of state.merge.items) {
    let pts = segmentPoints(item, byId);
    if (!pts.length) continue;
    const trimmed = out.length ? trimAtOverlap(out, pts) : null;
    if (trimmed) {
      pts = trimmed;
    } else if (out.length) {
      const last = out[out.length - 1];
      const gap = haversine(last, pts[0]);
      if (gap > MERGE_GAP_M) {
        let bridged = false;
        if (gap <= BRIDGE_MAX_M) {
          try {
            appendPoints(out, await snapToRoads(resample([last, pts[0]], RESAMPLE_M), { allowSparse: true }));
            bridged = true;
          } catch {
            bridged = false;
          }
        }
        if (!bridged) straightJoins++;
      }
    }
    appendPoints(out, pts);
  }
  return { points: out, straightJoins };
}

function startMerge() {
  if (!state.selectedDrafts.length) return;
  state.merge = { items: state.selectedDrafts.map((id) => ({ id, reversed: false })) };
  const drafts = getDrafts();
  const single = state.merge.items.length === 1 ? drafts.find((d) => d.id === state.merge.items[0].id) : null;
  const today = new Date();
  $('merge-name').value = single
    ? single.name
    : `合併路線 ${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  $('merge-delete-src').checked = false;
  $('drafts-view').classList.add('hidden');
  $('merge-view').classList.remove('hidden');
  renderMerge();
  const pts = buildMergedPreview();
  if (map && pts.length) fitPoints(pts);
}

function endMerge() {
  state.merge = null;
  $('merge-view').classList.add('hidden');
  $('drafts-view').classList.remove('hidden');
  renderDrafts();
  refreshMap();
}

function renderMerge() {
  const byId = new Map(getDrafts().map((d) => [d.id, d]));
  const items = state.merge.items;
  const move = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    renderMerge();
  };
  $('merge-list').replaceChildren(
    ...items.map((item, i) => {
      const d = byId.get(item.id);
      return el('li', { class: 'route-item' }, [
        el('div', { class: 'route-info' }, [
          el('div', { class: 'route-name', text: `${i + 1}. ${d ? d.name : '(已刪除)'}${item.reversed ? '（反向）' : ''}` }),
          el('div', { class: 'route-meta', text: d ? formatDistance(d.distanceM) : '' }),
        ]),
        el('button', { type: 'button', class: 'mini-btn secondary', text: '▲', disabled: i === 0, onclick: () => move(i, -1) }),
        el('button', { type: 'button', class: 'mini-btn secondary', text: '▼', disabled: i === items.length - 1, onclick: () => move(i, 1) }),
        el('button', {
          type: 'button',
          class: `mini-btn ${item.reversed ? '' : 'secondary'}`,
          text: '⇄',
          title: '反轉方向',
          onclick: () => {
            item.reversed = !item.reversed;
            renderMerge();
          },
        }),
      ]);
    })
  );
  $('merge-total').textContent = `預覽總距離：約 ${formatDistance(pathLength(buildMergedPreview()))}`;
  refreshMap();
}

async function saveMerge() {
  const name = $('merge-name').value.trim().slice(0, 60);
  if (!name) {
    toast('請輸入路線名稱');
    $('merge-name').focus();
    return;
  }
  const btn = $('merge-save-btn');
  btn.disabled = true;
  btn.textContent = '處理中…';
  try {
    const { points, straightJoins } = await buildMergedFinal();
    if (points.length < 2) {
      toast('路線點數不足');
      return;
    }
    const rounded = roundPoints(points);
    const route = { id: newId(), name, points: rounded, distanceM: Math.round(pathLength(rounded)), createdAt: Date.now() };
    const saved = getSaved();
    saved.push(route);
    if (!setSaved(saved)) return;
    if ($('merge-delete-src').checked) {
      const used = new Set(state.merge.items.map((x) => x.id));
      setDrafts(getDrafts().filter((d) => !used.has(d.id)));
    }
    state.selectedDrafts = [];
    endMerge();
    renderSaved();
    state.focusedSavedId = route.id;
    switchTab('saved');
    renderSaved();
    if (map) fitPoints(route.points);
    toast(straightJoins ? `已儲存「${name}」（${straightJoins} 處接縫找不到道路，以直線連接）` : `已儲存「${name}」`, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 儲存路線';
  }
}

// ── 設定 ─────────────────────────────────────────────
function openSettings() {
  $('api-key-input').value = getApiKey();
  $('elevation-input').checked = !!getSettings().elevation;
  const dlg = $('settings-dialog');
  if (!dlg.open) dlg.showModal();
}

function saveSettings(e) {
  e.preventDefault();
  const oldKey = getApiKey();
  const key = $('api-key-input').value.trim();
  saveJson(SETTINGS_STORAGE_KEY, { elevation: $('elevation-input').checked });
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  } catch {
    toast('無法儲存金鑰');
    return;
  }
  $('settings-dialog').close();
  // Maps JS 無法在同一頁面換金鑰，重新整理才會生效
  if (key && key !== oldKey) location.reload();
}

// ── 啟動 ─────────────────────────────────────────────
function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('settings-btn').addEventListener('click', openSettings);
  $('placeholder-settings-btn').addEventListener('click', openSettings);
  $('settings-cancel-btn').addEventListener('click', () => $('settings-dialog').close());
  $('settings-form').addEventListener('submit', saveSettings);

  $('undo-btn').addEventListener('click', () => {
    state.strokes.pop();
    state.snapped = null;
    renderLiveLine();
    updateDrawUi();
    refreshMap();
  });
  $('clear-btn').addEventListener('click', () => {
    if (state.strokes.length && !confirm('清除目前的手繪路線？')) return;
    state.strokes = [];
    state.snapped = null;
    renderLiveLine();
    updateDrawUi();
    refreshMap();
  });
  $('snap-btn').addEventListener('click', snapDrawing);
  $('save-draft-btn').addEventListener('click', saveDraft);

  $('merge-start-btn').addEventListener('click', startMerge);
  $('merge-cancel-btn').addEventListener('click', endMerge);
  $('merge-save-btn').addEventListener('click', saveMerge);

  renderLists();
  updateDrawUi();

  const key = getApiKey();
  if (key) loadMapsScript(key);
  else openSettings();
}

init();
