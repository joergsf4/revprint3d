'use strict';
// RevPrint3D – Familieneditor nach Revit-Vorbild. Modell in mm, Z zeigt nach oben (wie Revit und Slicer).
// shortcut: three 0.147 because of classic scripts for file://, upgrade when moving to a local server/hosting

const GRID = 10;      // Fangraster in mm
const MM_PER_PX = 4;  // Maßstab der Ansicht bei Zoom 1
const NAME_RE = /^[A-Za-zÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß_]*$/;

// Arbeitsebenen: u/v sind die Zeichenachsen der Ansicht.
const PLANES = {
  grundriss: { label: 'Grundriss: Referenzebene', u: [1, 0, 0], v: [0, 1, 0] },
  vorne:     { label: 'Ansicht: Vorne',           u: [1, 0, 0], v: [0, 0, 1] },
  rechts:    { label: 'Ansicht: Rechts',          u: [0, 1, 0], v: [0, 0, 1] },
};

// w = u × v zeigt zum Betrachter; so bleibt das System rechtshändig und die STL-Normalen zeigen nach außen.
function basis(plane) {
  const u = new THREE.Vector3(...PLANES[plane].u), v = new THREE.Vector3(...PLANES[plane].v);
  return { u, v, w: new THREE.Vector3().crossVectors(u, v) };
}

const fmt = n => String(Math.round(n * 10) / 10);

// Formeln wie in Revit: Zahlen, Parameternamen, + - * / und Klammern. Komma als Dezimalzeichen erlaubt.
function evaluate(expr, params, seen = []) {
  const src = String(expr).trim().replace(/,/g, '.');
  if (!src) throw new Error('Leerer Wert');
  const js = src.replace(/[A-Za-zÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß_]*/g, name => {
    if (!Object.hasOwn(params, name)) throw new Error(`Unbekannter Parameter „${name}“`);
    if (seen.includes(name)) throw new Error(`Zirkelbezug bei „${name}“`);
    return `(${evaluate(params[name], params, [...seen, name]).toFixed(6)})`;
  });
  // Nach dem Einsetzen dürfen nur Zahlen und Rechenzeichen übrig sein – so führt auch eine fremde Datei keinen Code aus.
  if (!/^[\d\s+\-*\/().]*$/.test(js)) throw new Error(`Ungültige Formel „${expr}“`);
  let value;
  try { value = Function(`"use strict"; return (${js});`)(); } catch { throw new Error(`Ungültige Formel „${expr}“`); }
  if (!Number.isFinite(value)) throw new Error(`Formel „${expr}“ ergibt keine Zahl`);
  return value;
}

function loopPoints(shape, params) {
  if (shape.type === 'rect') {
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => evaluate(shape[k], params));
    if (!w || !h) throw new Error('Rechteck mit Breite oder Höhe 0');
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  return shape.pts.map(p => p.map(c => evaluate(c, params)));
}

function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Wie in Revit: eine geschlossene Kontur innerhalb einer anderen ist eine Öffnung, darin wieder ein Körper usw.
// shortcut: sich schneidende Konturen werden nicht erkannt, prüfen falls Nutzer darüber stolpern
function toShapes(loops) {
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && inside(l[0], o)).length);
  const vec = l => l.map(p => new THREE.Vector2(...p));
  const shapes = loops.map((l, i) => depth[i] % 2 ? null : new THREE.Shape(vec(l)));
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    const parent = loops.findIndex((o, j) => depth[j] === depth[i] - 1 && inside(l[0], o));
    shapes[parent].holes.push(new THREE.Path(vec(l)));
  });
  return shapes.filter(Boolean);
}

function buildGeometry(el, params) {
  const start = evaluate(el.start, params), end = evaluate(el.end, params);
  if (start === end) throw new Error('Extrusionsanfang und Extrusionsende sind gleich');
  const geo = new THREE.ExtrudeGeometry(toShapes(el.shapes.map(s => loopPoints(s, params))),
    { depth: Math.abs(end - start), bevelEnabled: false });
  geo.translate(0, 0, Math.min(start, end));
  const { u, v, w } = basis(el.plane);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, w));
  return geo;
}

// Druckbar heißt dicht: jede Kante gehört zu genau zwei Dreiecken.
function isClosed(geo) {
  const p = geo.attributes.position, idx = geo.index, n = idx ? idx.count : p.count;
  const key = i => [p.getX(i), p.getY(i), p.getZ(i)].map(c => c.toFixed(3)).join();
  const edges = new Map();
  for (let t = 0; t < n; t += 3) {
    const k = [0, 1, 2].map(j => key(idx ? idx.getX(t + j) : t + j));
    for (let j = 0; j < 3; j++) {
      const e = [k[j], k[(j + 1) % 3]].sort().join('|');
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  return [...edges.values()].every(c => c === 2);
}

const emptyDoc = () => ({ name: 'Familie1', params: {}, elements: [] });

function validDoc(d) {
  const str = x => typeof x === 'string';
  const shapeOk = s => s && (s.type === 'rect'
    ? ['x', 'y', 'w', 'h'].every(k => str(s[k]))
    : s.type === 'poly' && Array.isArray(s.pts) && s.pts.length >= 3
      && s.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(str)));
  return !!d && str(d.name) && !!d.params && typeof d.params === 'object'
    && Object.entries(d.params).every(([k, v]) => NAME_RE.test(k) && str(v))
    && Array.isArray(d.elements)
    && d.elements.every(e => e && Object.hasOwn(PLANES, e.plane) && str(e.start) && str(e.end)
      && Array.isArray(e.shapes) && e.shapes.every(shapeOk));
}

// Selbstprüfung beim Start (nur Konsole)
{
  const throws = f => { try { f(); return false; } catch { return true; } };
  console.assert(evaluate('Breite - 2*Rahmen', { Breite: '1010', Rahmen: '60' }) === 890, 'Formel falsch ausgewertet');
  console.assert(evaluate('2,5 * 2', {}) === 5, 'Dezimalkomma');
  console.assert(throws(() => evaluate('alert(1)', {})) && throws(() => evaluate('1;2', {})), 'Schadcode nicht abgelehnt');
  console.assert(throws(() => evaluate('a', { a: 'b', b: 'a' })), 'Zirkelbezug nicht erkannt');
  const frame = {
    plane: 'vorne', start: '0', end: '100',
    shapes: [{ type: 'rect', x: '0', y: '0', w: '500', h: '500' }, { type: 'rect', x: '50', y: '50', w: '400', h: '400' }],
  };
  console.assert(isClosed(buildGeometry(frame, {})), 'Rahmen mit Öffnung ist nicht dicht');
}

// --- Oberfläche ---

const $ = sel => document.querySelector(sel);
const viewEl = $('#view');
const STORE_KEY = 'revprint3d';

let doc = loadAutosave();
let selected = null;  // ausgewähltes Element im Modus „Ändern“
let sketch = null;    // { el, plane, start, end, shapes, tool, pts, cursor, typed, sel }
let view = 'vorne';
let controls;

function loadAutosave() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (validDoc(d)) return d;
  } catch { /* kein oder kaputter Autosave → leere Familie */ }
  return emptyDoc();
}

function setStatus(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}

// Szene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
viewEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
const sun = new THREE.DirectionalLight(0xffffff, 0.55);
camera.add(sun, sun.target);
sun.target.position.set(-0.3, -0.5, -1);
scene.add(camera, new THREE.AmbientLight(0xffffff, 0.6));
const refGroup = new THREE.Group(), modelGroup = new THREE.Group(), sketchGroup = new THREE.Group();
scene.add(refGroup, modelGroup, sketchGroup);

const MAT = new THREE.MeshLambertMaterial({ color: 0xd9d9d9, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const MAT_SEL = MAT.clone();
MAT_SEL.color.set(0x7fb8f0);
const EDGE = new THREE.LineBasicMaterial({ color: 0x000000 });

function clearGroup(g) {
  g.traverse(o => { if (o !== g) { o.geometry?.dispose(); if (o.material !== MAT && o.material !== MAT_SEL && o.material !== EDGE) o.material?.dispose(); } });
  g.clear();
}

function resize() {
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w, h);
  Object.assign(camera, { left: -w / 2 * MM_PER_PX, right: w / 2 * MM_PER_PX, top: h / 2 * MM_PER_PX, bottom: -h / 2 * MM_PER_PX });
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewEl);
resize();
renderer.setAnimationLoop(() => renderer.render(scene, camera));

const pxSize = () => (camera.right - camera.left) / camera.zoom / viewEl.clientWidth;

function setView(name, fit = true) {
  view = name;
  controls?.dispose();
  // OrbitControls merkt sich camera.up beim Erzeugen, daher pro Ansicht neu anlegen.
  camera.up.set(...(name === 'grundriss' ? [0, 1, 0] : [0, 0, 1]));
  const dir = name === '3d' ? new THREE.Vector3(1, -1, 0.8).normalize() : basis(name).w;
  const target = controls ? controls.target.clone() : new THREE.Vector3();
  camera.position.copy(target).addScaledVector(dir, 10000);
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableRotate = name === '3d';
  controls.mouseButtons = { LEFT: name === '3d' ? THREE.MOUSE.ROTATE : -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
  controls.update();
  if (fit) zoomFit();
  drawRefPlanes();
  drawSketch();
  $('#view-title').textContent = name === '3d' ? '3D-Ansicht: {3D}' : PLANES[name].label;
  document.querySelectorAll('#browser li[data-view]').forEach(li => li.classList.toggle('active', li.dataset.view === name));
}

function zoomFit() {
  const box = new THREE.Box3().setFromObject(modelGroup).union(new THREE.Box3().setFromObject(sketchGroup));
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2000, 2000, 2000));
  const center = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 100);
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, 10000);
  camera.zoom = Math.min(camera.right - camera.left, camera.top - camera.bottom) / (2.4 * radius);
  camera.updateProjectionMatrix();
  controls.update();
}

// Grüne Mittelebenen (Links/Rechts, Vorne/Hinten) und die Ebene Referenzebene, in jeder 2D-Ansicht als Strichlinie
function drawRefPlanes() {
  clearGroup(refGroup);
  if (view === '3d') return;
  const { w } = basis(view);
  for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => new THREE.Vector3(...a))) {
    if (Math.abs(n.dot(w)) > 0.5) continue;
    const d = new THREE.Vector3().crossVectors(w, n).multiplyScalar(1e5);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([d.clone().negate(), d]),
      new THREE.LineDashedMaterial({ color: 0x2e9b57, dashSize: 60, gapSize: 30 }));
    line.computeLineDistances();
    refGroup.add(line);
  }
}

function rebuildModel() {
  clearGroup(modelGroup);
  const errors = [];
  for (const el of doc.elements) {
    if (sketch?.el === el) continue;
    let geo;
    try { geo = buildGeometry(el, doc.params); } catch (e) { errors.push(e.message); continue; }
    const mesh = new THREE.Mesh(geo, el === selected ? MAT_SEL : MAT);
    mesh.userData.el = el;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), EDGE));
    modelGroup.add(mesh);
  }
  if (errors.length) setStatus(`Fehler: ${errors[0]}`, true);
}

function commit() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(doc)); } catch { setStatus('Automatisches Speichern nicht möglich – bitte „Speichern unter“ verwenden.', true); }
  rebuildModel();
  renderProps();
}

// --- Skizzenmodus ---

function sketchLoops() {
  return sketch.shapes.map(s => { try { return loopPoints(s, doc.params); } catch { return null; } });
}

function snapCursor(raw) {
  const ends = [...sketchLoops().flat().filter(Boolean), ...sketch.pts];
  const tol = 10 * pxSize();
  const hit = ends.find(p => Math.hypot(p[0] - raw[0], p[1] - raw[1]) < tol);
  if (hit) return { p: hit, end: true };
  const last = sketch.pts.at(-1);
  if (sketch.tool === 'line' && last) {
    // Winkelfang in 15°-Schritten, Länge auf das Raster
    const dx = raw[0] - last[0], dy = raw[1] - last[1], a = Math.atan2(dy, dx);
    const step = Math.PI / 12, as = Math.round(a / step) * step;
    if (Math.abs(a - as) < Math.PI / 60) {
      const len = Math.round(Math.hypot(dx, dy) / GRID) * GRID;
      return { p: [last[0] + len * Math.cos(as), last[1] + len * Math.sin(as)].map(c => Math.round(c * 10) / 10) };
    }
  }
  return { p: raw.map(c => Math.round(c / GRID) * GRID) };
}

function drawSketch() {
  clearGroup(sketchGroup);
  if (!sketch) return;
  const { u, v } = basis(sketch.plane);
  const add = (pts, closed, color) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => u.clone().multiplyScalar(p[0]).addScaledVector(v, p[1])));
    const line = new (closed ? THREE.LineLoop : THREE.Line)(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 10;
    sketchGroup.add(line);
  };
  sketchLoops().forEach((l, i) => l && add(l, true, i === sketch.sel ? 0x1e78d2 : 0xcc00cc));
  const c = sketch.cursor;
  if (view !== sketch.plane || !c) return;
  if (sketch.tool === 'line' && sketch.pts.length) add([...sketch.pts, c.p], false, 0xcc00cc);
  if (sketch.tool === 'rect' && sketch.pts.length) {
    const [a] = sketch.pts;
    add([a, [c.p[0], a[1]], c.p, [a[0], c.p[1]]], true, 0xcc00cc);
  }
  if (c.end) {
    const s = 5 * pxSize();
    add([[c.p[0] - s, c.p[1] - s], [c.p[0] + s, c.p[1] - s], [c.p[0] + s, c.p[1] + s], [c.p[0] - s, c.p[1] + s]], true, 0x1e78d2);
  }
}

function startSketch(el) {
  const plane = el ? el.plane : view;
  if (plane === '3d') {
    setStatus('Bitte zuerst im Projektbrowser eine Ansicht wählen (Referenzebene, Vorne oder Rechts) – dort liegt die Arbeitsebene.', true);
    return;
  }
  sketch = {
    el, plane, start: el ? el.start : '0', end: el ? el.end : '250',
    shapes: el ? structuredClone(el.shapes) : [], tool: 'rect', pts: [], cursor: null, typed: '', sel: null,
  };
  selected = null;
  if (view !== plane) setView(plane, false);
  setStatus('Skizze: Rechteck oder Linien zeichnen (innere Konturen werden zu Öffnungen), dann ✔ Bearbeitungsmodus beenden.');
  updateRibbon();
  rebuildModel();
  drawSketch();
  renderProps();
}

function endSketch(el) {
  sketch = null;
  selected = el;
  updateRibbon();
  $('#typed').hidden = true;
  drawSketch();
  commit();
}

function finishSketch() {
  if (sketch.tool === 'line' && sketch.pts.length) return setStatus('Linien müssen eine geschlossene Schleife bilden. Zum Schließen auf den Startpunkt klicken.', true);
  if (!sketch.shapes.length) return setStatus('Die Skizze ist leer. Zeichnen Sie mindestens ein Rechteck oder eine geschlossene Linie.', true);
  const el = sketch.el ?? { plane: sketch.plane };
  const next = { ...el, start: sketch.start, end: sketch.end, shapes: sketch.shapes };
  try { buildGeometry(next, doc.params); } catch (e) { return setStatus(`Fehler: ${e.message}`, true); }
  Object.assign(el, next);
  if (!sketch.el) doc.elements.push(el);
  setStatus('Extrusion erstellt. Doppelklick auf einen Körper bearbeitet seine Skizze.');
  endSketch(el);
}

function sketchClick() {
  const c = sketch.cursor?.p;
  if (!c) return;
  const pts = sketch.pts;
  if (sketch.tool === 'rect') {
    if (!pts.length) return pts.push(c);
    const [a] = pts.splice(0);
    if (a[0] === c[0] || a[1] === c[1]) return;
    sketch.shapes.push({ type: 'rect', x: fmt(Math.min(a[0], c[0])), y: fmt(Math.min(a[1], c[1])), w: fmt(Math.abs(c[0] - a[0])), h: fmt(Math.abs(c[1] - a[1])) });
  } else if (sketch.tool === 'line') {
    addLinePoint(c);
  } else {
    const tol = 8 * pxSize();
    sketch.sel = sketchLoops().findIndex(l => l && l.some((p, i) => segDist(c, p, l[(i + 1) % l.length]) < tol));
    if (sketch.sel < 0) sketch.sel = null;
    renderProps();
  }
  drawSketch();
}

function addLinePoint(c) {
  const pts = sketch.pts, first = pts[0], last = pts.at(-1);
  if (last && last[0] === c[0] && last[1] === c[1]) return;
  if (pts.length >= 3 && first[0] === c[0] && first[1] === c[1]) {
    sketch.shapes.push({ type: 'poly', pts: pts.splice(0).map(p => p.map(fmt)) });
    return;
  }
  pts.push(c);
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function setTool(tool) {
  sketch.tool = tool;
  sketch.pts = [];
  sketch.typed = '';
  $('#typed').hidden = true;
  updateRibbon();
  drawSketch();
}

// --- Maus und Tastatur ---

const raycaster = new THREE.Raycaster();
function pointerNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
}
function planePoint(e) {
  raycaster.setFromCamera(pointerNdc(e), camera);
  const { u, v, w } = basis(view);
  const p = raycaster.ray.intersectPlane(new THREE.Plane(w, 0), new THREE.Vector3());
  return p && [p.dot(u), p.dot(v)];
}
function pickElement(e) {
  raycaster.setFromCamera(pointerNdc(e), camera);
  return raycaster.intersectObjects(modelGroup.children, false)[0]?.object.userData.el ?? null;
}

const canvas = renderer.domElement;
let downAt = null;
// Revit: Umschalt + mittlere Maustaste dreht die 3D-Ansicht. Muss vor OrbitControls laufen, daher capture.
canvas.addEventListener('pointerdown', e => {
  downAt = [e.clientX, e.clientY];
  controls.mouseButtons.MIDDLE = view === '3d' && e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
}, true);

canvas.addEventListener('pointermove', e => {
  if (!sketch || view !== sketch.plane || sketch.tool === 'select') return;
  const raw = planePoint(e);
  if (!raw) return;
  sketch.cursor = snapCursor(raw);
  const typed = $('#typed');
  typed.style.left = `${e.offsetX + 14}px`;
  typed.style.top = `${e.offsetY + 14}px`;
  drawSketch();
});

canvas.addEventListener('click', e => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // war ein Ziehen
  if (sketch) {
    if (view !== sketch.plane) return setStatus(`Die Skizze liegt in „${PLANES[sketch.plane].label}“ – bitte dort zeichnen.`, true);
    if (sketch.tool === 'select') sketch.cursor = { p: planePoint(e) };
    return sketchClick();
  }
  selected = pickElement(e);
  rebuildModel();
  renderProps();
});

canvas.addEventListener('dblclick', e => {
  if (sketch) return;
  const el = pickElement(e);
  if (el) startSketch(el);
});

canvas.addEventListener('auxclick', e => { if (e.button === 1 && e.detail === 2) zoomFit(); });

window.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  const typedEl = $('#typed');
  if (sketch?.tool === 'line' && sketch.pts.length && /^[\d.,]$/.test(e.key)) {
    // Revit-Gewohnheit: Länge eintippen, Enter setzt den Punkt in Mausrichtung
    sketch.typed += e.key;
  } else if (sketch?.typed && e.key === 'Backspace') {
    sketch.typed = sketch.typed.slice(0, -1);
  } else if (sketch?.typed && e.key === 'Enter') {
    const len = Number(sketch.typed.replace(',', '.'));
    const last = sketch.pts.at(-1), c = sketch.cursor?.p ?? [last[0] + 1, last[1]];
    const d = Math.hypot(c[0] - last[0], c[1] - last[1]) || 1;
    sketch.typed = '';
    if (len > 0) addLinePoint([last[0] + (c[0] - last[0]) / d * len, last[1] + (c[1] - last[1]) / d * len].map(x => Math.round(x * 10) / 10));
  } else if (e.key === 'Escape') {
    if (sketch?.pts.length) { sketch.pts = []; sketch.typed = ''; }
    else if (sketch && sketch.tool !== 'select') setTool('select');
    else if (sketch) { sketch.sel = null; renderProps(); }
    else { selected = null; rebuildModel(); renderProps(); }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (sketch && sketch.sel !== null) { sketch.shapes.splice(sketch.sel, 1); sketch.sel = null; renderProps(); }
    else if (!sketch && selected) { doc.elements.splice(doc.elements.indexOf(selected), 1); selected = null; commit(); }
  } else return;
  e.preventDefault();
  typedEl.hidden = !sketch?.typed;
  typedEl.textContent = sketch?.typed ?? '';
  drawSketch();
});

// --- Eigenschaften ---

function renderProps() {
  const box = $('#props');
  box.replaceChildren();
  const table = document.createElement('table');
  const head = text => { const tr = table.insertRow(); const th = document.createElement('th'); th.colSpan = 2; th.textContent = text; tr.append(th); };
  const row = (label, value, onSet, check = v => evaluate(v, doc.params)) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    const input = document.createElement('input');
    input.value = value;
    if (!onSet) input.readOnly = true;
    else input.addEventListener('change', () => {
      try { check(input.value); } catch (err) {
        input.classList.add('error');
        return setStatus(`${label}: ${err.message}`, true);
      }
      input.classList.remove('error');
      onSet(input.value.trim());
      setStatus('Bereit');
    });
    tr.insertCell().append(input);
  };
  const button = (text, onClick) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', onClick);
    actions.append(b);
  };
  const actions = document.createElement('div');
  actions.className = 'actions';
  box.append(table, actions);

  if (sketch) {
    const shape = sketch.shapes[sketch.sel];
    if (shape?.type === 'rect') {
      head('Skizze: Rechteck');
      [['x', 'X (links)'], ['y', 'Y (unten)'], ['w', 'Breite'], ['h', 'Höhe']].forEach(([k, label]) =>
        row(label, shape[k], v => { shape[k] = v; drawSketch(); }));
    } else if (shape) {
      head('Skizze: Linien');
      shape.pts.forEach((p, i) => [0, 1].forEach(j =>
        row(`Punkt ${i + 1} ${'XY'[j]}`, p[j], v => { p[j] = v; drawSketch(); })));
    }
    head('Extrusion');
    row('Extrusionsanfang', sketch.start, v => { sketch.start = v; });
    row('Extrusionsende', sketch.end, v => { sketch.end = v; });
    row('Arbeitsebene', PLANES[sketch.plane].label);
    if (shape) button('Kontur löschen', () => { sketch.shapes.splice(sketch.sel, 1); sketch.sel = null; renderProps(); drawSketch(); });
    else box.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Mit „Ändern“ eine Kontur anklicken, um ihre Maße als Zahl oder Formel einzugeben.' }));
  } else if (selected) {
    const el = selected;
    head('Extrusion');
    row('Extrusionsanfang', el.start, v => { el.start = v; commit(); });
    row('Extrusionsende', el.end, v => { el.end = v; commit(); });
    row('Arbeitsebene', PLANES[el.plane].label);
    button('Extrusion bearbeiten', () => startSketch(el));
    button('Löschen', () => { doc.elements.splice(doc.elements.indexOf(el), 1); selected = null; commit(); });
  } else {
    head('Familie');
    row('Familienname', doc.name, v => { doc.name = v || 'Familie1'; commit(); }, () => {});
    head('Parameter');
    for (const [name, expr] of Object.entries(doc.params)) {
      let value;
      try { value = fmt(evaluate(expr, doc.params)); } catch { value = '⚠'; }
      row(name, value);
    }
    button('Familientypen …', openTypes);
  }
}

// --- Familientypen ---

const typesDialog = $('#types-dialog'), typesBody = $('#types-body');

function typeRow(name = '', expr = '') {
  const tr = typesBody.insertRow();
  tr.innerHTML = '<td><input class="pname"></td><td><input class="pexpr"></td><td class="result"></td><td><button type="button" title="Parameter löschen">✕</button></td>';
  tr.querySelector('.pname').value = name;
  tr.querySelector('.pexpr').value = expr;
  tr.querySelector('button').addEventListener('click', () => { tr.remove(); checkTypes(); });
}

const readTypes = () => [...typesBody.rows].map(r => [r.querySelector('.pname').value.trim(), r.querySelector('.pexpr').value.trim()]);

function checkTypes() {
  const rows = readTypes(), params = Object.fromEntries(rows);
  let ok = true;
  rows.forEach(([name, expr], i) => {
    const cell = typesBody.rows[i].cells[2];
    let msg = '';
    if (!NAME_RE.test(name)) msg = 'Name ungültig (keine Leerzeichen, nicht mit Ziffer beginnen)';
    else if (rows.findIndex(r => r[0] === name) !== i) msg = 'Name doppelt';
    else try { cell.textContent = fmt(evaluate(expr, params)); } catch (e) { msg = e.message; }
    if (msg) { cell.textContent = '⚠'; ok = false; }
    cell.title = msg;
    cell.classList.toggle('error', !!msg);
  });
  return ok;
}

function openTypes() {
  typesBody.replaceChildren();
  Object.entries(doc.params).forEach(([n, x]) => typeRow(n, x));
  checkTypes();
  typesDialog.showModal();
}

typesBody.addEventListener('input', checkTypes);
$('#types-add').addEventListener('click', () => { typeRow(); checkTypes(); typesBody.rows[typesBody.rows.length - 1].querySelector('input').focus(); });
typesDialog.querySelector('form').addEventListener('submit', e => {
  if (!checkTypes()) {
    e.preventDefault();
    setStatus('Familientypen: bitte die mit ⚠ markierten Zeilen korrigieren (Maus darüber zeigt den Grund).', true);
    return;
  }
  doc.params = Object.fromEntries(readTypes());
  setStatus('Bereit');
  commit();
  drawSketch();
});

// --- Datei ---

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileName = () => doc.name.replace(/[^\wÄÖÜäöüß-]+/g, '_') || 'Familie';

function exportStl() {
  if (sketch) return setStatus('Bitte zuerst den Bearbeitungsmodus beenden (✔).', true);
  const scale = Number($('#scale').value);
  const group = new THREE.Group();
  let open = 0;
  for (const el of doc.elements) {
    let geo;
    try { geo = buildGeometry(el, doc.params); } catch (e) { return setStatus(`Export abgebrochen: ${e.message}`, true); }
    if (!isClosed(geo)) open++;
    group.add(new THREE.Mesh(geo));
  }
  if (!group.children.length) return setStatus('Nichts zu exportieren – zuerst eine Extrusion erstellen.', true);
  group.scale.setScalar(1 / scale);
  group.updateMatrixWorld(true);
  // Überlappende Körper bleiben getrennt; Slicer vereinen sie beim Import.
  download(new Blob([new THREE.STLExporter().parse(group, { binary: true })], { type: 'model/stl' }), `${fileName()}_1-${scale}.stl`);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  const mm = n => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  const notes = [];
  if (Math.max(size.x, size.y, size.z) > 250) notes.push('größer als ein übliches Druckbett (ca. 250 mm) – kleineren Maßstab wählen');
  if (open) notes.push(`${open} Körper nicht dicht`);
  setStatus(`STL exportiert (1:${scale}): ${mm(size.x)} × ${mm(size.y)} × ${mm(size.z)} mm${notes.length ? ' – Achtung: ' + notes.join(', ') : ''}`, notes.length > 0);
  group.children.forEach(m => m.geometry.dispose());
}

const fileInput = $('#file-input');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch { d = null; }
  if (!validDoc(d)) return setStatus(`„${file.name}“ ist keine RevPrint3D-Familie.`, true);
  doc = d;
  sketch = null;
  selected = null;
  updateRibbon();
  drawSketch();
  commit();
  zoomFit();
  setStatus(`„${file.name}“ geöffnet.`);
});

// --- Multifunktionsleiste ---

const commands = {
  new() {
    if (!confirm('Neue Familie beginnen? Die aktuelle Familie wird verworfen (vorher „Speichern unter“ verwenden).')) return;
    doc = emptyDoc();
    sketch = null;
    selected = null;
    updateRibbon();
    drawSketch();
    commit();
    setStatus('Neue Familie. Ansicht wählen, dann „Extrusion“.');
  },
  open: () => fileInput.click(),
  save: () => download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `${fileName()}.rp3d.json`),
  modify() { selected = null; rebuildModel(); renderProps(); },
  extrusion: () => startSketch(null),
  types: openTypes,
  stl: exportStl,
  'sk-select': () => setTool('select'),
  'sk-line': () => setTool('line'),
  'sk-rect': () => setTool('rect'),
  'sk-finish': finishSketch,
  'sk-cancel': () => { setStatus('Skizze verworfen.'); endSketch(sketch.el); },
};

function updateRibbon() {
  for (const id of ['grp-draw', 'grp-mode']) $(`#${id}`).hidden = !sketch;
  for (const id of ['grp-modify', 'grp-create', 'grp-props', 'grp-export']) $(`#${id}`).hidden = !!sketch;
  document.querySelectorAll('#grp-draw button').forEach(b => b.classList.toggle('active', b.dataset.cmd === `sk-${sketch?.tool}`));
}

document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => commands[b.dataset.cmd]()));
document.querySelectorAll('#browser li[data-view]').forEach(li => li.addEventListener('click', () => setView(li.dataset.view, !sketch)));
$('#zoom-fit').addEventListener('click', zoomFit);

rebuildModel();
renderProps();
setView('vorne');
