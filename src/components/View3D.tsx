import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Computed, ProjectUI } from '../model';
import { buildScene, type Scene3D } from '../scene3d';
import { useUnits, type Units } from '../units';

interface Props {
  project: ProjectUI;
  computed: Computed;
}

interface Options {
  labels: boolean;
  coords: boolean;
  images: boolean;
  grid: boolean;
  /** Vertical (height) exaggeration. */
  zExag: number;
  /** Pipe diameter multiplier. */
  pipeExag: number;
  colourByVelocity: boolean;
}

type View = 'iso' | 'top' | 'front' | 'side';

interface Rig {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  fitted: boolean;
}

/** World (X east, Y north, Z up) to three.js (X, Y up, Z toward the viewer). */
const toThree = (p: { x: number; y: number; z: number }, zExag: number) => new THREE.Vector3(p.x, p.z * zExag, -p.y);

function velocityColour(v: number | undefined, vmax: number): THREE.Color {
  if (v === undefined || vmax <= 0) return new THREE.Color(0x6f86a8);
  const t = Math.min(1, v / vmax);
  return new THREE.Color().setHSL(0.62 - 0.62 * t, 0.7, 0.5);
}

function label(text: string, sub?: string): CSS2DObject {
  const div = document.createElement('div');
  div.className = 'label3d';
  div.textContent = text;
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    div.appendChild(s);
  }
  return new CSS2DObject(div);
}

function coordText(p: { x: number; y: number; z: number }, U: Units): string {
  return `${U.f('length', p.x, 1)}, ${U.f('length', p.y, 1)}, ${U.f('elevation', p.z, 1)} ${U.u('length')}`;
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
  while (g.children.length) g.remove(g.children[0]);
}

/** Cylinder between two points. */
function segment(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(dir.length(), 1e-6);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 14), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function populate(rig: Rig, sc: Scene3D, project: ProjectUI, o: Options, U: Units) {
  disposeGroup(rig.content);
  const g = rig.content;
  const span = Math.max(sc.max.x - sc.min.x, sc.max.y - sc.min.y, (sc.max.z - sc.min.z) * o.zExag, 10);
  const tankR = Math.max(span * 0.032, 0.4);
  const vmax = Math.max(0.5, ...sc.edges.map((e) => e.velocity ?? 0));
  const T = (p: { x: number; y: number; z: number }) => toThree(p, o.zExag);

  // ground grid and axes at the lowest point
  const floor = sc.min.z * o.zExag;
  if (o.grid) {
    const size = Math.ceil((span * 1.3) / 10) * 10;
    const grid = new THREE.GridHelper(size, Math.round(size / 5), 0x8892a6, 0x3a4256);
    grid.position.set((sc.min.x + sc.max.x) / 2, floor - 0.01, -(sc.min.y + sc.max.y) / 2);
    g.add(grid);
  }
  const axisLen = span * 0.18;
  const origin = new THREE.Vector3(sc.min.x, floor, -sc.min.y);
  for (const [dir, colour, name] of [
    [new THREE.Vector3(1, 0, 0), 0xe5534b, 'X'],
    [new THREE.Vector3(0, 0, -1), 0x57ab5a, 'Y'],
    [new THREE.Vector3(0, 1, 0), 0x539bf5, 'Z'],
  ] as const) {
    g.add(new THREE.ArrowHelper(dir, origin, axisLen, colour, axisLen * 0.18, axisLen * 0.1));
    const l = label(name);
    l.position.copy(origin).addScaledVector(dir, axisLen * 1.12);
    g.add(l);
  }

  // image layers laid flat on the ground plane
  if (o.images) {
    const loader = new THREE.TextureLoader();
    for (const im of project.images) {
      const s = project.scaleMPerPx;
      const w = im.width * s;
      const h = im.height * s;
      const tex = loader.load(im.dataUrl, () => rig.renderer.render(rig.scene, rig.camera));
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: im.opacity, side: THREE.DoubleSide, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      const cx = (im.x + im.width / 2) * s;
      const cy = (project.canvasH - (im.y + im.height / 2)) * s;
      mesh.position.set(cx, floor - 0.02, -cy);
      g.add(mesh);
    }
  }

  // nodes
  for (const n of sc.nodes) {
    const base = T(n.pos);
    if (n.kind === 'tank') {
      const shellH = Math.max(n.fluidHeightM * 1.25, n.fluidHeightM + 0.5) * o.zExag;
      const fluidH = Math.max(n.fluidHeightM * o.zExag, 0.02);
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(tankR, tankR, shellH, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xaab4c5, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      shell.position.copy(base).add(new THREE.Vector3(0, shellH / 2, 0));
      g.add(shell);
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(shell.geometry, 30), new THREE.LineBasicMaterial({ color: 0x8892a6 }));
      rim.position.copy(shell.position);
      g.add(rim);
      const fluid = new THREE.Mesh(new THREE.CylinderGeometry(tankR * 0.97, tankR * 0.97, fluidH, 32), new THREE.MeshStandardMaterial({ color: 0x3b82d6, transparent: true, opacity: 0.8 }));
      fluid.position.copy(base).add(new THREE.Vector3(0, fluidH / 2, 0));
      g.add(fluid);
    } else {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(tankR * 0.32, 20, 14), new THREE.MeshStandardMaterial({ color: 0xe6edf7 }));
      sphere.position.copy(base);
      g.add(sphere);
    }
    if (o.labels) {
      const l = label(n.name, o.coords ? coordText(n.pos, U) : undefined);
      l.position.copy(base).add(new THREE.Vector3(0, (n.kind === 'tank' ? Math.max(n.fluidHeightM * 1.25, n.fluidHeightM + 0.5) * o.zExag : 0) + tankR * 0.9, 0));
      g.add(l);
    }
  }

  // elements
  for (const e of sc.edges) {
    const a = T(e.a);
    const b = T(e.b);
    const mid = a.clone().lerp(b, 0.5);
    const dir = b.clone().sub(a);
    if (e.kind === 'pipe') {
      const r = Math.max((e.diameterM / 2) * o.pipeExag, span * 0.004);
      g.add(segment(a, b, r, new THREE.MeshStandardMaterial({ color: o.colourByVelocity ? velocityColour(e.velocity, vmax) : 0x6f86a8, metalness: 0.2, roughness: 0.55 })));
    } else {
      g.add(segment(a, b, span * 0.003, new THREE.MeshStandardMaterial({ color: 0x8892a6 })));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      if (e.kind === 'pump') {
        const body = new THREE.Mesh(new THREE.SphereGeometry(tankR * 0.55, 24, 16), new THREE.MeshStandardMaterial({ color: 0xe8743b }));
        body.position.copy(mid);
        g.add(body);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(tankR * 0.32, tankR * 0.8, 16), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        cone.position.copy(mid);
        cone.quaternion.copy(q);
        g.add(cone);
      } else {
        const colour = e.open === false ? 0xe5534b : 0x4c9a6a;
        for (const sign of [1, -1]) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(tankR * 0.4, tankR * 0.7, 16), new THREE.MeshStandardMaterial({ color: colour }));
          cone.position.copy(mid).addScaledVector(dir.clone().normalize(), sign * tankR * 0.35);
          cone.quaternion.copy(q);
          if (sign === 1) cone.rotateX(Math.PI);
          g.add(cone);
        }
      }
    }
    if (o.labels) {
      const l = label(e.name, o.coords ? `${coordText(e.a, U)} → ${coordText(e.b, U)}` : undefined);
      l.position.copy(mid).add(new THREE.Vector3(0, tankR * 0.8, 0));
      g.add(l);
    }
  }
}

function setView(rig: Rig, sc: Scene3D, view: View, o: Options) {
  const c = new THREE.Vector3((sc.min.x + sc.max.x) / 2, ((sc.min.z + sc.max.z) / 2) * o.zExag, -(sc.min.y + sc.max.y) / 2);
  const span = Math.max(sc.max.x - sc.min.x, sc.max.y - sc.min.y, (sc.max.z - sc.min.z) * o.zExag, 10);
  const d = span * 1.15;
  // plan view looks straight down from just south of the centre, so X runs right and Y (north) runs up the screen
  const offset = {
    iso: new THREE.Vector3(0.85, 0.7, 0.85),
    top: new THREE.Vector3(0, 1.5, 0.06),
    front: new THREE.Vector3(0, 0.3, 1.5),
    side: new THREE.Vector3(1.5, 0.3, 0),
  }[view];
  rig.camera.position.copy(c).addScaledVector(offset, d);
  rig.camera.near = Math.max(span / 1000, 0.01);
  rig.camera.far = span * 40;
  rig.camera.updateProjectionMatrix();
  rig.controls.target.copy(c);
  rig.controls.update();
}

export default function View3D({ project, computed }: Props) {
  const U = useUnits();
  const mount = useRef<HTMLDivElement>(null);
  const rig = useRef<Rig | null>(null);
  const [opts, setOpts] = useState<Options>({ labels: true, coords: false, images: true, grid: true, zExag: 1, pipeExag: 10, colourByVelocity: true });
  const [failed, setFailed] = useState<string>();
  const sc = useMemo(() => buildScene(project, computed.result), [project, computed.result]);
  const scRef = useRef(sc);
  scRef.current = sc;
  const optRef = useRef(opts);
  optRef.current = opts;

  // renderer, camera and controls live as long as the page
  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed('WebGL is not available in this browser.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'labels3d';
    host.appendChild(renderer.domElement);
    host.appendChild(labels.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x44485a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(40, 80, 30);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, labels.domElement);
    controls.enableDamping = true;
    const content = new THREE.Group();
    scene.add(content);
    const r: Rig = { renderer, labels, scene, camera, controls, content, fitted: false };
    rig.current = r;

    const resize = () => {
      const w = Math.max(host.clientWidth, 200);
      const h = Math.max(host.clientHeight, 200);
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(content);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labels.domElement);
      rig.current = null;
    };
  }, []);

  // rebuild the contents when the network, options or units change
  useEffect(() => {
    const r = rig.current;
    if (!r) return;
    populate(r, sc, project, opts, U);
    if (!r.fitted) {
      setView(r, sc, 'iso', opts);
      r.fitted = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc, project.images, project.scaleMPerPx, opts, U.system]);

  const jump = (v: View) => rig.current && setView(rig.current, scRef.current, v, optRef.current);
  const toggle = (k: keyof Options) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="view3d">
      <div className="v3-bar">
        <span className="seg" role="group" aria-label="Camera">
          <button onClick={() => jump('iso')}>Isometric</button>
          <button onClick={() => jump('top')}>Plan</button>
          <button onClick={() => jump('front')}>Front</button>
          <button onClick={() => jump('side')}>Side</button>
        </span>
        <label><input type="checkbox" checked={opts.labels} onChange={() => toggle('labels')} /> Names</label>
        <label><input type="checkbox" checked={opts.coords} onChange={() => toggle('coords')} disabled={!opts.labels} /> Coordinates</label>
        <label><input type="checkbox" checked={opts.colourByVelocity} onChange={() => toggle('colourByVelocity')} /> Colour by velocity</label>
        <label><input type="checkbox" checked={opts.images} onChange={() => toggle('images')} /> Images</label>
        <label><input type="checkbox" checked={opts.grid} onChange={() => toggle('grid')} /> Grid</label>
        <label className="slider">Height ×{opts.zExag}<input type="range" min={1} max={10} step={1} value={opts.zExag} onChange={(e) => setOpts((o) => ({ ...o, zExag: Number(e.target.value) }))} /></label>
        <label className="slider">Pipe size ×{opts.pipeExag}<input type="range" min={1} max={40} step={1} value={opts.pipeExag} onChange={(e) => setOpts((o) => ({ ...o, pipeExag: Number(e.target.value) }))} /></label>
      </div>
      <div className="v3-stage" ref={mount} />
      {failed && <div className="banner error">{failed}</div>}

      <div className="below">
        <div className="table-wrap">
          <h3>Nodes</h3>
          <table>
            <thead>
              <tr><th>Node</th><th>Type</th><th>X [{U.u('length')}]</th><th>Y [{U.u('length')}]</th><th>Z [{U.u('elevation')}]</th><th>Fluid height [{U.u('length')}]</th><th>Surface Z [{U.u('elevation')}]</th></tr>
            </thead>
            <tbody>
              {sc.nodes.map((n) => (
                <tr key={n.uid}>
                  <td>{n.name}</td>
                  <td>{n.kind}</td>
                  <td>{U.f('length', n.pos.x, 2)}</td>
                  <td>{U.f('length', n.pos.y, 2)}</td>
                  <td>{U.f('elevation', n.pos.z, 2)}</td>
                  <td>{n.kind === 'tank' ? U.f('length', n.fluidHeightM, 2) : '–'}</td>
                  <td>{n.kind === 'tank' ? U.f('elevation', n.surfaceZ, 2) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <h3>Elements</h3>
          <table>
            <thead>
              <tr><th>Element</th><th>Type</th><th>From</th><th>To</th><th>Start (X, Y, Z)</th><th>End (X, Y, Z)</th><th>Straight [{U.u('length')}]</th><th>Pipe length [{U.u('length')}]</th><th>Ø [{U.u('diameter')}]</th></tr>
            </thead>
            <tbody>
              {sc.edges.map((e) => (
                <tr key={e.uid}>
                  <td>{e.name}</td>
                  <td>{e.kind}</td>
                  <td>{e.fromName}</td>
                  <td>{e.toName}</td>
                  <td>{coordText(e.a, U)}</td>
                  <td>{coordText(e.b, U)}</td>
                  <td>{U.f('length', e.straightM, 2)}</td>
                  <td>{e.lengthM !== undefined ? U.f('length', e.lengthM, 2) : '–'}</td>
                  <td>{e.kind === 'pump' ? '–' : U.f('diameter', e.diameterM * 1000, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
