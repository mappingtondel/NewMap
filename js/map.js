import { STYLES, PAL, POI, ROUTE, ME, styleOf, drawIcon } from './styles.js';
import { dist, project, calculateRoute, searchPhoton, reversePhoton, queryOverpass } from './routing.js';
import { $, IC, turnSvg, toast, el, getFavorites, isFavorite, toggleFavorite, getHistory, addHistory, initNetworkMonitor, getSaved, setSaved, getOpts, setOpts, unlockAudio, sfx } from './ui.js';

if (typeof maplibregl === "undefined") {
  toast("Kartenbibliothek konnte nicht geladen werden – bitte online neu laden");
  throw new Error("MapLibre GL fehlt");
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

initNetworkMonitor();

$("styleBtn").innerHTML = IC.layers;
$("locBtn").innerHTML = IC.loc;
$("compassBtn").innerHTML = IC.compass;
$("ovBtn").innerHTML = IC.route;
$("offBtn").innerHTML = IC.download;

let si = 0;
let rawMe = null, smoothMe = null;
let hdg = 0, first = true, follow = true, nav = false;
let dest = null, destMarker = null;
let waypoints = [], wpMarkers = [];
let searchMode = "dest"; // "dest" oder "waypoint"
let shape = [], cum = [], man = [], tripTime = 0, routeGeo = null, lastIdx = 0, spoke = {}, lastReroute = 0, wakeLock = null;
const RAD = Math.PI / 180;
const EMPTY = { type: "FeatureCollection", features: [] };
let routes = [], routeIdx = 0, altGeo = null, busyN = 0;
let sim = null, simTimer = null, simKmh = 50;
let limitKmh = null, limitT = 0, limitBusy = false, limitMiss = 0, spokePost = {}, dlBusy = false;
const setBusy = on => { busyN = Math.max(0, busyN + (on ? 1 : -1)); document.body.classList.toggle("busy", busyN > 0); };
const beep = name => { if (voice) sfx(name); };
let onRoute = false;
let speed = 0, acc = 0, compassOn = false, lastCam = 0, progress = 0, routeSeq = 0, searchSeq = 0, lastGeoErr = 0, meAdded = false;

const map = new maplibregl.Map({
  container: "map",
  style: styleOf(0),
  center: [10.4, 51.1],
  zoom: 5,
  maxPitch: 70,
  attributionControl: false
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-left");
// Ladebildschirm ausblenden (spätestens nach 7 s, falls offline)
map.once("load", () => document.body.classList.add("ready"));
setTimeout(() => document.body.classList.add("ready"), 7000);

// Routen-Layer zuverlässig bei jedem Laden / Stilwechsel aufbauen
map.on("style.load", () => {
  addRoute();
  if (routeGeo && map.getSource("route")) {
    map.getSource("route").setData(routeGeo);
  }
});

map.on("styleimagemissing", e => {
  const [, g, k] = e.id.split("-");
  if (POI[g] && PAL[k]) {
    const c = drawIcon(g, k);
    map.addImage(e.id, c.getContext("2d").getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
});

let lastErr = 0;
map.on("error", e => {
  if (Date.now() - lastErr > 6000) {
    lastErr = Date.now();
    if (!navigator.onLine) return;
    toast("Kartenfehler: " + ((e.error && e.error.message) || "unbekannt"));
  }
});

map.on("dragstart", () => { follow = false; updateCompassBtn(); });
map.on("rotate", updateCompassBtn);
map.on("pitch", updateCompassBtn);

// Fix für mobile Tastatur: verhindert Hängenbleiben des Viewports nach Schließen der Tastatur
window.addEventListener("scroll", () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0);
  }
});
$("q").addEventListener("blur", () => {
  setTimeout(() => {
    window.scrollTo(0, 0);
    map.resize();
  }, 150);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    window.scrollTo(0, 0);
    map.resize();
  });
}
["orientationchange", "pageshow", "resize"].forEach(ev => window.addEventListener(ev, () => setTimeout(() => map.resize(), 200)));

// Hintergrund und Browserleiste in der Farbe der Karte halten, damit unten kein grauer Streifen sichtbar ist
function applyChrome() {
  const bg = PAL[STYLES[si][1]].bg;
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", bg);
}
applyChrome();

function updateCompassBtn() {
  const btn = $("compassBtn");
  if (btn.firstElementChild) btn.firstElementChild.style.transform = "rotate(" + (-map.getBearing()) + "deg)";
  const rotated = Math.abs(map.getBearing()) > 2 || map.getPitch() > 2;
  if (rotated || (nav && !follow)) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

$("compassBtn").onclick = () => {
  if (nav) {
    follow = true;
    camera(true);
  } else {
    map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  }
  updateCompassBtn();
};

const KIND = {
  restaurant:"Restaurant",fast_food:"Imbiss",food_court:"Food Court",ice_cream:"Eisdiele",biergarten:"Biergarten",bakery:"Bäckerei",cafe:"Café",bar:"Bar",pub:"Kneipe",nightclub:"Nachtclub",
  fitness_centre:"Fitnessstudio",sports_centre:"Sportzentrum",gym:"Fitnessstudio",stadium:"Stadion",swimming_pool:"Schwimmbad",townhall:"Rathaus",courthouse:"Gericht",hospital:"Krankenhaus",
  clinic:"Klinik",doctors:"Arzt",pharmacy:"Apotheke",dentist:"Zahnarzt",school:"Schule",kindergarten:"Kindergarten",college:"Hochschule",university:"Universität",library:"Bibliothek",
  supermarket:"Supermarkt",grocery:"Lebensmittel",convenience:"Kiosk",department_store:"Kaufhaus",mall:"Einkaufszentrum",clothing_store:"Modegeschäft",fuel:"Tankstelle",
  charging_station:"Ladestation",hotel:"Hotel",hostel:"Hostel",motel:"Motel",guest_house:"Pension",parking:"Parkplatz",bank:"Bank",atm:"Geldautomat",post_office:"Post",police:"Polizei",
  fire_station:"Feuerwehr",museum:"Museum",cinema:"Kino",theatre:"Theater",castle:"Schloss",zoo:"Zoo",attraction:"Sehenswürdigkeit",pitch:"Sportplatz",swimming:"Schwimmbad",town_hall:"Rathaus",lodging:"Unterkunft",post:"Post",gymnasium:"Sporthalle"
};
const kindOf = p => KIND[p.subclass] || KIND[p.class] || String(p.subclass || p.class || "").replace(/_/g, " ");

map.on("click", e => {
  if (nav) return;
  if (searchMode === "waypoint") {
    addWaypoint({ name: "Gewählter Stopp", lngLat: [e.lngLat.lng, e.lngLat.lat] });
    exitWaypointSearch();
    return;
  }
  if (routes.length > 1 && map.getLayer("route-alt")) {
    const hit = map.queryRenderedFeatures([[e.point.x - 14, e.point.y - 14], [e.point.x + 14, e.point.y + 14]], { layers: ["route-alt"] })[0];
    if (hit) { applyRoute(hit.properties.i); return; }
  }
  const r = 12, box = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
  const ids = Object.keys(POI).map(g => "poi_" + g).filter(id => map.getLayer(id));
  const f = ids.length ? map.queryRenderedFeatures(box, { layers: ids }).find(f => f.properties.name_de || f.properties.name) : null;
  if (f) {
    const p = f.properties, c = f.geometry.type === "Point" ? f.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
    pick({ name: p.name_de || p.name, lngLat: c, sub: kindOf(p), place: true }, false);
    return;
  }
  pick({ name: "Gewählter Punkt", lngLat: [e.lngLat.lng, e.lngLat.lat] }, false);
});

const meEl = document.createElement("div");
meEl.className = "me";
const setMe = () => { meEl.innerHTML = ME[STYLES[si][1]]; };
setMe();
const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: "map", pitchAlignment: "map" });

function animateMarker() {
  if (rawMe && smoothMe) {
    const d = dist(smoothMe, rawMe);
    if (d > 100 || d < 0.15) {
      smoothMe = [...rawMe];
    } else {
      smoothMe[0] += (rawMe[0] - smoothMe[0]) * 0.22;
      smoothMe[1] += (rawMe[1] - smoothMe[1]) * 0.22;
    }
    meMarker.setLngLat(smoothMe);
  }
  requestAnimationFrame(animateMarker);
}
requestAnimationFrame(animateMarker);

$("styleBtn").onclick = () => {
  si = (si + 1) % STYLES.length;
  map.setStyle(styleOf(si), { diff: false });
  applyChrome();
  setMe();
  toast(STYLES[si][0]);
  beep("tick");
  if (destMarker) {
    const ll = destMarker.getLngLat();
    destMarker.remove();
    destMarker = makeDest(ll);
  }
};

function makeDest(ll) {
  return new maplibregl.Marker({ color: STYLES[si][2] }).setLngLat(ll).addTo(map);
}

$("locBtn").onclick = () => {
  initCompass();
  follow = true;
  updateCompassBtn();
  if (nav) camera(true);
  else if (smoothMe) {
    map.easeTo({ center: smoothMe, zoom: Math.max(map.getZoom(), 15) });
  }
};

$("ovBtn").onclick = () => {
  if (!nav || !shape.length) return;
  if (follow) {
    follow = false;
    updateCompassBtn();
    const pts = shape.slice(lastIdx);
    if (!pts.length) return;
    const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
    if (smoothMe) b.extend(smoothMe);
    const h = map.getContainer().clientHeight, pt = Math.min(230, h * 0.3), pb = Math.min(220, h * 0.28);
    map.fitBounds(b, { padding: { top: pt, bottom: pb, left: 40, right: 40 }, pitch: 0, bearing: 0, duration: 700 });
  } else {
    follow = true;
    updateCompassBtn();
    camera(true);
  }
};

$("banner").onclick = () => $("banner").classList.toggle("min");
$("stopBtn").onclick = () => stopNav();

let voice = true;
try { voice = localStorage.getItem("voice") !== "0"; } catch {}
const setVoiceIcon = () => { $("voiceBtn").innerHTML = voice ? IC.voice : IC.mute; };
setVoiceIcon();
$("voiceBtn").onclick = () => {
  voice = !voice;
  setVoiceIcon();
  try { localStorage.setItem("voice", voice ? "1" : "0"); } catch {}
  if (!voice && window.speechSynthesis) speechSynthesis.cancel();
  unlockAudio();
  toast(voice ? "Ansagen und Töne an" : "Ansagen und Töne aus");
  beep("tick");
};
document.addEventListener("click", unlockAudio);

// Ankunft teilen
$("shareBtn").onclick = async () => {
  if (!dest) return;
  const text = "Ich komme voraussichtlich um " + $("eta").textContent + " Uhr bei " + dest.name + " an.";
  const url = gmaps(dest);
  try {
    if (navigator.share) await navigator.share({ title: "Ankunft", text, url });
    else { await navigator.clipboard.writeText(text + " " + url); toast("Text kopiert"); }
  } catch {}
};

// Tempo der Simulation ändern
$("speedTile").onclick = () => {
  if (!sim) return;
  const L = [30, 50, 90, 130];
  simKmh = L[(L.indexOf(simKmh) + 1) % L.length];
  toast("Simulation: " + simKmh + " km/h");
};

/* ---------- Standort & Kompass ---------- */
if ("geolocation" in navigator) {
  navigator.geolocation.watchPosition(onPos, e => {
    if (Date.now() - lastGeoErr > 15000) {
      lastGeoErr = Date.now();
      toast(e.code === 1 ? "Standortzugriff nicht erlaubt" : "GPS-Signal schwach");
    }
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
} else {
  toast("Standort wird nicht unterstützt");
}

const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
function setHeading(h) {
  const d = angDiff(h, hdg);
  if (Math.abs(d) < 1.5) return;
  hdg = (hdg + d * 0.4 + 360) % 360;
  meMarker.setRotation(hdg);
}

function onOri(e) {
  let h = null;
  if (e.webkitCompassHeading != null && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
  if (h == null || speed > 2) return;
  setHeading(h);
  if (nav && follow && Date.now() - lastCam > 600) {
    lastCam = Date.now();
    camera();
  }
}

function initCompass() {
  if (compassOn) return;
  const go = () => {
    compassOn = true;
    window.addEventListener("deviceorientationabsolute", onOri, true);
    window.addEventListener("deviceorientation", onOri, true);
  };
  const DO = window.DeviceOrientationEvent;
  if (DO && typeof DO.requestPermission === "function") {
    DO.requestPermission().then(r => { if (r === "granted") go(); else toast("Kompass nicht erlaubt"); }).catch(() => {});
  } else if (DO) go();
}
document.addEventListener("click", initCompass, { once: true });

function onPos(p) {
  if (!sim) handlePos(p);
}

function handlePos(p) {
  const c = p.coords;
  rawMe = [c.longitude, c.latitude];
  if (!smoothMe) smoothMe = [...rawMe];

  acc = c.accuracy || 0;
  speed = c.speed > 0 ? c.speed : 0;
  const kmh = Math.round(speed * 3.6);
  const spdEl = $("speedVal");
  if (spdEl) spdEl.textContent = kmh;

  if (c.heading != null && !isNaN(c.heading) && speed > (compassOn ? 2 : 1)) setHeading(c.heading);
  meMarker.setLngLat(smoothMe).setRotation(hdg);
  if (!meAdded) { meMarker.addTo(map); meAdded = true; }

  if (first) {
    first = false;
    map.jumpTo({ center: smoothMe, zoom: 15 });
  }
  if (follow) camera();
  if (nav) navStep();
}

function camera(resetZoom) {
  const ctr = rawMe || smoothMe;
  if (!ctr) return;
  map.easeTo({
    center: ctr,
    bearing: nav ? hdg : map.getBearing(),
    zoom: nav && resetZoom ? 16.5 : map.getZoom(),
    pitch: nav ? 60 : map.getPitch(),
    padding: { top: nav ? 260 : 0, bottom: 0, left: 0, right: 0 },
    duration: 900
  });
}

/* ---------- Favoriten-Chips & Suchverlauf ---------- */
function renderChips() {
  const box = $("chips");
  box.innerHTML = "";
  const favs = getFavorites();
  const hist = getHistory().filter(h => !favs.some(f => f.name === h.name));

  [["home", "Zuhause", IC.home], ["work", "Arbeit", IC.work]].forEach(([k, label, ic]) => {
    const v = getSaved(k);
    if (!v) return;
    const b = el("button", "chip");
    b.innerHTML = ic;
    b.append(document.createTextNode(label));
    b.onclick = () => handlePlaceSelection(getSaved(k) || v, true);
    box.append(b);
  });

  favs.forEach(f => {
    const b = el("button", "chip fav");
    b.innerHTML = IC.starFill;
    b.append(document.createTextNode(f.name));
    b.onclick = () => handlePlaceSelection(f, true);
    box.append(b);
  });

  hist.slice(0, 5).forEach(h => {
    const b = el("button", "chip");
    b.textContent = h.name;
    b.onclick = () => handlePlaceSelection(h, true);
    box.append(b);
  });
}
renderChips();

/* ---------- Suche (Photon) für Ziel & Zwischenstopps ---------- */
let timer;
$("q").oninput = () => { clearTimeout(timer); timer = setTimeout(search, 350); };
$("qCancel").onclick = exitWaypointSearch;

function startWaypointSearch() {
  searchMode = "waypoint";
  $("sheet").classList.add("wp-mode");
  $("card").style.display = "none";
  $("results").innerHTML = "";
  $("q").value = "";
  $("q").placeholder = "Zwischenstopp suchen …";
  $("q").focus();
}

function exitWaypointSearch() {
  searchMode = "dest";
  $("sheet").classList.remove("wp-mode");
  $("results").innerHTML = "";
  $("q").value = "";
  $("q").placeholder = "Suche nach Orten";
  $("q").blur();
  if (dest) $("card").style.display = "block";
}

function handlePlaceSelection(placeObj, fly) {
  if (searchMode === "waypoint") {
    addWaypoint(placeObj);
    exitWaypointSearch();
  } else {
    pick(placeObj, fly);
  }
}

async function search() {
  const s = $("q").value.trim(), box = $("results"), my = ++searchSeq;
  box.innerHTML = "";
  if (s.length < 3) return;
  try {
    const features = await searchPhoton(s, rawMe);
    if (my !== searchSeq) return;
    features.forEach(f => {
      const p = f.properties, street = [p.street, p.housenumber].filter(Boolean).join(" ");
      const name = p.name || street;
      if (!name) return;
      const sub = [p.name ? street : "", p.city || p.town || p.village || p.locality || p.district, p.country].filter(Boolean).join(", ");
      const b = el("button", "row");
      const left = el("div");
      left.append(el("b", null, name), el("small", null, sub));
      b.append(left);
      const place = !!p.name && !["highway", "place", "boundary", "waterway"].includes(p.osm_key);
      const area = [[p.postcode, p.city || p.town || p.village || p.locality || p.district].filter(Boolean).join(" "), p.state, p.country].filter(Boolean).join(", ");
      const item = { name, lngLat: f.geometry.coordinates, sub, place, addr: p.name ? street : "", area, osm: { t: p.osm_type, id: p.osm_id } };
      b.onclick = () => handlePlaceSelection(item, true);
      box.append(b);
    });
  } catch {
    if (my === searchSeq) toast("Suche nicht erreichbar");
  }
}

function clearRoute() {
  routeGeo = null;
  altGeo = null;
  routes = [];
  routeIdx = 0;
  shape = []; man = []; cum = [];
  map.getSource("route")?.setData(EMPTY);
  map.getSource("route-alt")?.setData(EMPTY);
  $("alts").innerHTML = "";
  $("opts").innerHTML = "";
  $("along").innerHTML = "";
}

function pick(d, fly) {
  dest = d;
  waypoints = [];
  clearWaypointMarkers();
  clearRoute();
  $("results").innerHTML = "";
  $("q").value = "";
  $("q").blur();
  follow = false;
  updateCompassBtn();
  if (destMarker) destMarker.remove();
  destMarker = makeDest(d.lngLat);
  if (fly) map.flyTo({ center: d.lngLat, zoom: 15 });
  if (d.place) {
    enrich(d);
    locate(d);
  }
  addHistory(d);
  renderChips();
  renderPlace(d);
}

function addWaypoint(wp) {
  waypoints.push(wp);
  const m = new maplibregl.Marker({ color: "#ffffff", scale: 0.75 }).setLngLat(wp.lngLat).addTo(map);
  wpMarkers.push(m);
  toast("Zwischenstopp: " + wp.name);
  planRoute();
}

function clearWaypointMarkers() {
  wpMarkers.forEach(m => m.remove());
  wpMarkers = [];
}

function renderWaypointsList() {
  const box = $("waypoints");
  box.innerHTML = "";
  waypoints.forEach((wp, idx) => {
    const row = el("div", "wp-item");
    row.append(el("span", null, `Stopp ${idx + 1}: ${wp.name}`));
    const del = el("button", null, "✕");
    del.onclick = () => {
      waypoints.splice(idx, 1);
      wpMarkers[idx]?.remove();
      wpMarkers.splice(idx, 1);
      renderWaypointsList();
      if (dest && dest.routed) planRoute();
    };
    row.append(del);
    box.append(row);
  });
}

const ext = u => window.open(u, "_blank", "noopener");
const where = d => [d.addr, d.area].filter(Boolean).join(", ");
function gmaps(d) {
  const w = where(d);
  const q = w ? d.name + ", " + w : d.lngLat[1] + "," + d.lngLat[0];
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}
function openWeb(d) {
  if (d.web) return ext(d.web);
  ext("https://www.google.com/search?hl=de&q=" + encodeURIComponent([d.name, where(d)].filter(Boolean).join(" ")));
}

async function locate(d) {
  if (d.area) return;
  const area = await reversePhoton(d.lngLat);
  if (area) d.area = area;
}

function renderPlace(d) {
  renderWaypointsList();
  const b = [["Route", planRoute, 1]];
  if (d.place) {
    b.push([d.web ? "@globe Webseite" : "@search Web-Suche", () => openWeb(d)]);
    b.push(["@pin Google Maps", () => ext(gmaps(d))]);
    b.push(["@close", cancel]);
  } else {
    b.push(["Schließen", cancel]);
  }
  showCard(d.name, d.sub || "", b, d);
  renderPlaceChips(d);
}

const samePlace = (a, b) => a && b && a.name === b.name && Math.abs(a.lngLat[0] - b.lngLat[0]) < 0.0005 && Math.abs(a.lngLat[1] - b.lngLat[1]) < 0.0005;
function renderPlaceChips(d) {
  $("alts").innerHTML = "";
  $("along").innerHTML = "";
  const box = $("opts");
  box.innerHTML = "";
  [["home", "Zuhause"], ["work", "Arbeit"]].forEach(([k, label]) => {
    const isSet = samePlace(getSaved(k), d);
    const b = el("button", "chip" + (isSet ? " on" : ""), isSet ? "✓ " + label : "Als " + label);
    b.onclick = () => {
      setSaved(k, isSet ? null : d);
      toast(isSet ? label + " entfernt" : label + " gespeichert");
      renderChips();
      renderPlaceChips(d);
    };
    box.append(b);
  });
}

async function enrich(d) {
  d.looking = true;
  try {
    const [lon, lat] = d.lngLat, ty = { N: "node", W: "way", R: "relation" }[d.osm && d.osm.t], id = d.osm && d.osm.id;
    const els = await queryOverpass(`[out:json][timeout:6];(${ty && id ? `${ty}(${id});` : ""}nwr(around:50,${lat},${lon})["name"];);out tags center 80;`);
    if (els) {
      const n = d.name.toLowerCase(), same = x => ["name", "name:de", "brand", "official_name"].some(k => x[k] && x[k].toLowerCase() === n);
      const hasW = x => x && (x.website || x["contact:website"] || x.url || x["contact:url"]);
      const own = ty && id ? (els.find(e => e.type === ty && e.id === id) || {}).tags : null;
      const all = els.map(e => e.tags || {});
      const t = hasW(own) ? own : (all.find(x => same(x) && hasW(x)) || own || all.find(same));
      if (t) {
        const w = t.website || t["contact:website"] || t.url || t["contact:url"];
        if (w) d.web = /^https?:\/\//i.test(w) ? w : "https://" + w;
        const a = [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), t["addr:city"]].filter(Boolean).join(", ");
        if (a) {
          d.addr = a;
          if (!d.osm) d.sub = [d.sub, a].filter(Boolean).join(" · ");
        }
      }
    }
  } catch {}
  d.looking = false;
  if (dest === d && !d.routed) renderPlace(d);
}

function showCard(t, s, btns, placeObj) {
  $("cTitle").textContent = t;
  $("cSub").textContent = s;
  const favBtn = $("favToggle");
  if (placeObj) {
    favBtn.style.display = "block";
    const updateFavIcon = () => {
      const active = isFavorite(placeObj);
      favBtn.classList.toggle("active", active);
      favBtn.innerHTML = active ? IC.starFill : IC.star;
    };
    updateFavIcon();
    favBtn.onclick = () => {
      toggleFavorite(placeObj);
      updateFavIcon();
      renderChips();
    };
  } else {
    favBtn.style.display = "none";
  }

  const b = $("cBtns");
  b.innerHTML = "";
  btns.forEach(([l, fn, p]) => {
    const x = el("button", "btn" + (p ? " p" : ""));
    const m = /^@(\w+)\s?(.*)$/.exec(l);
    if (m) {
      x.innerHTML = IC[m[1]];
      if (m[2]) x.append(m[2]);
      else x.setAttribute("aria-label", "Schließen");
    } else x.textContent = l;
    x.onclick = fn;
    b.append(x);
  });
  $("card").style.display = "block";
}

function cancel() {
  $("card").style.display = "none";
  $("results").innerHTML = "";
  $("waypoints").innerHTML = "";
  searchMode = "dest";
  $("sheet").classList.remove("wp-mode");
  $("q").placeholder = "Suche nach Orten";
  dest = null;
  waypoints = [];
  clearWaypointMarkers();
  routeSeq++;
  clearRoute();
  if (destMarker) {
    destMarker.remove();
    destMarker = null;
  }
}

/* ---------- Routing ---------- */
async function fetchRoute(alternates) {
  if (!dest || !rawMe) throw new Error("Kein Ziel");
  const target = dest, res = await calculateRoute(rawMe, waypoints, target.lngLat, { ...getOpts(), alternates: alternates ? 2 : 0 });
  if (dest !== target) throw new Error("Ziel geändert");
  routes = res;
  setRoute(0);
  return res;
}

// Eine der berechneten Routen zur aktiven Route machen
function setRoute(i) {
  routeIdx = i;
  const r = routes[i];
  shape = r.shape;
  man = r.man;
  cum = r.cum;
  tripTime = r.tripTime;
  routeGeo = { type: "Feature", geometry: { type: "LineString", coordinates: shape } };
  altGeo = { type: "FeatureCollection", features: routes.map((x, j) => j === i ? null : { type: "Feature", properties: { i: j }, geometry: { type: "LineString", coordinates: x.shape } }).filter(Boolean) };
  if (!map.getSource("route")) addRoute();
  map.getSource("route")?.setData(routeGeo);
  map.getSource("route-alt")?.setData(altGeo);
  lastIdx = 0;
  spoke = {};
  spokePost = {};
  onRoute = false;
  if (sim) { sim.s = 0; sim.i = 0; }
}

function applyRoute(i) {
  if (!routes[i] || i === routeIdx) return;
  setRoute(i);
  beep("tick");
  renderRouteCard();
}

const fmtDur = min => min >= 60 ? Math.floor(min / 60) + " Std. " + String(min % 60).padStart(2, "0") + " min" : min + " min";
const fmtKm = km => km.toFixed(1).replace(".", ",") + " km";

function renderRouteCard() {
  const s = routes[routeIdx].summary;
  showCard(
    fmtKm(s.length) + " · " + fmtDur(Math.round(s.time / 60)),
    dest.name,
    [
      ["Los", startNav, 1],
      ["@play Simulation", startSim],
      ["@plus Stopp", startWaypointSearch],
      ["Abbrechen", cancel]
    ],
    dest
  );
  renderAlts();
  renderRouteOpts();
  renderAlong();
}

function renderAlts() {
  const box = $("alts");
  box.innerHTML = "";
  if (routes.length < 2) return;
  routes.forEach((r, i) => {
    const b = el("button", "alt" + (i === routeIdx ? " on" : ""));
    b.append(el("b", null, fmtDur(Math.round(r.summary.time / 60))), el("small", null, fmtKm(r.summary.length)));
    b.onclick = () => applyRoute(i);
    box.append(b);
  });
}

// Routenoptionen: Autobahn / Maut / Fähren möglichst meiden
function renderRouteOpts() {
  const box = $("opts");
  box.innerHTML = "";
  const o = getOpts();
  [["highways", "Autobahn meiden"], ["tolls", "Maut meiden"], ["ferry", "Fähren meiden"]].forEach(([k, label]) => {
    const b = el("button", "chip" + (o[k] ? " on" : ""), label);
    b.onclick = () => {
      const cur = getOpts();
      cur[k] = !cur[k];
      setOpts(cur);
      renderRouteOpts();
      planRoute();
    };
    box.append(b);
  });
}

// Orte entlang der Route (Overpass)
const ALONG = [
  ["Tanken", '["amenity"="fuel"]'],
  ["Laden", '["amenity"="charging_station"]'],
  ["Parken", '["amenity"="parking"]["access"!="private"]'],
  ["Essen", '["amenity"~"^(restaurant|fast_food)$"]'],
  ["Café", '["amenity"="cafe"]']
];
function renderAlong() {
  const box = $("along");
  box.innerHTML = "";
  ALONG.forEach(([label, filter]) => {
    const b = el("button", "chip", label + " unterwegs");
    b.onclick = () => searchAlong(label, filter);
    box.append(b);
  });
}

async function searchAlong(label, filter) {
  if (shape.length < 2) return;
  if (!navigator.onLine) { toast("Offline – Suche nicht möglich"); return; }
  const total = cum[cum.length - 1], step = Math.max(500, total / 100), pts = [];
  let next = 0;
  for (let i = 0; i < shape.length; i++) {
    if (cum[i] >= next || i === shape.length - 1) {
      pts.push(shape[i][1].toFixed(5) + "," + shape[i][0].toFixed(5));
      next = cum[i] + step;
    }
  }
  const box = $("results");
  box.innerHTML = "";
  setBusy(true);
  const els = await queryOverpass(`[out:json][timeout:8];nwr(around:500,${pts.join(",")})${filter};out center 120;`);
  setBusy(false);
  if (!els) { toast("Suche nicht erreichbar"); return; }
  const items = [];
  els.forEach(e => {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || lon == null) return;
    let bd = 1e12, bs = 0;
    for (let i = 0; i < shape.length - 1; i++) {
      const r = project([lon, lat], shape[i], shape[i + 1]);
      if (r.d < bd) { bd = r.d; bs = cum[i] + r.t * (cum[i + 1] - cum[i]); }
    }
    const t = e.tags || {};
    items.push({ name: t.name || t.brand || t.operator || label, kind: KIND[t.amenity] || label, lngLat: [lon, lat], d: bd, s: bs });
  });
  if (!items.length) { toast("Nichts auf der Strecke gefunden"); return; }
  items.sort((a, b) => a.d - b.d);
  items.slice(0, 8).sort((a, b) => a.s - b.s).forEach(it => {
    const row = el("button", "row");
    const left = el("div");
    left.append(el("b", null, it.name), el("small", null, it.kind + " · bei km " + Math.round(it.s / 1000) + " · " + (Math.round(it.d / 10) * 10) + " m abseits"));
    row.append(left);
    row.onclick = () => {
      box.innerHTML = "";
      addWaypoint({ name: it.name, lngLat: it.lngLat, sub: it.kind, place: true });
    };
    box.append(row);
  });
}

async function planRoute() {
  if (!rawMe) {
    toast("Warte auf GPS …");
    return;
  }
  if (!navigator.onLine) {
    toast("Offline – Route kann nicht berechnet werden");
    return;
  }
  if (!dest) return;
  const my = ++routeSeq;
  setBusy(true);
  try {
    await fetchRoute(true);
    if (my !== routeSeq || !dest) return;
    const b = new maplibregl.LngLatBounds(shape[0], shape[0]);
    routes.forEach(r => r.shape.forEach(c => b.extend(c)));
    map.fitBounds(b, { padding: { top: 80, bottom: 300, left: 40, right: 40 } });
    dest.routed = true;
    renderWaypointsList();
    renderRouteCard();
    beep("route");
  } catch (err) {
    if (my !== routeSeq) return;
    const msg = String((err && err.message) || "");
    toast(/no route|no suitable|found/i.test(msg) ? "Keine Route gefunden" : "Routing nicht erreichbar");
    beep("error");
  } finally {
    setBusy(false);
  }
}

const rw = w => ["interpolate", ["linear"], ["zoom"], 9, w * 0.45, 15, w, 19, w * 1.7];
function addRoute() {
  if (map.getSource("route")) return;
  const R = ROUTE[STYLES[si][1]];
  map.addSource("route", { type: "geojson", data: routeGeo || EMPTY });
  map.addSource("route-alt", { type: "geojson", data: altGeo || EMPTY });
  const lay = { "line-cap": "round", "line-join": "round" };
  const before = map.getLayer("road_labels") ? "road_labels" : undefined;
  map.addLayer({ id: "route-alt", type: "line", source: "route-alt", layout: lay, paint: { "line-color": "#8f959c", "line-opacity": 0.8, "line-width": rw(R.w * 0.85) } }, before);
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: lay, paint: { "line-color": R.cc, "line-opacity": R.co, "line-width": rw(R.cw) } }, before);
  map.addLayer({ id: "route-line", type: "line", source: "route", layout: lay, paint: { "line-color": R.col, "line-opacity": R.op, "line-width": rw(R.w) } }, before);
}

/* ---------- Navigation ---------- */
const fmt = d => {
  const m = d < 150 ? Math.max(10, Math.round(d / 10) * 10) : Math.round(d / 50) * 50;
  return m >= 1000 ? (d / 1000).toFixed(1).replace(".", ",") + " km" : m + " m";
};
function speak(t) {
  if (!voice || !t || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(t);
  u.lang = "de-DE";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
async function wake() {
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (nav && document.visibilityState === "visible") wake(); });

function startNav() {
  initCompass();
  nav = true;
  follow = true;
  updateCompassBtn();
  document.body.classList.add("nav");
  $("banner").classList.remove("min");
  $("card").style.display = "none";
  if (routes.length > 1) {
    routes = [routes[routeIdx]];
    routeIdx = 0;
    altGeo = null;
    map.getSource("route-alt")?.setData(EMPTY);
  }
  limitKmh = null;
  limitT = 0;
  speak("Navigation gestartet");
  wake();
  camera(true);
  // Anzeige sofort mit der ersten Anweisung füllen, damit sie nie leer ist
  const k0 = man.findIndex((m, i) => i > 0);
  if (k0 >= 0) showManeuver(k0, cum[man[k0].begin_shape_index]);
  if (shape.length > 0) navStep();
}

function stopNav(arrived) {
  stopSim();
  nav = false;
  limitKmh = null;
  renderLimit();
  document.body.classList.remove("nav");
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (!arrived && window.speechSynthesis) speechSynthesis.cancel();
  cancel();
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  updateCompassBtn();
}

// Abbiegeanzeige oben links (Pfeil, Entfernung, Text, nächste Anweisung)
function showManeuver(k, d) {
  const m = man[k];
  if (!m) return;
  const ico = $("bIco");
  if (ico.dataset.t != m.type) { ico.dataset.t = m.type; ico.innerHTML = turnSvg(m.type); }
  $("bDist").textContent = fmt(d);
  $("bText").textContent = m.instruction;
  const n = man[k + 1];
  $("b2").hidden = !n;
  if (n) {
    const i2 = $("b2Ico");
    if (i2.dataset.t != n.type) { i2.dataset.t = n.type; i2.innerHTML = turnSvg(n.type); }
    $("b2Text").textContent = n.instruction;
  }
}

// Zwischenstopps, die man erreicht hat, nicht mehr für die Neuberechnung verwenden
function passWaypoints() {
  for (let i = waypoints.length - 1; i >= 0; i--) {
    if (dist(rawMe, waypoints[i].lngLat) < 50) {
      waypoints.splice(i, 1);
      wpMarkers[i]?.remove();
      wpMarkers.splice(i, 1);
    }
  }
}

// Position auf die Route projizieren (Abstand zu Strecken, nicht nur zu Stützpunkten)
function matchRoute() {
  let bi = -1, bd = 1e12, bt = 0;
  for (let i = Math.max(0, lastIdx - 3); i < shape.length - 1; i++) {
    if (i > lastIdx + 3 && cum[i] - cum[lastIdx] > 1500) break;
    const r = project(rawMe, shape[i], shape[i + 1]);
    if (r.d < bd) { bd = r.d; bi = i; bt = r.t; }
  }
  return { bi, bd, bt };
}

async function navStep() {
  if (!rawMe || shape.length < 2) return;
  passWaypoints();
  renderLimit();
  updateLimit();
  const { bi, bd, bt } = matchRoute();
  const off = bi < 0 || bd > Math.max(60, Math.min(acc * 1.5, 200));
  if (off && !onRoute && bi >= 0 && bd < 300) {
    // Noch nicht auf der Route (z. B. Start abseits der Straße): erste Anweisung zeigen, noch nicht neu berechnen
    const k0 = man.findIndex((m, i) => i > 0);
    if (k0 >= 0) showManeuver(k0, bd + cum[man[k0].begin_shape_index]);
    return;
  }
  if (!off) onRoute = true;
  if (off) {
    const ico = $("bIco");
    if (ico.dataset.t !== "reroute") { ico.dataset.t = "reroute"; ico.innerHTML = turnSvg(12); }
    $("bDist").textContent = "Neue Route";
    $("bText").textContent = "Route wird neu berechnet …";
    $("b2").hidden = true;
    if (!navigator.onLine) {
      if (Date.now() - lastReroute > 15000) {
        lastReroute = Date.now();
        toast("Offline – Neuberechnung pausiert");
      }
      return;
    }
    if (Date.now() - lastReroute > 10000) {
      lastReroute = Date.now();
      speak("Route wird neu berechnet");
      beep("reroute");
      try { await fetchRoute(false); } catch { if (nav) toast("Neuberechnung fehlgeschlagen"); }
    }
    return;
  }
  lastIdx = bi;
  progress = cum[bi] + bt * (cum[bi + 1] - cum[bi]);
  const total = cum[cum.length - 1], rem = Math.max(0, total - progress);
  if (rem < 25) {
    speak("Sie haben Ihr Ziel erreicht");
    beep("arrive");
    stopNav(true);
    return;
  }
  const k = man.findIndex((m, i) => i > 0 && m.begin_shape_index > bi);
  if (k < 0) return;
  const m = man[k], d = Math.max(0, cum[m.begin_shape_index] - progress);
  showManeuver(k, d);
  const mins = Math.max(1, Math.round(tripTime * (total > 0 ? rem / total : 0) / 60));
  $("eta").textContent = new Date(Date.now() + mins * 60000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  $("remT").textContent = mins >= 60 ? Math.floor(mins / 60) + ":" + String(mins % 60).padStart(2, "0") : mins;
  $("remTL").textContent = mins >= 60 ? "Std." : "Min.";
  $("remD").textContent = (rem / 1000).toFixed(1).replace(".", ",");
  const st = spoke[k] || 0, prev = man[k - 1];
  const pre = m.verbal_pre_transition_instruction || m.instruction, alert = m.verbal_transition_alert_instruction || pre;
  if (d <= 80 && st < 2) { spoke[k] = 2; speak(pre); }
  else if (d <= 450 && st < 1) { spoke[k] = 1; speak("In " + Math.round(d / 50) * 50 + " Metern: " + alert); }
  else if (prev && prev.verbal_post_transition_instruction && d > 1000 && !spokePost[k] && progress - cum[prev.begin_shape_index] > 60) {
    spokePost[k] = 1;
    speak(prev.verbal_post_transition_instruction);
  }
}

/* ---------- Tempolimit (OSM maxspeed) ---------- */
const MAXSPEED = { "DE:urban": 50, "DE:rural": 100, "DE:zone30": 30, "DE:living_street": 7, "AT:urban": 50, "AT:rural": 100, walk: 7 };
function parseMax(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return +v;
  const mph = /^(\d+)\s*mph$/i.exec(v);
  if (mph) return Math.round(mph[1] * 1.609);
  return MAXSPEED[v] || null;
}

async function updateLimit() {
  if (limitBusy || !rawMe || !navigator.onLine) return;
  if (Date.now() - limitT < 12000 || (speed < 1 && limitKmh)) return;
  limitT = Date.now();
  limitBusy = true;
  try {
    const [lon, lat] = rawMe;
    const els = await queryOverpass(`[out:json][timeout:5];way(around:18,${lat},${lon})[highway][maxspeed];out tags 6;`);
    if (els) {
      const vals = els.map(e => parseMax(e.tags && e.tags.maxspeed)).filter(Boolean);
      if (vals.length) { limitKmh = vals[0]; limitMiss = 0; }
      else if (++limitMiss >= 2) limitKmh = null;
    }
  } finally {
    limitBusy = false;
  }
  renderLimit();
}

function renderLimit() {
  const box = $("limit");
  if (!nav || !limitKmh) { box.hidden = true; return; }
  box.hidden = false;
  $("limitVal").textContent = limitKmh;
  box.classList.toggle("over", speed * 3.6 > limitKmh + 3);
}

/* ---------- Simulation: Route selbst abfahren ---------- */
const bearing = (a, b) => {
  const dl = (b[0] - a[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
};

function startSim() {
  if (shape.length < 2) return;
  sim = { s: 0, i: 0 };
  document.body.classList.add("sim");
  $("simTag").hidden = false;
  startNav();
  clearInterval(simTimer);
  simTimer = setInterval(simTick, 1000);
  simTick();
}

function stopSim() {
  sim = null;
  clearInterval(simTimer);
  simTimer = null;
  document.body.classList.remove("sim");
  $("simTag").hidden = true;
}

function simTick() {
  if (!sim || !nav || shape.length < 2) return;
  const v = simKmh / 3.6;
  sim.s = Math.min(sim.s + v, cum[cum.length - 1]);
  let i = sim.i || 0;
  if (i >= shape.length - 1) i = 0;
  while (i < shape.length - 2 && cum[i + 1] < sim.s) i++;
  sim.i = i;
  const seg = cum[i + 1] - cum[i], t = seg > 0 ? Math.min(1, (sim.s - cum[i]) / seg) : 0;
  const a = shape[i], b = shape[i + 1];
  handlePos({ coords: { longitude: a[0] + (b[0] - a[0]) * t, latitude: a[1] + (b[1] - a[1]) * t, speed: v, heading: bearing(a, b), accuracy: 5 } });
}

/* ---------- Offline-Karte: aktuellen Ausschnitt speichern ---------- */
const tileX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const tileY = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * 2 ** z);

async function downloadRegion() {
  if (dlBusy) return;
  if (!navigator.onLine) { toast("Offline – Speichern nicht möglich"); return; }
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) { toast("Offline-Speicher noch nicht bereit – App neu laden"); return; }
  dlBusy = true;
  setBusy(true);
  try {
    const tj = await (await fetch("https://tiles.openfreemap.org/planet")).json();
    const tpl = tj.tiles && tj.tiles[0], maxZ = Math.min(tj.maxzoom || 14, 14);
    if (!tpl) throw new Error("TileJSON");
    const bnd = map.getBounds(), w = bnd.getWest(), e = bnd.getEast(), so = Math.max(bnd.getSouth(), -85), no = Math.min(bnd.getNorth(), 85);
    const range = z => {
      const x0 = tileX(w, z), x1 = tileX(e, z), y0 = tileY(no, z), y1 = tileY(so, z);
      return { z, x0, x1, y0, y1, c: (x1 - x0 + 1) * (y1 - y0 + 1) };
    };
    const lo = Math.max(5, Math.floor(map.getZoom()) - 2);
    let hi = maxZ, list = [];
    for (; hi >= lo; hi--) {
      list = [];
      for (let z = lo; z <= hi; z++) list.push(range(z));
      if (list.reduce((a, r) => a + r.c, 0) <= 800) break;
    }
    if (hi < lo) { toast("Ausschnitt zu groß – bitte weiter hineinzoomen"); return; }
    const urls = [];
    list.forEach(r => {
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
        urls.push(tpl.replace("{z}", r.z).replace("{x}", x).replace("{y}", y));
      }
    });
    ["0-255", "256-511", "512-767"].forEach(rg => urls.push("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/" + rg + ".pbf"));
    let idx = 0, done = 0, fail = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const u = urls[idx++];
        try {
          const r = await fetch(u);
          if (r.ok) await r.arrayBuffer();
          else if (r.status !== 404 && r.status !== 204) fail++;
        } catch { fail++; }
        if (++done % 25 === 0) toast("Offline-Karte: " + Math.round(done / urls.length * 100) + " %");
      }
    };
    toast("Speichere " + urls.length + " Kacheln …");
    await Promise.all(Array.from({ length: 6 }, worker));
    toast(fail ? "Gespeichert, " + fail + " Kacheln fehlgeschlagen" : "Offline-Karte gespeichert (bis Zoom " + hi + ")");
    beep("route");
  } catch {
    toast("Speichern fehlgeschlagen");
    beep("error");
  } finally {
    dlBusy = false;
    setBusy(false);
  }
}
$("offBtn").onclick = downloadRegion;
