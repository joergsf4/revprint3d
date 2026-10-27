'use strict';
// RevPrint3D – Familieneditor nach Revit-Vorbild. Modell in mm, Z zeigt nach oben (wie Revit und Slicer).
// shortcut: three 0.147 because of classic scripts for file://, upgrade when moving to a local server/hosting

const GRID = 10;      // Fangraster in mm
const MM_PER_PX = 4;  // Maßstab der Ansicht bei Zoom 1
const SEGMENTS = 64;  // Kreise und Rotationen werden in so viele Teile zerlegt
const FORMS = { extrusion: 'Extrusion', blend: 'Verschmelzung', rotation: 'Rotation', sweep: 'Sweep' };
const SECOND = { blend: 'top', sweep: 'path' }; // Formen mit zweiter Skizze: Oberseite bzw. Pfad
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
  const ev = k => evaluate(shape[k], params);
  if (shape.type === 'rect') {
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(ev);
    if (!w || !h) throw new Error('Rechteck mit Breite oder Höhe 0');
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  if (shape.type === 'circle' || shape.type === 'ngon') {
    const x = ev('x'), y = ev('y'), r = ev('r'), n = shape.type === 'circle' ? SEGMENTS : Math.round(ev('n'));
    if (r <= 0) throw new Error('Radius muss größer als 0 sein');
    if (n < 3 || n > 100) throw new Error('Ein Vieleck braucht 3 bis 100 Ecken');
    // Unterkante waagerecht, damit Vielecke flach aufs Druckbett passen
    const a0 = -Math.PI / 2 + Math.PI / n;
    return Array.from({ length: n }, (_, i) => [x + r * Math.cos(a0 + 2 * Math.PI * i / n), y + r * Math.sin(a0 + 2 * Math.PI * i / n)]);
  }
  return shape.pts.map(p => p.map(c => evaluate(c, params)));
}

const vec2 = l => l.map(p => new THREE.Vector2(...p));
const ccw = l => THREE.ShapeUtils.isClockWise(vec2(l)) ? [...l].reverse() : l;

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
const nesting = loops => loops.map((l, i) => loops.filter((o, j) => j !== i && inside(l[0], o)).length);

// Flächen mit ihren Öffnungen; Außenkontur gegen, Öffnungen im Uhrzeigersinn.
function regions(loops) {
  const depth = nesting(loops);
  return loops.flatMap((l, i) => depth[i] % 2 ? [] : [{
    contour: ccw(l),
    holes: loops.filter((h, j) => depth[j] === depth[i] + 1 && inside(h[0], l)).map(h => [...ccw(h)].reverse()),
  }]);
}

function toShapes(loops) {
  return regions(loops).map(({ contour, holes }) => {
    const shape = new THREE.Shape(vec2(contour));
    shape.holes = holes.map(h => new THREE.Path(vec2(h)));
    return shape;
  });
}

// Dreiecke einer Fläche, alle gegen den Uhrzeigersinn
function capTriangles(contour, holes = []) {
  const all = [...contour, ...holes.flat()];
  return THREE.ShapeUtils.triangulateShape(vec2(contour), holes.map(vec2)).map(([i, j, k]) => {
    const [p, q, r] = [all[i], all[j], all[k]];
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0 ? [p, q, r] : [p, r, q];
  });
}

function positionsGeometry(pos) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// Sweep: Profil (X seitlich zum Pfad, Y senkrecht zur Skizzenebene) wird entlang des Pfads geführt, an Ecken auf Gehrung.
function sweep(profile, path, closed) {
  path = path.filter((p, i) => Math.hypot(p[0] - path[(i + 1) % path.length][0], p[1] - path[(i + 1) % path.length][1]) > 1e-6 || (!closed && i === path.length - 1));
  const n = path.length, segs = closed ? n : n - 1;
  if (n < 2) throw new Error('Sweep: Der Pfad braucht mindestens zwei Punkte');
  const normal = i => {
    const p = path[i], q = path[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [(q[1] - p[1]) / l, -(q[0] - p[0]) / l];
  };
  const frames = path.map((o, k) => {
    const nIn = closed || k > 0 ? normal((k - 1 + n) % n) : null, nOut = closed || k < n - 1 ? normal(k) : null;
    const a = nIn ?? nOut, b = nOut ?? nIn, m = [a[0] + b[0], a[1] + b[1]], ml = Math.hypot(...m);
    if (ml < 1e-9) throw new Error('Sweep: Der Pfad läuft in sich zurück');
    const s = 1 / ((m[0] * b[0] + m[1] * b[1]) / ml);
    return ([x, y]) => [o[0] + m[0] / ml * x * s, o[1] + m[1] / ml * x * s, y];
  });
  const pos = [];
  const tri = (...ps) => ps.forEach(p => pos.push(...p));
  for (const { contour, holes } of regions(profile)) {
    for (const ring of [contour, ...holes]) {
      for (let k = 0; k < segs; k++) {
        const f = frames[k], g = frames[(k + 1) % n];
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length], A = f(p), B = f(q), C = g(q), D = g(p);
          tri(A, C, B);
          tri(A, D, C);
        });
      }
    }
    if (!closed) for (const [p, q, r] of capTriangles(contour, holes)) {
      tri(frames[0](p), frames[0](q), frames[0](r));
      tri(frames[n - 1](p), frames[n - 1](r), frames[n - 1](q));
    }
  }
  return positionsGeometry(pos);
}

// Rotation um die senkrechte Referenzebene der Ansicht (v-Achse), immer volle 360°.
function revolve(loops) {
  const us = loops.flat().map(p => p[0]);
  if (Math.min(...us) < 0 && Math.max(...us) > 0) throw new Error('Rotation: Die Skizze muss ganz auf einer Seite der Achse (senkrechte grüne Referenzebene) liegen');
  const depth = nesting(loops);
  const geos = loops.map((l, i) => {
    const pts = ccw(l.map(([u, v]) => [Math.abs(u), v]));
    if (depth[i] % 2) pts.reverse(); // Öffnungen andersherum als die Außenkontur, damit alle Flächen nach außen zeigen
    return new THREE.LatheGeometry(vec2([...pts, pts[0]]), SEGMENTS);
  });
  return geos.length === 1 ? geos[0] : merge(geos);
}

function merge(geos) {
  const arrays = geos.map(g => (g.index ? g.toNonIndexed() : g).attributes.position.array);
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  arrays.reduce((offset, a) => { out.set(a, offset); return offset + a.length; }, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.computeVertexNormals();
  return geo;
}

// Kontur so drehen, dass sie rechts neben dem Schwerpunkt beginnt – so verbindet die Verschmelzung passende Stellen.
function startRight(l) {
  const c = l.reduce((s, p) => [s[0] + p[0] / l.length, s[1] + p[1] / l.length], [0, 0]);
  let best = null;
  l.forEach((p, i) => {
    const q = l[(i + 1) % l.length];
    if ((p[1] > c[1]) === (q[1] > c[1])) return;
    const u = p[0] + (c[1] - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
    if (u > c[0] && (!best || u < best.u)) best = { u, i };
  });
  const r = best ? [[best.u, c[1]], ...l.slice(best.i + 1), ...l.slice(0, best.i + 1)] : l;
  return r.filter((p, i) => Math.hypot(p[0] - r[(i + 1) % r.length][0], p[1] - r[(i + 1) % r.length][1]) > 1e-6);
}

// Anteil am Umfang für jeden Eckpunkt (0 … <1)
function perimeterParams(l) {
  const len = l.map((p, i) => Math.hypot(l[(i + 1) % l.length][0] - p[0], l[(i + 1) % l.length][1] - p[1]));
  const total = len.reduce((a, b) => a + b);
  let acc = 0;
  return len.map(d => { const t = acc / total; acc += d; return t; });
}

function pointAt(l, ts, t) {
  let i = ts.length - 1;
  while (ts[i] > t) i--;
  const p = l[i], q = l[(i + 1) % l.length], t1 = i + 1 < ts.length ? ts[i + 1] : 1;
  const f = (t - ts[i]) / (t1 - ts[i]);
  return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
}

// Verschmelzung: Basis und Oberseite werden an gleichen Umfangsanteilen verbunden; beide behalten ihre Ecken.
function blend(base, top, start, end) {
  if (base.length !== 1 || top.length !== 1) throw new Error('Verschmelzung: Basis und Oberseite brauchen je genau eine geschlossene Kontur');
  if (start > end) [start, end, base, top] = [end, start, top, base];
  const A = startRight(ccw(base[0])), B = startRight(ccw(top[0]));
  const tA = perimeterParams(A), tB = perimeterParams(B);
  const ts = [...new Set([...tA, ...tB].map(t => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
  const a = ts.map(t => pointAt(A, tA, t)), b = ts.map(t => pointAt(B, tB, t));
  const pos = [];
  const tri = (p, q, r) => pos.push(...p, ...q, ...r);
  const lo = p => [p[0], p[1], start], hi = p => [p[0], p[1], end];
  a.forEach((_, i) => {
    const j = (i + 1) % a.length;
    tri(lo(a[i]), lo(a[j]), hi(b[j]));
    tri(lo(a[i]), hi(b[j]), hi(b[i]));
  });
  for (const [p, q, r] of capTriangles(a)) tri([...p, start], [...r, start], [...q, start]);
  for (const [p, q, r] of capTriangles(b)) tri([...p, end], [...q, end], [...r, end]);
  return positionsGeometry(pos);
}

function buildGeometry(el, params) {
  const loops = el.shapes.map(s => loopPoints(s, params));
  let geo;
  if (el.form === 'rotation') geo = revolve(loops);
  else if (el.form === 'sweep') {
    if (el.path.length !== 1) throw new Error('Sweep: Der Pfad muss genau eine Linie oder Kontur sein');
    geo = sweep(loops, loopPoints(el.path[0], params), el.path[0].type !== 'path');
  } else {
    const start = evaluate(el.start, params), end = evaluate(el.end, params);
    if (start === end) throw new Error('Anfang und Ende sind gleich');
    if (el.form === 'blend') geo = blend(loops, el.top.map(s => loopPoints(s, params)), start, end);
    else {
      geo = new THREE.ExtrudeGeometry(toShapes(loops), { depth: Math.abs(end - start), bevelEnabled: false });
      geo.translate(0, 0, Math.min(start, end));
    }
  }
  const { u, v, w } = basis(el.plane);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, w));
  return geo;
}

// Druckbar heißt dicht: jede Kante gehört zu genau zwei Dreiecken.
function isClosed(geo) {
  const p = geo.attributes.position, idx = geo.index, n = idx ? idx.count : p.count;
  const key = i => [p.getX(i), p.getY(i), p.getZ(i)].map(c => Math.round(c * 1000) / 1000 + 0).join(); // + 0 macht aus -0 eine 0
  const edges = new Map();
  for (let t = 0; t < n; t += 3) {
    const k = [0, 1, 2].map(j => key(idx ? idx.getX(t + j) : t + j));
    if (new Set(k).size < 3) continue; // flaches Dreieck, z. B. auf der Rotationsachse
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
  const keys = { rect: ['x', 'y', 'w', 'h'], circle: ['x', 'y', 'r'], ngon: ['x', 'y', 'r', 'n'] };
  const shapeOk = s => s && (Object.hasOwn(keys, s.type)
    ? keys[s.type].every(k => str(s[k]))
    : (s.type === 'poly' || s.type === 'path') && Array.isArray(s.pts) && s.pts.length >= (s.type === 'path' ? 2 : 3)
      && s.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(str)));
  const shapesOk = a => Array.isArray(a) && a.every(shapeOk);
  return !!d && str(d.name) && !!d.params && typeof d.params === 'object'
    && Object.entries(d.params).every(([k, v]) => NAME_RE.test(k) && str(v))
    && Array.isArray(d.elements)
    && d.elements.every(e => e && Object.hasOwn(PLANES, e.plane) && str(e.start) && str(e.end)
      && (e.form === undefined || Object.hasOwn(FORMS, e.form)) && shapesOk(e.shapes)
      && (!SECOND[e.form] || shapesOk(e[SECOND[e.form]])));
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
  const vase = { form: 'rotation', plane: 'vorne', start: '0', end: '0', shapes: [{ type: 'poly', pts: [['0', '0'], ['50', '0'], ['30', '100'], ['0', '100']] }] };
  console.assert(isClosed(buildGeometry(vase, {})), 'Rotation ist nicht dicht');
  const morph = { form: 'blend', plane: 'grundriss', start: '0', end: '80', shapes: [{ type: 'rect', x: '-40', y: '-40', w: '80', h: '80' }], top: [{ type: 'circle', x: '0', y: '0', r: '25' }] };
  console.assert(isClosed(buildGeometry(morph, {})), 'Verschmelzung ist nicht dicht');
  const rail = { form: 'sweep', plane: 'grundriss', start: '0', end: '0', shapes: [{ type: 'rect', x: '-5', y: '0', w: '10', h: '20' }], path: [{ type: 'path', pts: [['0', '0'], ['100', '0'], ['100', '80']] }] };
  console.assert(isClosed(buildGeometry(rail, {})), 'Sweep ist nicht dicht');
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

const MAT = new THREE.MeshPhongMaterial({ color: 0xd9d9d9, flatShading: true, shininess: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
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

// Verschmelzung und Sweep haben eine zweite Skizze (Oberseite bzw. Pfad); editTop schaltet zwischen beiden um.
const current = () => sketch.editTop ? sketch.second : sketch.shapes;
const drawingPath = () => sketch.form === 'sweep' && sketch.editTop;
const loopsOf = shapes => shapes.map(s => { try { return loopPoints(s, doc.params); } catch { return null; } });

function snapCursor(raw) {
  // Fangpunkte: Ecken und Kreismittelpunkte von Basis und Oberseite
  const ends = [...sketch.shapes, ...sketch.second].flatMap(s => {
    try { return s.type === 'circle' ? [[evaluate(s.x, doc.params), evaluate(s.y, doc.params)]] : loopPoints(s, doc.params); } catch { return []; }
  }).concat(sketch.pts);
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

// Rechteck: Ecke zu Ecke. Kreis und Vieleck: Mittelpunkt zu Radius.
function newShape(a, c) {
  if (sketch.tool === 'rect') {
    if (a[0] === c[0] || a[1] === c[1]) return null;
    return { type: 'rect', x: fmt(Math.min(a[0], c[0])), y: fmt(Math.min(a[1], c[1])), w: fmt(Math.abs(c[0] - a[0])), h: fmt(Math.abs(c[1] - a[1])) };
  }
  const r = Math.hypot(c[0] - a[0], c[1] - a[1]);
  if (!r) return null;
  return { type: sketch.tool, x: fmt(a[0]), y: fmt(a[1]), r: fmt(r), ...(sketch.tool === 'ngon' ? { n: '6' } : {}) };
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
  const other = sketch.editTop ? sketch.shapes : sketch.second;
  loopsOf(other).forEach((l, i) => l && add(l, other[i].type !== 'path', 0xaaaaaa));
  loopsOf(current()).forEach((l, i) => l && add(l, current()[i].type !== 'path', i === sketch.sel ? 0x1e78d2 : 0xcc00cc));
  const c = sketch.cursor;
  if (view !== sketch.plane || !c) return;
  if (sketch.tool === 'line' && sketch.pts.length) add([...sketch.pts, c.p], false, 0xcc00cc);
  else if (sketch.tool !== 'select' && sketch.pts.length) {
    const s = newShape(sketch.pts[0], c.p);
    if (s) add(loopPoints(s, {}), true, 0xcc00cc);
  }
  if (c.end) {
    const s = 5 * pxSize();
    add([[c.p[0] - s, c.p[1] - s], [c.p[0] + s, c.p[1] - s], [c.p[0] + s, c.p[1] + s], [c.p[0] - s, c.p[1] + s]], true, 0x1e78d2);
  }
}

const HINTS = {
  extrusion: 'Extrusion: Konturen zeichnen (innere Konturen werden zu Öffnungen), dann ✔ Bearbeitungsmodus beenden.',
  blend: 'Verschmelzung: erst die Basis skizzieren, dann „Oben bearbeiten“ und die obere Kontur skizzieren, dann ✔.',
  rotation: 'Rotation: Profil auf einer Seite der senkrechten grünen Referenzebene zeichnen – um diese Achse wird gedreht. Dann ✔.',
  sweep: 'Sweep: erst den Pfad zeichnen (Linie offen oder geschlossen, auch Rechteck/Kreis), dann „Profil bearbeiten“.',
};
const PROFILE_HINT = 'Sweep-Profil: Querschnitt um den Kreuzungspunkt der grünen Referenzebenen zeichnen (X = seitlich zum Pfad, Y = Höhe), dann ✔.';

function startSketch(el, form = 'extrusion') {
  const plane = el ? el.plane : view;
  if (plane === '3d') {
    setStatus('Bitte zuerst im Projektbrowser eine Ansicht wählen (Referenzebene, Vorne oder Rechts) – dort liegt die Arbeitsebene.', true);
    return;
  }
  form = el?.form ?? form;
  sketch = {
    el, plane, form, start: el ? el.start : '0', end: el ? el.end : '250',
    shapes: structuredClone(el?.shapes ?? []), second: structuredClone(el?.[SECOND[form]] ?? []),
    editTop: form === 'sweep', // wie in Revit: beim Sweep zuerst den Pfad
    tool: form === 'sweep' ? 'line' : 'rect', pts: [], cursor: null, typed: '', sel: null,
  };
  selected = null;
  if (view !== plane) setView(plane, false);
  setStatus(HINTS[sketch.form]);
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

// Ein Sweep-Pfad darf offen bleiben: angefangene Linie wird beim Umschalten oder Beenden übernommen.
function endOpenPath() {
  if (drawingPath() && sketch.pts.length >= 2) sketch.second.push({ type: 'path', pts: sketch.pts.splice(0).map(p => p.map(fmt)) });
}

function finishSketch() {
  const { form } = sketch;
  endOpenPath();
  if (sketch.tool === 'line' && sketch.pts.length) return setStatus('Linien müssen eine geschlossene Schleife bilden. Zum Schließen auf den Startpunkt klicken.', true);
  if (form === 'sweep' && !sketch.second.length) return setStatus('Der Pfad ist leer. Mit „Pfad bearbeiten“ eine Linie zeichnen.', true);
  if (!sketch.shapes.length) return setStatus(form === 'sweep' ? 'Das Profil ist leer. Mit „Profil bearbeiten“ den Querschnitt zeichnen.' : `${form === 'blend' ? 'Die Basis' : 'Die Skizze'} ist leer. Zeichnen Sie mindestens eine geschlossene Kontur.`, true);
  if (form === 'blend' && !sketch.second.length) return setStatus('Die Oberseite ist leer. Mit „Oben bearbeiten“ die obere Kontur zeichnen.', true);
  const el = sketch.el ?? { plane: sketch.plane };
  const next = { ...el, form, start: sketch.start, end: sketch.end, shapes: sketch.shapes, ...(SECOND[form] ? { [SECOND[form]]: sketch.second } : {}) };
  try { buildGeometry(next, doc.params); } catch (e) { return setStatus(`Fehler: ${e.message}`, true); }
  Object.assign(el, next);
  if (!sketch.el) doc.elements.push(el);
  setStatus(`${FORMS[sketch.form]} erstellt. Doppelklick auf einen Körper bearbeitet seine Skizze.`);
  endSketch(el);
}

function sketchClick() {
  const c = sketch.cursor?.p;
  if (!c) return;
  const pts = sketch.pts;
  if (sketch.tool === 'line') addLinePoint(c);
  else if (sketch.tool === 'select') {
    const tol = 8 * pxSize();
    sketch.sel = loopsOf(current()).findIndex(l => l && l.some((p, i) => segDist(c, p, l[(i + 1) % l.length]) < tol));
    if (sketch.sel < 0) sketch.sel = null;
    renderProps();
  } else if (!pts.length) pts.push(c);
  else {
    const s = newShape(pts.splice(0)[0], c);
    if (s) current().push(s);
  }
  drawSketch();
}

function addLinePoint(c) {
  const pts = sketch.pts, first = pts[0], last = pts.at(-1);
  if (last && last[0] === c[0] && last[1] === c[1]) return;
  if (pts.length >= 3 && first[0] === c[0] && first[1] === c[1]) {
    current().push({ type: 'poly', pts: pts.splice(0).map(p => p.map(fmt)) });
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

function toggleTop() {
  endOpenPath();
  Object.assign(sketch, { editTop: !sketch.editTop, sel: null, pts: [] });
  if (sketch.form === 'sweep') setStatus(sketch.editTop ? HINTS.sweep : PROFILE_HINT);
  else setStatus(sketch.editTop ? 'Obere Kontur der Verschmelzung zeichnen (grau: Basis).' : 'Basis der Verschmelzung zeichnen (grau: Oberseite).');
  updateRibbon();
  drawSketch();
  renderProps();
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
const dragged = e => downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4;
const drawing = e => e.button === 0 && sketch && view === sketch.plane;

function sketchPointer(e) {
  const raw = planePoint(e);
  if (!raw) return;
  sketch.cursor = sketch.tool === 'select' ? { p: raw } : snapCursor(raw);
  sketchClick();
}

// Revit: Umschalt + mittlere Maustaste dreht die 3D-Ansicht. Muss vor OrbitControls laufen, daher capture.
canvas.addEventListener('pointerdown', e => {
  downAt = [e.clientX, e.clientY];
  controls.mouseButtons.MIDDLE = view === '3d' && e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  if (drawing(e)) sketchPointer(e);
}, true);

// Drücken, Ziehen, Loslassen zeichnet genauso wie Klick, Bewegen, Klick.
canvas.addEventListener('pointerup', e => {
  if (drawing(e) && dragged(e) && sketch.pts.length) sketchPointer(e);
});

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
  if (dragged(e)) return;
  if (sketch) {
    if (view !== sketch.plane) setStatus(`Die Skizze liegt in „${PLANES[sketch.plane].label}“ – bitte dort zeichnen.`, true);
    return;
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
  } else if (sketch && e.key === 'Enter' && drawingPath()) {
    endOpenPath();
  } else if (e.key === 'Escape') {
    if (sketch?.pts.length) { sketch.pts = []; sketch.typed = ''; }
    else if (sketch && sketch.tool !== 'select') setTool('select');
    else if (sketch) { sketch.sel = null; renderProps(); }
    else { selected = null; rebuildModel(); renderProps(); }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (sketch && sketch.sel !== null) { current().splice(sketch.sel, 1); sketch.sel = null; renderProps(); }
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

  // Anfang/Ende heißen je nach Form anders; Rotation und Sweep haben keine.
  const formRows = (form, obj, after) => {
    head(FORMS[form]);
    if (form === 'rotation') row('Achse', 'senkrechte Referenzebene');
    else if (form !== 'sweep') {
      const [a, b] = form === 'blend' ? ['Erstes Ende', 'Zweites Ende'] : ['Extrusionsanfang', 'Extrusionsende'];
      row(a, obj.start, v => { obj.start = v; after(); });
      row(b, obj.end, v => { obj.end = v; after(); });
    }
    row('Arbeitsebene', PLANES[obj.plane].label);
  };

  if (sketch) {
    const shape = current()[sketch.sel];
    const fields = {
      rect: ['Rechteck', [['x', 'X (links)'], ['y', 'Y (unten)'], ['w', 'Breite'], ['h', 'Höhe']]],
      circle: ['Kreis', [['x', 'Mitte X'], ['y', 'Mitte Y'], ['r', 'Radius']]],
      ngon: ['Vieleck', [['x', 'Mitte X'], ['y', 'Mitte Y'], ['r', 'Radius (bis Ecke)'], ['n', 'Anzahl Ecken']]],
    }[shape?.type];
    if (fields) {
      head(`Skizze: ${fields[0]}`);
      fields[1].forEach(([k, label]) => row(label, shape[k], v => { shape[k] = v; drawSketch(); }));
    } else if (shape) {
      head('Skizze: Linien');
      shape.pts.forEach((p, i) => [0, 1].forEach(j =>
        row(`Punkt ${i + 1} ${'XY'[j]}`, p[j], v => { p[j] = v; drawSketch(); })));
    }
    formRows(sketch.form, sketch, () => {});
    if (shape) button('Kontur löschen', () => { current().splice(sketch.sel, 1); sketch.sel = null; renderProps(); drawSketch(); });
    else box.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Mit „Ändern“ eine Kontur anklicken, um ihre Maße als Zahl oder Formel einzugeben.' }));
  } else if (selected) {
    const el = selected, form = el.form ?? 'extrusion';
    formRows(form, el, commit);
    button(`${FORMS[form]} bearbeiten`, () => startSketch(el));
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
  extrusion: () => startSketch(null, 'extrusion'),
  blend: () => startSketch(null, 'blend'),
  rotation: () => startSketch(null, 'rotation'),
  sweep: () => startSketch(null, 'sweep'),
  types: openTypes,
  stl: exportStl,
  'sk-select': () => setTool('select'),
  'sk-line': () => setTool('line'),
  'sk-rect': () => setTool('rect'),
  'sk-circle': () => setTool('circle'),
  'sk-ngon': () => setTool('ngon'),
  'sk-top': toggleTop,
  'sk-finish': finishSketch,
  'sk-cancel': () => { setStatus('Skizze verworfen.'); endSketch(sketch.el); },
};

function updateRibbon() {
  for (const id of ['grp-draw', 'grp-mode']) $(`#${id}`).hidden = !sketch;
  for (const id of ['grp-modify', 'grp-create', 'grp-props', 'grp-export']) $(`#${id}`).hidden = !!sketch;
  document.querySelectorAll('#grp-draw button').forEach(b => b.classList.toggle('active', b.dataset.cmd === `sk-${sketch?.tool}`));
  const top = $('[data-cmd=sk-top]');
  top.hidden = !SECOND[sketch?.form];
  if (!top.hidden) top.querySelector('span').textContent = sketch.form === 'sweep'
    ? (sketch.editTop ? 'Profil bearbeiten' : 'Pfad bearbeiten')
    : (sketch.editTop ? 'Basis bearbeiten' : 'Oben bearbeiten');
}

document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => commands[b.dataset.cmd]()));
document.querySelectorAll('#browser li[data-view]').forEach(li => li.addEventListener('click', () => setView(li.dataset.view, !sketch)));
$('#zoom-fit').addEventListener('click', zoomFit);

rebuildModel();
renderProps();
setView('vorne');
