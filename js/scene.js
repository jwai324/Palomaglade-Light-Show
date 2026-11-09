/**
 * scene.js — Three.js view of the neighborhood: aerial ground, house massing colored by setup
 * status, the two cable runs, connection boxes, themed islands, CSS labels, picking and camera.
 *
 * Data coordinates are local meters (x = east, y = north); in three.js X = x, Y = up, Z = −y.
 * Rendering is on demand. The train and home beacon animate at ≤30 fps only while on screen,
 * the tab is visible, motion is allowed and someone interacted within the last minute.
 */
import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from '../vendor/three/CSS2DRenderer.js';
import { nodeStatus, ISLAND_LABELS } from './model.js';
import { createSceneFallback as createFallback } from './fallback.js';

const STORY_H = 3.1;
const ROOF_OVERHANG = 0.4;
const CABLE_Y = 0.35;
const CABLE_R = 0.3;
const CROSSING_LIFT = 3;
const DASH_PERIOD = 2.4;
const RIBBON_W = 2.4;              // translucent ground strip under each cable: keeps runs legible when zoomed out
const SHELL = 0.45;                // thickness of the gold rim drawn around a selected/hovered house
const BOX_SIZE = 0.7;
const ISLAND_BOX_SIZE = 1.1;

const GOLD = 0xf5c451;
const RUN_COLORS = { right: 0xff9d2e, left: 0x38bdf8 };
const STATUS_COLORS = {
  unknown: 0xd4d7dd, out: 0x6b7280, none: 0xf3efe6, partial: 0xf5a524, done: 0x22c55e,
};
const FESTIVE = [0xff4d5e, 0xffd166, 0x3ddc97, 0x4cc9f0, 0xff7ae0, 0xfff1c1];
const WARM_WHITE = 0xffe2a8;
const AERIAL_PLACEHOLDER = 0x8a9580; // ground tint until (or if never) the aerial photo loads
const BASE_SHADE = 0.7;              // base plane = the photo's edge tone, a little darker

// `aerial` scales the photo's linear color: 0.07 at night reads as roughly 25–30% brightness.
const MODES = {
  day: {
    sky: 0xb4cbe0, fogNear: 900, fogFar: 2800, aerial: 1, base: 0x34442f,
    hemi: 1.7, hemiSky: 0xeef3ff, hemiGround: 0x4a5a3a, sun: 2.2, sunColor: 0xfff4e0,
    context: 0x9a9fa8, road: 0x60645f, bulb: 0.8, bulbFine: 0.6, glow: 4, night: false,
  },
  night: {
    sky: 0x060b18, fogNear: 600, fogFar: 2200, aerial: 0.07, base: 0x070b09,
    hemi: 0.4, hemiSky: 0x5a6b9a, hemiGround: 0x0b0f14, sun: 0.35, sunColor: 0x9db4ff,
    context: 0x3a404b, road: 0x14171b, bulb: 2.3, bulbFine: 1.1, glow: 6.5, night: true,
  },
};

const INITIAL_PHI = 0.95;          // radians from straight down; oblique view from the south
const FOCUS_SPAN = { house: 70, island: 55 };   // meters of context kept across the view when focusing
const FOCUS_MIN_DIST = { house: 110, island: 85 };
const LABEL_SPAN = 100;            // house numbers show once the view is about this many meters across
const FLY_MS = 750;
const FRAME_MS = 1000 / 30;
const IDLE_MS = 60000;
const CLICK_SLOP_PX = 6;
const TOP_INSET_PX = 56;           // floating view buttons over the map, until the UI reports the overlay
const LABEL_RESERVE_PX = 26;       // labels rise this far above their (bottom-centered) anchor
const MAX_DISTANCE = 1100;         // zoom-out limit, raised when a short viewport needs more to frame everything
const NIGHT_DIM = 0.4;             // at night, houses with nothing lit yet recede so the lit ones stand out

/** Data point [x, y] → world vector at height h. */
const toWorld = ([x, y], h = 0) => new THREE.Vector3(x, h, -y);

/**
 * Creates the scene inside `container`.
 * @returns {{available:boolean, applyState(Map):void, select(id|null):void, focus(id):void,
 *   setMode('day'|'night'):void, resetView():void, topView():void,
 *   setViewInset(bottomPx:number, topPx?:number):void, dispose():void}}
 */
export function createScene(container, data, { onSelect = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  let renderer;
  try {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) return createFallback(container);
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  } catch {
    return createFallback(container);
  }
  try {
    return new NeighborhoodScene(container, renderer, data, onSelect).api();
  } catch (err) {
    console.error('3D map failed to start:', err);
    renderer.dispose();
    container.replaceChildren();
    return createFallback(container);
  }
}

class NeighborhoodScene {
  constructor(container, renderer, data, onSelect) {
    this.container = container;
    this.renderer = renderer;
    this.data = data;
    this.onSelect = onSelect;
    this.mode = 'day';
    this.states = new Map();
    this.entries = new Map();        // node id → house/island entry
    this.pickables = [];
    this.selectedId = null;
    this.hoverId = null;
    this.insetBottom = 0;
    this.insetTop = TOP_INSET_PX;
    this.edgeTone = null;            // aerial photo's border color, once loaded
    this.roadMat = null;             // road strips, drawn only if the photo fails to load
    this.homeLabel = null;
    this.userMoved = false;
    this.tween = null;
    this.frameId = 0;
    this.dirty = true;
    this.lastAnim = 0;
    this.lastInteraction = performance.now();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    this.initRenderer();
    this.materials = createMaterials();
    this.buildGround();
    this.buildContextHouses();
    this.buildHouses();
    this.buildIslands();
    this.buildCables();
    this.buildHomeBeacon();
    this.buildLightLayers();
    this.buildSelectionRing();
    this.bounds = this.computeBounds();
    this.initControls();
    this.initPicking();
    this.observeSize();
    this.setMode('day');
  }

  api() {
    return {
      available: true,
      applyState: (states) => this.applyState(states),
      select: (id) => this.select(id),
      focus: (id) => this.focus(id),
      setMode: (mode) => this.setMode(mode),
      resetView: () => this.flyTo(this.overviewPose(INITIAL_PHI)),
      topView: () => this.flyTo(this.overviewPose(0.0001)),
      setViewInset: (bottomPx, topPx) => this.setViewInset(bottomPx, topPx),
      dispose: () => this.dispose(),
    };
  }

  // ------------------------------------------------------------------ setup

  initRenderer() {
    const { renderer, container } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'scene-canvas';
    renderer.domElement.setAttribute('aria-label', '3D map of Palomaglade Dr and Palomapark Ln');
    container.append(renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'scene-labels';
    container.append(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.Fog(0x000000, 1000, 3000);
    this.camera = new THREE.PerspectiveCamera(36, 1, 1.5, 6000);

    this.hemi = new THREE.HemisphereLight();
    this.sun = new THREE.DirectionalLight();
    this.sun.position.set(-160, 300, 220);
    this.scene.add(this.hemi, this.sun);

    this.onContextLost = (e) => e.preventDefault();
    this.onContextRestored = () => this.requestRender();
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  buildGround() {
    const { aerial } = this.data;
    const w = aerial.xmax - aerial.xmin;
    const h = aerial.ymax - aerial.ymin;

    this.baseMat = new THREE.MeshBasicMaterial();
    const base = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), this.baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.3;

    this.aerialMat = new THREE.MeshBasicMaterial({ color: AERIAL_PLACEHOLDER });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.aerialMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((aerial.xmin + aerial.xmax) / 2, 0, -(aerial.ymin + aerial.ymax) / 2);
    this.scene.add(base, ground);

    new THREE.TextureLoader().load(aerial.url, (tex) => {
      if (this.disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.aerialMat.map = tex;
      this.aerialMat.needsUpdate = true;
      this.edgeTone = edgeTone(tex.image);
      this.applyModeToGround();
      this.requestRender();
    }, undefined, () => {
      if (!this.disposed) this.buildRoadFallback();
    });
  }

  /** Without the aerial photo the ground shows no streets: draw the road centerlines instead. */
  buildRoadFallback() {
    this.roadMat = new THREE.MeshBasicMaterial({ color: MODES[this.mode].road, side: THREE.DoubleSide });
    for (const road of this.data.roads) {
      const geo = ribbonGeometry(road.pts.map((p) => toWorld(p)), road.ours ? 8 : 7, 0.03);
      this.scene.add(new THREE.Mesh(geo, this.roadMat));
    }
    this.requestRender();
  }

  buildContextHouses() {
    // Only neighbors standing on the aerial photo: beyond its edge they'd float on bare base.
    const { xmin, xmax, ymin, ymax } = this.data.aerial;
    const list = this.data.context_houses.filter(({ center: [x, y] }) => x > xmin && x < xmax && y > ymin && y < ymax);
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.contextMat = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geo, this.contextMat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((c, i) => {
      q.setFromAxisAngle(up, c.rot + Math.PI / 2);
      m.compose(toWorld(c.center), q, new THREE.Vector3(c.w, STORY_H * c.stories + 1.2, c.d));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  buildHouses() {
    const { materials } = this;
    for (const h of this.data.houses) {
      const height = STORY_H * h.stories;
      const rise = Math.min(h.w, h.d) * 0.22;
      const group = new THREE.Group();
      group.position.copy(toWorld(h.center));
      group.rotation.y = h.rot + Math.PI / 2;

      const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
      const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, height, h.d), bodyMat);
      body.position.y = height / 2;
      const roof = new THREE.Mesh(
        hipRoofGeometry(h.w + 2 * ROOF_OVERHANG, h.d + 2 * ROOF_OVERHANG, rise), roofMat,
      );
      roof.position.y = height;
      group.add(body, roof);
      group.updateMatrixWorld(true);

      const box = new THREE.Mesh(materials.boxGeo, materials.boxOff);
      box.position.copy(toWorld(h.cable, BOX_SIZE / 2));

      const top = height + rise;
      const label = makeLabel('lbl lbl-house', String(h.num), toWorld(h.center, top + 1.2));
      this.scene.add(group, box, label);

      const entry = {
        id: h.id, kind: 'house', group, box, label, bodyMat, roofMat, body, roof, shell: null,
        center: toWorld(h.center), radius: Math.max(h.w, h.d) / 2 + 3, top,
        bulbs: rooflineBulbs(h, height, group.matrixWorld),
      };
      for (const mesh of [body, roof, box]) this.addPickable(mesh, h.id);
      this.entries.set(h.id, entry);
    }
  }

  buildIslands() {
    for (const isl of this.data.islands) {
      const poly = openRing(isl.poly);
      const center = toWorld(isl.center);
      const group = new THREE.Group();

      const fillMat = new THREE.MeshBasicMaterial({
        color: GOLD, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)))),
        fillMat,
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = 0.08;

      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(poly.map((p) => toWorld(p, 0.12))),
        this.materials.outline,
      );
      const box = new THREE.Mesh(this.materials.islandBoxGeo, this.materials.boxOff);
      box.position.copy(toWorld(isl.box, ISLAND_BOX_SIZE / 2));
      group.add(fill, outline, box);

      const entry = {
        id: isl.id, kind: 'island', theme: isl.theme, group, box, fillMat, center,
        radius: Math.max(...poly.map(([x, y]) => Math.hypot(x - isl.center[0], y - isl.center[1]))) + 1.5,
        lightSets: [], figures: [], labelHeight: 4.5,
      };
      const decorate = {
        'star-wars': () => this.decorateStarWars(entry, poly),
        'train-tree': () => this.decorateTrainTree(entry, isl, poly),
        box: () => this.decorateParkIsland(entry, isl, poly),
      }[isl.theme];
      decorate?.();

      entry.label = makeLabel('lbl lbl-island', ISLAND_LABELS[isl.theme] ?? isl.name,
        toWorld(isl.center, entry.labelHeight));
      this.scene.add(group, entry.label);
      group.traverse((o) => { if (o.isMesh) this.addPickable(o, isl.id); });
      this.entries.set(isl.id, entry);
    }
  }

  decorateStarWars(entry, poly) {
    const bulbs = perimeterPoints(poly, 0.8).map((p) => toWorld(p, 0.5));
    const palette = [0xe0f2fe, 0x38bdf8, 0xf87171];
    entry.lightSets.push(this.makeBulbSet(bulbs, (i) => palette[i % palette.length], entry.group));

    const colors = [0xf4f4f5, 0x3f3f46, 0xc8a165, 0x4ade80, 0xfb923c];
    insidePoints(poly, 1.1, colors.length).forEach((p, i) => {
      const scale = 1 + ((i * 37) % 5) / 10;
      const mat = new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.55 });
      const figure = new THREE.Group();
      const body = new THREE.Mesh(this.materials.capsuleGeo, mat);
      body.position.y = 1.15;
      const head = new THREE.Mesh(this.materials.headGeo, mat);
      head.position.y = 2.45;
      figure.add(body, head);
      if (i % 2 === 1) {
        const rod = new THREE.Mesh(this.materials.rodGeo, i === 1 ? this.materials.rodRed : this.materials.rodBlue);
        rod.position.set(0.75, 1.6, 0);
        rod.rotation.z = -0.5;
        figure.add(rod);
      }
      figure.position.copy(toWorld(p));
      figure.scale.setScalar(scale);
      figure.rotation.y = i * 1.3;
      entry.group.add(figure);
      entry.figures.push(mat);
    });
  }

  decorateTrainTree(entry, isl, poly) {
    const { materials } = this;
    const inner = edgeDistance(isl.center, poly);
    const trackR = THREE.MathUtils.clamp(inner - 1.1, 3, 6.5);
    const center = toWorld(isl.center);

    const ballast = new THREE.Mesh(new THREE.RingGeometry(trackR - 0.45, trackR + 0.45, 64), materials.ballast);
    ballast.rotation.x = -Math.PI / 2;
    ballast.position.set(center.x, 0.1, center.z);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(trackR, 0.1, 6, 96), materials.rail);
    rail.rotation.x = -Math.PI / 2;
    rail.position.set(center.x, 0.2, center.z);
    entry.group.add(ballast, rail);

    // The control box sits at the island center, so the tree stands beside it (see treeDirection).
    const treeBase = 1.8;
    const offset = Math.min(treeBase + 0.9, trackR - treeBase - 0.4);
    const treePos = center.clone().addScaledVector(this.treeDirection(isl), Math.max(offset, 0));
    const treeH = 7.5;
    const trunk = new THREE.Mesh(materials.trunkGeo, materials.trunk);
    trunk.position.set(treePos.x, 0.5, treePos.z);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(treeBase, treeH, 24), materials.tree);
    cone.position.set(treePos.x, 1 + treeH / 2, treePos.z);
    const star = new THREE.Mesh(materials.treeStarGeo, materials.beacon);
    star.position.set(treePos.x, 1 + treeH + 0.35, treePos.z);
    entry.group.add(trunk, cone, star);

    const count = 190;
    const bulbs = [];
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const y = 1.2 + t * (treeH - 0.6);
      const r = treeBase * (1 - (y - 1) / treeH) + 0.12;
      const a = t * Math.PI * 2 * 9;
      bulbs.push(new THREE.Vector3(treePos.x + r * Math.cos(a), y, treePos.z + r * Math.sin(a)));
    }
    entry.lightSets.push(this.makeBulbSet(bulbs, (i) => FESTIVE[i % FESTIVE.length], entry.group, materials.bulbOnFine));

    const train = new THREE.Group();
    const cars = [
      { len: 1.4, color: 0xdc2626, engine: true },
      { len: 1.05, color: 0x16a34a },
      { len: 1.05, color: 0xeab308 },
      { len: 1.05, color: 0x2563eb },
    ];
    for (const car of cars) {
      const mat = new THREE.MeshStandardMaterial({ color: car.color, roughness: 0.5 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(car.len, 0.6, 0.62), mat);
      mesh.position.y = 0.55;
      const holder = new THREE.Group();
      holder.add(mesh);
      if (car.engine) {
        const stack = new THREE.Mesh(materials.stackGeo, materials.rail);
        stack.position.set(0.4, 1.05, 0);
        holder.add(stack);
      }
      holder.userData.len = car.len;
      train.add(holder);
    }
    entry.group.add(train);
    this.train = { group: train, center, radius: trackR, angle: 0, speed: 0.32 };
    this.placeTrain();

    entry.labelHeight = 1 + treeH + 2.2;
  }

  decorateParkIsland(entry, isl, poly) {
    const r = Math.min(edgeDistance(isl.center, poly) - 0.8, 3);
    const bulbs = [];
    const n = Math.round((2 * Math.PI * r) / 0.6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      bulbs.push(toWorld([isl.center[0] + r * Math.cos(a), isl.center[1] + r * Math.sin(a)], 0.6));
    }
    entry.lightSets.push(this.makeBulbSet(bulbs, () => WARM_WHITE, entry.group));
  }

  /**
   * World direction from an island's center (its control box) to its tree. The default,
   * Reset and focus cameras look from the south, so the tree must not stand south of the box:
   * candidates span east → north → west, and the one with the widest clearance from the
   * arriving cables wins, with a small preference for due north (straight behind the box).
   */
  treeDirection(isl) {
    const center = toWorld(isl.center);
    const cables = [];
    for (const s of this.data.segments) {
      if (s.from === isl.id) cables.push(toWorld(s.path[1]));
      if (s.to === isl.id) cables.push(toWorld(s.path[s.path.length - 2]));
    }
    const cableDirs = cables.map((p) => p.sub(center).setY(0).normalize());
    let best = null;
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI;                     // 0 = east, π/2 = north, π = west
      const dir = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      const clearance = Math.min(Math.PI, ...cableDirs.map((c) => dir.angleTo(c)));
      const score = clearance + 0.25 * Math.sin(a);
      if (!best || score > best.score) best = { dir, score };
    }
    return best.dir;
  }

  /** Light bulbs that switch between an unlit and a lit (glowing) material. */
  makeBulbSet(points, colorAt, parent, litMaterial = this.materials.bulbOn) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const colors = new Float32Array(points.length * 3);
    const c = new THREE.Color();
    points.forEach((_, i) => c.setHex(colorAt(i)).toArray(colors, i * 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pts = new THREE.Points(geo, this.materials.bulbOff);
    pts.userData.lit = litMaterial;
    parent.add(pts);
    return pts;
  }

  buildCables() {
    this.cables = this.data.segments.map((seg) => {
      const pts = seg.path.map((p) => toWorld(p, CABLE_Y));
      const curve = new CablePath(pts, seg.crossing ? CROSSING_LIFT : 0);
      const length = curve.getLength();
      const steps = seg.crossing ? 40 : Math.max(4, Math.ceil(length / 0.8));
      const geo = new THREE.TubeGeometry(curve, steps, CABLE_R, 6, false);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * length) / DASH_PERIOD);
      const mesh = new THREE.Mesh(geo, this.materials.cablePending[seg.chain]);
      this.scene.add(mesh);
      // Street crossings get no ground strip: it would read as cable lying on the road.
      let ribbon = null;
      if (!seg.crossing) {
        ribbon = new THREE.Mesh(ribbonGeometry(pts, RIBBON_W, 0.06), this.materials.ribbonPending[seg.chain]);
        this.scene.add(ribbon);
      }
      return { seg, mesh, ribbon };
    });
  }

  buildHomeBeacon() {
    const home = this.entries.get(this.data.home);
    if (!home) return;
    const { materials } = this;
    const starY = home.top + 7;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, starY - home.top), materials.beam);
    beam.position.set(home.center.x, (starY + home.top) / 2, home.center.z);
    const star = new THREE.Mesh(starGeometry(1.7, 0.72, 0.45), materials.beacon);
    star.position.set(home.center.x, starY, home.center.z);
    this.scene.add(beam, star);
    this.addPickable(star, home.id);
    this.beacon = star;
    // The house's own label names the start. Close up it stays at roof height like every house
    // label, so it can't spill onto the next house north; zoomed out it moves above the star.
    home.label.element.className = 'lbl lbl-home';
    home.label.element.textContent = `★ ${home.label.element.textContent} · cable start`;
    this.homeLabel = {
      label: home.label, near: home.label.position.clone(), far: home.center.clone().setY(starY + 2),
    };
  }

  buildLightLayers() {
    this.roofLights = new THREE.Points(new THREE.BufferGeometry(), this.materials.bulbOn);
    this.boxGlow = new THREE.Points(new THREE.BufferGeometry(), this.materials.boxGlow);
    this.scene.add(this.roofLights, this.boxGlow);
  }

  buildSelectionRing() {
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 72), this.materials.ring);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);
  }

  computeBounds() {
    const box = new THREE.Box3();
    for (const e of this.entries.values()) {
      box.expandByPoint(e.center.clone().addScalar(-e.radius));
      box.expandByPoint(e.center.clone().addScalar(e.radius));
    }
    box.min.y = 0;
    box.max.y = 10;
    const { aerial } = this.data;
    return {
      fit: box,
      corners: boxCorners(box),
      pan: { xmin: aerial.xmin, xmax: aerial.xmax, zmin: -aerial.ymax, zmax: -aerial.ymin },
    };
  }

  initControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.minDistance = 15;
    controls.maxDistance = MAX_DISTANCE;
    controls.maxPolarAngle = 1.36;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.addEventListener('change', () => this.requestRender());
    controls.addEventListener('start', () => {
      this.userMoved = true;
      this.tween = null;
      this.touch();
    });
    this.controls = controls;
  }

  initPicking() {
    const el = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const activePointers = new Set();
    let down = null;
    let multiTouch = false;
    let hoverQueued = null;

    const pick = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, this.camera);
      const hit = raycaster.intersectObjects(this.pickables, false).find((h) => isShown(h.object));
      return hit ? hit.object.userData.nodeId : null;
    };

    this.onPointerDown = (e) => {
      activePointers.add(e.pointerId);
      if (activePointers.size > 1) multiTouch = true;
      if (activePointers.size === 1) {
        multiTouch = false;
        down = { x: e.clientX, y: e.clientY };
      }
      this.touch();
    };
    this.onPointerUp = (e) => {
      activePointers.delete(e.pointerId);
      if (!down || multiTouch || e.button > 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > CLICK_SLOP_PX) return;
      const id = pick(e.clientX, e.clientY);
      this.select(id);
      this.onSelect(id);
    };
    this.onPointerCancel = (e) => {
      activePointers.delete(e.pointerId);
      down = null;
    };
    this.onPointerMove = (e) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      if (!hoverQueued) {
        requestAnimationFrame(() => {
          const { x, y } = hoverQueued;
          hoverQueued = null;
          this.setHover(pick(x, y));
        });
      }
      hoverQueued = { x: e.clientX, y: e.clientY };
    };
    this.onPointerLeave = () => this.setHover(null);
    this.onWheel = () => this.touch();

    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onWheel, { passive: true });

    this.onVisibility = () => { if (!document.hidden) this.requestRender(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  observeSize() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  addPickable(mesh, nodeId) {
    mesh.userData.nodeId = nodeId;
    this.pickables.push(mesh);
  }

  // ------------------------------------------------------------------ state + appearance

  applyState(states) {
    this.states = states instanceof Map ? states : new Map();
    for (const entry of this.entries.values()) this.paint(entry);
    const { cableLaid, cablePending, ribbonLaid, ribbonPending } = this.materials;
    for (const { seg, mesh, ribbon } of this.cables) {
      const laid = this.states.get(seg.to)?.cable_run === true;
      mesh.material = (laid ? cableLaid : cablePending)[seg.chain];
      if (ribbon) ribbon.material = (laid ? ribbonLaid : ribbonPending)[seg.chain];
    }
    this.rebuildLightLayers();
    this.requestRender();
  }

  paint(entry) {
    const state = this.states.get(entry.id);
    const night = MODES[this.mode].night;
    const participating = state ? state.participating : !this.data.opted_out_default.includes(entry.id);
    const selected = this.selectedId === entry.id;
    const hovered = this.hoverId === entry.id;

    entry.box.visible = participating;
    entry.box.material = state?.box_connected ? this.materials.boxOn : this.materials.boxOff;

    if (entry.kind === 'house') {
      // The body keeps its status color whatever the selection; selection and hover are
      // shown by a rim around the house (plus the ground ring and gold label when selected).
      const status = nodeStatus(state);
      const color = STATUS_COLORS[status];
      const ghost = status === 'out';
      const unlit = ghost || status === 'none' || status === 'unknown';
      const dim = night && unlit ? NIGHT_DIM : 1;
      entry.bodyMat.color.setHex(color).multiplyScalar(dim);
      entry.roofMat.color.setHex(color).multiplyScalar(0.78 * dim);
      for (const mat of [entry.bodyMat, entry.roofMat]) {
        if (mat.transparent !== ghost) {
          mat.transparent = ghost;
          mat.depthWrite = !ghost;
          mat.needsUpdate = true;
        }
        mat.opacity = ghost ? 0.55 : 1;
        if (night && !unlit) mat.emissive.setHex(color).multiplyScalar(0.14);
        else mat.emissive.setHex(0x000000);
      }
      if (selected || hovered) {
        const shell = this.shellFor(entry);
        shell.visible = true;
        for (const mesh of shell.children) mesh.material = selected ? this.materials.shellSelected : this.materials.shellHover;
      } else if (entry.shell) {
        entry.shell.visible = false;
      }
      entry.label.element.classList.toggle('is-selected', selected);
    } else {
      const lit = Boolean(state?.participating && state.lights_up);
      for (const pts of entry.lightSets) pts.material = lit ? pts.userData.lit : this.materials.bulbOff;
      for (const mat of entry.figures) {
        mat.emissive.copy(mat.color).multiplyScalar(lit ? (night ? 0.6 : 0.1) : 0);
      }
      entry.fillMat.opacity = selected ? 0.28 : hovered ? 0.18 : 0;
      entry.label.element.classList.toggle('is-selected', selected);
    }
  }

  /** Rim around a house: enlarged back-face copies of its body and roof (built on first use). */
  shellFor(entry) {
    if (entry.shell) return entry.shell;
    const { body, roof } = entry;
    const { width: w, height: h, depth: d } = body.geometry.parameters;
    const rise = entry.top - h;
    const shell = new THREE.Group();
    const bodyShell = new THREE.Mesh(body.geometry, this.materials.shellSelected);
    bodyShell.position.copy(body.position);
    bodyShell.scale.set((w + 2 * SHELL) / w, (h + SHELL) / h, (d + 2 * SHELL) / d);
    const roofW = w + 2 * ROOF_OVERHANG;
    const roofD = d + 2 * ROOF_OVERHANG;
    const roofShell = new THREE.Mesh(roof.geometry, this.materials.shellSelected);
    roofShell.position.copy(roof.position);
    roofShell.scale.set((roofW + 2 * SHELL) / roofW, (rise + SHELL) / rise, (roofD + 2 * SHELL) / roofD);
    shell.add(bodyShell, roofShell);
    entry.group.add(shell);
    entry.shell = shell;
    return shell;
  }

  rebuildLightLayers() {
    const roof = [];
    const roofColors = [];
    const glow = [];
    for (const entry of this.entries.values()) {
      const s = this.states.get(entry.id);
      if (!s?.participating) continue;
      if (entry.kind === 'house' && s.lights_up) {
        roof.push(...entry.bulbs.positions);
        roofColors.push(...entry.bulbs.colors);
      }
      if (s.box_connected) glow.push(entry.box.position.x, entry.box.position.y + 0.5, entry.box.position.z);
    }
    replaceGeometry(this.roofLights, { position: roof, color: roofColors });
    replaceGeometry(this.boxGlow, { position: glow });
  }

  setMode(mode) {
    this.mode = MODES[mode] ? mode : 'day';
    const m = MODES[this.mode];
    const { materials } = this;
    this.scene.background.setHex(m.sky);
    this.scene.fog.color.setHex(m.sky);
    this.applyFog();
    this.applyModeToGround();
    this.hemi.color.setHex(m.hemiSky);
    this.hemi.groundColor.setHex(m.hemiGround);
    this.hemi.intensity = m.hemi;
    this.sun.color.setHex(m.sunColor);
    this.sun.intensity = m.sun;
    this.contextMat.color.setHex(m.context);

    materials.bulbOn.size = m.bulb;
    materials.bulbOnFine.size = m.bulbFine;
    for (const mat of [materials.bulbOn, materials.bulbOnFine]) {
      mat.blending = m.night ? THREE.AdditiveBlending : THREE.NormalBlending;
      mat.needsUpdate = true;
    }
    materials.boxGlow.size = m.glow;
    materials.boxOn.emissiveIntensity = m.night ? 1.6 : 0.45;
    for (const run of Object.keys(RUN_COLORS)) {
      materials.cableLaid[run].emissiveIntensity = m.night ? 1.25 : 0.35;
      materials.cablePending[run].opacity = m.night ? 0.6 : 0.8;
      materials.ribbonLaid[run].opacity = m.night ? 0.5 : 0.42;
      materials.ribbonPending[run].opacity = m.night ? 0.3 : 0.26;
    }
    materials.beacon.emissiveIntensity = m.night ? 1.4 : 0.5;
    materials.outline.opacity = m.night ? 0.35 : 0.55;
    this.boxGlow.visible = m.night;
    for (const entry of this.entries.values()) this.paint(entry);
    this.touch();
    this.requestRender();
  }

  /** Ground colors for the mode; `aerial` dims the photo, or the placeholder tint before/without it. */
  applyModeToGround() {
    const m = MODES[this.mode];
    const { aerialMat, baseMat } = this;
    aerialMat.color.setHex(aerialMat.map ? 0xffffff : AERIAL_PLACEHOLDER).multiplyScalar(m.aerial);
    if (this.edgeTone) baseMat.color.copy(this.edgeTone).multiplyScalar(m.aerial * BASE_SHADE);
    else baseMat.color.setHex(m.base);
    this.roadMat?.color.setHex(m.road);
  }

  /** Fog starts beyond the farthest overview distance, so zooming all the way out stays clear. */
  applyFog() {
    const m = MODES[this.mode];
    const slack = Math.max(0, this.controls.maxDistance - MAX_DISTANCE);
    this.scene.fog.near = m.fogNear + slack;
    this.scene.fog.far = m.fogFar + slack;
  }

  // ------------------------------------------------------------------ selection + camera

  select(id) {
    const next = id && this.entries.has(id) ? id : null;
    const prev = this.selectedId;
    this.selectedId = next;
    if (prev && this.entries.has(prev)) this.paint(this.entries.get(prev));
    if (next) {
      const entry = this.entries.get(next);
      this.paint(entry);
      this.ring.position.set(entry.center.x, 0.15, entry.center.z);
      this.ring.scale.setScalar(entry.radius);
    }
    this.ring.visible = Boolean(next);
    this.touch();
    this.requestRender();
  }

  setHover(id) {
    if (id === this.hoverId) return;
    const prev = this.hoverId;
    this.hoverId = id;
    if (prev) this.paint(this.entries.get(prev));
    if (id) this.paint(this.entries.get(id));
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.requestRender();
  }

  focus(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const current = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(this.controls.target),
    );
    const phi = THREE.MathUtils.clamp(current.phi, 0.35, 0.8);
    const radius = Math.max(FOCUS_MIN_DIST[entry.kind], this.distanceForSpan(FOCUS_SPAN[entry.kind]));
    this.flyTo({
      target: new THREE.Vector3(entry.center.x, 0, entry.center.z),
      spherical: new THREE.Spherical(radius, phi, current.theta),
    });
  }

  /** Camera distance at which `meters` of ground span the view's width. */
  distanceForSpan(meters) {
    const halfHFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    return meters / 2 / Math.tan(halfHFov);
  }

  /**
   * Camera pose (viewed from the south at polar angle `phi`) that frames the whole neighborhood
   * in the visible part of the viewport — below the floating overlay (view buttons, banner)
   * plus room for labels, above the bottom sheet: fit the distance, then slide the target
   * along the view direction until the framed area is vertically centered (perspective makes
   * the near end bind first), and refit. On a short viewport the fit can need more distance
   * than the usual zoom-out limit; the limit is raised to match so the pose is reachable.
   */
  overviewPose(phi) {
    const cam = this.camera.clone();
    const target = this.bounds.fit.getCenter(new THREE.Vector3()).setY(0);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, 0);
    const forward = new THREE.Vector3(0, 0, -1);
    const h = Math.max(1, this.container.clientHeight);
    const yMin = -1 + (2 * this.insetBottom) / h + 0.08;
    const yMax = 1 - (2 * (this.insetTop + LABEL_RESERVE_PX)) / h;
    const p = new THREE.Vector3();

    const span = (radius) => {
      cam.position.copy(target).addScaledVector(dir, radius);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      let lo = Infinity;
      let hi = -Infinity;
      let inside = true;
      for (const c of this.bounds.corners) {
        p.copy(c).project(cam);
        if (p.z >= 1 || Math.abs(p.x) > 0.92) inside = false;
        lo = Math.min(lo, p.y);
        hi = Math.max(hi, p.y);
      }
      return { lo, hi, fits: inside && lo > yMin && hi < yMax };
    };
    const fit = () => {
      let lo = 20;
      let hi = 3000;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (span(mid).fits) hi = mid; else lo = mid;
      }
      return hi;
    };

    const halfFov = THREE.MathUtils.degToRad(cam.fov / 2);
    let radius = fit();
    for (let i = 0; i < 4; i++) {
      const { lo, hi } = span(radius);
      const offset = (lo + hi) / 2 - (yMin + yMax) / 2;
      if (Math.abs(offset) < 0.01) break;
      target.addScaledVector(forward, (offset * radius * Math.tan(halfFov)) / Math.max(0.3, Math.cos(phi)));
      radius = fit();
    }
    const maxDistance = Math.max(MAX_DISTANCE, Math.ceil(radius * 1.15));
    if (maxDistance !== this.controls.maxDistance) {
      this.controls.maxDistance = maxDistance;
      this.applyFog();
    }
    return { target, spherical: new THREE.Spherical(radius, phi, 0) };
  }

  flyTo({ target, spherical }) {
    this.userMoved = true;
    this.touch();
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    let dTheta = spherical.theta - from.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.tween = {
      start: performance.now(),
      duration: this.reducedMotion.matches ? 0 : FLY_MS,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      from,
      to: spherical,
      dTheta,
    };
    this.requestRender();
  }

  stepTween(now) {
    const t = this.tween;
    const k = t.duration ? Math.min(1, (now - t.start) / t.duration) : 1;
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const lerp = (a, b) => a + (b - a) * e;
    this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
    const s = new THREE.Spherical(lerp(t.from.radius, t.to.radius), lerp(t.from.phi, t.to.phi), t.from.theta + t.dTheta * e);
    this.camera.position.setFromSpherical(s).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) this.tween = null;
  }

  jumpTo({ target, spherical }) {
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(spherical).add(target);
    this.camera.lookAt(target);
    this.controls.update();
  }

  clampTarget() {
    const t = this.controls.target;
    const { pan } = this.bounds;
    const x = THREE.MathUtils.clamp(t.x, pan.xmin, pan.xmax);
    const z = THREE.MathUtils.clamp(t.z, pan.zmin, pan.zmax);
    if (x !== t.x || z !== t.z) {
      this.camera.position.x += x - t.x;
      this.camera.position.z += z - t.z;
      t.x = x;
      t.z = z;
    }
  }

  /** Pixels of the view covered by UI: the bottom sheet's peek and the overlay at the top. */
  setViewInset(bottomPx, topPx = this.insetTop) {
    const bottom = Math.max(0, Math.round(bottomPx || 0));
    const top = Math.max(0, Math.round(topPx || 0));
    if (bottom === this.insetBottom && top === this.insetTop) return;
    this.insetBottom = bottom;
    this.insetTop = top;
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    if (this.insetBottom) this.camera.setViewOffset(w, h, 0, this.insetBottom / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.jumpTo(this.overviewPose(INITIAL_PHI));
    this.requestRender();
  }

  // ------------------------------------------------------------------ render loop

  touch() {
    this.lastInteraction = performance.now();
    this.requestRender();
  }

  requestRender() {
    this.dirty = true;
    this.schedule();
  }

  schedule() {
    if (!this.frameId && !this.disposed) this.frameId = requestAnimationFrame((t) => this.frame(t));
  }

  frame(now) {
    this.frameId = 0;
    if (document.hidden) return;
    let moving = this.controls.update();
    if (this.tween) {
      this.stepTween(now);
      moving = true;
    }
    this.clampTarget();

    const animating = this.animationsActive(now);
    if (animating && now - this.lastAnim >= FRAME_MS) {
      this.animate(Math.min(now - this.lastAnim, 100) / 1000);
      this.lastAnim = now;
      this.dirty = true;
    } else if (!animating) {
      this.lastAnim = now;
    }

    if (moving || this.dirty) {
      this.updateLabels();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      this.dirty = false;
    }
    if (moving || animating) this.schedule();
  }

  animationsActive(now) {
    if (this.reducedMotion.matches || now - this.lastInteraction > IDLE_MS) return false;
    const { frustum, matrix, sphere } = this.viewCheck ??= {
      frustum: new THREE.Frustum(), matrix: new THREE.Matrix4(), sphere: new THREE.Sphere(),
    };
    this.camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const inView = (pos, r) => frustum.intersectsSphere(sphere.set(pos, r));
    return Boolean((this.train && inView(this.train.center, this.train.radius + 2))
      || (this.beacon && inView(this.beacon.position, 3)));
  }

  animate(dt) {
    if (this.train) {
      this.train.angle += this.train.speed * dt;
      this.placeTrain();
    }
    if (this.beacon) this.beacon.rotation.y += 0.9 * dt;
  }

  placeTrain() {
    const { group, center, radius, angle } = this.train;
    let along = 0;
    for (const car of group.children) {
      const a = angle - along / radius;
      car.position.set(center.x + radius * Math.cos(a), 0.1, center.z + radius * Math.sin(a));
      car.rotation.y = -(a + Math.PI / 2);
      along += car.userData.len + 0.25;
    }
  }

  updateLabels() {
    const maxDist = this.distanceForSpan(LABEL_SPAN);
    const cam = this.camera.position;
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'house' || entry.id === this.data.home) continue;
      entry.label.visible = entry.id === this.selectedId || cam.distanceTo(entry.label.position) < maxDist;
    }
    if (this.homeLabel) {
      const { label, near, far } = this.homeLabel;
      label.position.copy(cam.distanceTo(near) < maxDist ? near : far);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('webglcontextlost', this.onContextLost);
    el.removeEventListener('webglcontextrestored', this.onContextRestored);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controls.dispose();
    const seen = new Set();
    const free = (x) => { if (x && !seen.has(x)) { seen.add(x); x.dispose(); } };
    this.scene.traverse((o) => {
      free(o.geometry);
      for (const m of [].concat(o.material ?? [])) { free(m.map); free(m.alphaMap); free(m); }
    });
    Object.values(this.materials).flatMap((m) => (m.isMaterial || m.isBufferGeometry ? [m] : Object.values(m))).forEach(free);
    this.renderer.dispose();
    el.remove();
    this.labels.domElement.remove();
  }
}

// ------------------------------------------------------------------ shared materials

function createMaterials() {
  const glow = makeGlowTexture();
  const dash = makeDashTexture();
  const cableLaid = {};
  const cablePending = {};
  const ribbonLaid = {};
  const ribbonPending = {};
  const flat = { transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 };
  for (const [run, color] of Object.entries(RUN_COLORS)) {
    cableLaid[run] = new THREE.MeshStandardMaterial({ color, emissive: color, roughness: 0.4 });
    cablePending[run] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.8,
      transparent: true, alphaMap: dash, alphaTest: 0.3, depthWrite: false,
    });
    ribbonLaid[run] = new THREE.MeshBasicMaterial({ ...flat, color });
    ribbonPending[run] = new THREE.MeshBasicMaterial({ ...flat, color, alphaMap: dash, alphaTest: 0.05 });
  }
  return {
    cableLaid,
    cablePending,
    ribbonLaid,
    ribbonPending,
    boxGeo: new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE),
    islandBoxGeo: new THREE.BoxGeometry(ISLAND_BOX_SIZE, ISLAND_BOX_SIZE, ISLAND_BOX_SIZE),
    capsuleGeo: new THREE.CapsuleGeometry(0.55, 1.1, 6, 14),
    headGeo: new THREE.SphereGeometry(0.48, 16, 12),
    rodGeo: new THREE.CylinderGeometry(0.06, 0.06, 1.3),
    trunkGeo: new THREE.CylinderGeometry(0.3, 0.38, 1),
    treeStarGeo: new THREE.OctahedronGeometry(0.45),
    stackGeo: new THREE.CylinderGeometry(0.12, 0.16, 0.45),
    boxOn: new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, roughness: 0.4 }),
    boxOff: new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.7 }),
    bulbOn: new THREE.PointsMaterial({
      size: 0.8, map: glow, vertexColors: true, transparent: true, depthWrite: false,
    }),
    bulbOnFine: new THREE.PointsMaterial({   // dense sets (the lit tree): smaller glow so colors stay distinct
      size: 0.6, map: glow, vertexColors: true, transparent: true, depthWrite: false,
    }),
    bulbOff: new THREE.PointsMaterial({
      size: 0.4, map: glow, color: 0x52525b, transparent: true, depthWrite: false,
    }),
    boxGlow: new THREE.PointsMaterial({
      size: 4, map: glow, color: 0x22c55e, transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
    shellSelected: new THREE.MeshBasicMaterial({ color: GOLD, side: THREE.BackSide }),
    shellHover: new THREE.MeshBasicMaterial({ color: 0xffe9a8, side: THREE.BackSide, transparent: true, opacity: 0.7 }),
    beacon: new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, roughness: 0.3, metalness: 0.2 }),
    beam: new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.55 }),
    ring: new THREE.MeshBasicMaterial({
      color: GOLD, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    }),
    outline: new THREE.LineBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.55 }),
    rodRed: new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xff4d4d, emissiveIntensity: 1.2 }),
    rodBlue: new THREE.MeshStandardMaterial({ color: 0x4dc3ff, emissive: 0x4dc3ff, emissiveIntensity: 1.2 }),
    tree: new THREE.MeshStandardMaterial({ color: 0x1f5f3a, roughness: 0.9 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.9 }),
    ballast: new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 1 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.6 }),
  };
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Average color of an image's outer border, so the base plane meets the photo without a hard seam. */
function edgeTone(image) {
  try {
    const n = 32;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, n, n);
    const px = g.getImageData(0, 0, n, n).data;
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue;
        const i = (y * n + x) * 4;
        sum[0] += px[i];
        sum[1] += px[i + 1];
        sum[2] += px[i + 2];
        count += 1;
      }
    }
    return new THREE.Color().setRGB(sum[0] / count / 255, sum[1] / count / 255, sum[2] / count / 255, THREE.SRGBColorSpace);
  } catch {
    return null;
  }
}

/** Alpha stripes along a tube's length: makes not-yet-laid cable read as dashed. */
function makeDashTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 4);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 38, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ------------------------------------------------------------------ geometry helpers

/** Polyline through `points`, optionally lifted into an arch (street crossings). */
class CablePath extends THREE.Curve {
  constructor(points, lift) {
    super();
    this.points = points;
    this.lift = lift;
    this.cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
    }
  }

  getPoint(t, target = new THREE.Vector3()) {
    const { points, cumulative } = this;
    const total = cumulative[cumulative.length - 1];
    const d = t * total;
    let i = 1;
    while (i < points.length - 1 && cumulative[i] < d) i++;
    const span = cumulative[i] - cumulative[i - 1] || 1;
    target.lerpVectors(points[i - 1], points[i], (d - cumulative[i - 1]) / span);
    target.y += this.lift * Math.sin(Math.PI * t);
    return target;
  }
}

/** Flat strip of `width` along a polyline at height y; u runs along the length in dash periods. */
function ribbonGeometry(points, width, y) {
  const pos = [];
  const uv = [];
  const index = [];
  const dir = new THREE.Vector3();
  let along = 0;
  points.forEach((p, i) => {
    const prev = points[i - 1] ?? p;
    const next = points[i + 1] ?? p;
    dir.subVectors(next, prev).setY(0).normalize();
    const nx = -dir.z * (width / 2);
    const nz = dir.x * (width / 2);
    if (i > 0) along += Math.hypot(p.x - prev.x, p.z - prev.z);
    pos.push(p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz);
    uv.push(along / DASH_PERIOD, 0, along / DASH_PERIOD, 1);
    if (i > 0) {
      const a = (i - 1) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

/**
 * Hip roof over a w × d rectangle (local X × Z), base at y = 0, ridge at y = rise. The base is
 * closed so the solid works as an inverted hull (the selection rim is its enlarged back faces).
 */
function hipRoofGeometry(w, d, rise) {
  const hw = w / 2;
  const hd = d / 2;
  const a = new THREE.Vector3(-hw, 0, -hd);
  const b = new THREE.Vector3(hw, 0, -hd);
  const c = new THREE.Vector3(hw, 0, hd);
  const e = new THREE.Vector3(-hw, 0, hd);
  let tris;
  if (w >= d) {
    const r1 = new THREE.Vector3(-(w - d) / 2, rise, 0);
    const r2 = new THREE.Vector3((w - d) / 2, rise, 0);
    tris = [[a, b, r2], [a, r2, r1], [c, e, r1], [c, r1, r2], [b, c, r2], [e, a, r1]];
  } else {
    const r1 = new THREE.Vector3(0, rise, -(d - w) / 2);
    const r2 = new THREE.Vector3(0, rise, (d - w) / 2);
    tris = [[a, b, r1], [c, e, r2], [b, c, r2], [b, r2, r1], [e, a, r1], [e, r1, r2]];
  }
  tris.push([a, b, c], [a, c, e]);
  const inside = new THREE.Vector3(0, rise / 3, 0);
  const pos = [];
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (const [p, q, r] of tris) {
    n.subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p));
    mid.copy(p).add(q).add(r).divideScalar(3).sub(inside);
    const ordered = n.dot(mid) >= 0 ? [p, q, r] : [p, r, q];
    for (const v of ordered) pos.push(v.x, v.y, v.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function starGeometry(outer, inner, depth) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    if (i === 0) shape.moveTo(r * Math.cos(a), r * Math.sin(a));
    else shape.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).center();
}

/** World-space bulb positions/colors along a house's eaves. */
function rooflineBulbs(house, height, matrixWorld) {
  const hw = house.w / 2 + ROOF_OVERHANG;
  const hd = house.d / 2 + ROOF_OVERHANG;
  const rect = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  const multicolor = house.num % 3 !== 0;
  const positions = [];
  const colors = [];
  const c = new THREE.Color();
  perimeterPoints(rect, 0.9).forEach(([x, z], i) => {
    const p = new THREE.Vector3(x, height + 0.08, z).applyMatrix4(matrixWorld);
    positions.push(p.x, p.y, p.z);
    c.setHex(multicolor ? FESTIVE[i % FESTIVE.length] : WARM_WHITE);
    colors.push(c.r, c.g, c.b);
  });
  return { positions, colors };
}

function replaceGeometry(points, attrs) {
  const geo = new THREE.BufferGeometry();
  for (const [name, values] of Object.entries(attrs)) {
    geo.setAttribute(name, new THREE.Float32BufferAttribute(values, 3));
  }
  points.geometry.dispose();
  points.geometry = geo;
}

function makeLabel(className, text, position) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  const label = new CSS2DObject(el);
  label.position.copy(position);
  label.center.set(0.5, 1);
  return label;
}

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function boxCorners(box) {
  const out = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}

// ------------------------------------------------------------------ 2D polygon helpers (data coords)

function openRing(poly) {
  const [a, b] = [poly[0], poly[poly.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? poly.slice(0, -1) : poly;
}

/** Evenly spaced points along a closed polygon's edges. */
function perimeterPoints(poly, spacing) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let d = carry;
    for (; d < len; d += spacing) out.push([x1 + ((x2 - x1) * d) / len, y1 + ((y2 - y1) * d) / len]);
    carry = d - len;
  }
  return out;
}

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function edgeDistance([x, y], poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = THREE.MathUtils.clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

/** `count` points spread along the polygon's long axis, each ≥ `margin` from the edge. */
function insidePoints(poly, margin, count) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const alongX = x1 - x0 >= y1 - y0;
  const candidates = [];
  for (let x = x0; x <= x1; x += 0.5) {
    for (let y = y0; y <= y1; y += 0.5) {
      if (pointInPolygon([x, y], poly) && edgeDistance([x, y], poly) >= margin) candidates.push([x, y]);
    }
  }
  if (!candidates.length) return [];
  candidates.sort((p, q) => (alongX ? p[0] - q[0] : p[1] - q[1]));
  return Array.from({ length: count }, (_, i) => candidates[Math.floor(((i + 0.5) / count) * candidates.length)]);
}
