import * as THREE from "three";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import type { Look } from "../../shared/protocol.js";
import { HAIR_COLORS, HAIR_STYLES, SHIRT_COLORS, SKIN_TONES } from "../../shared/protocol.js";
import { Person } from "../scene/characters.js";
import { openModal } from "./modal.js";

/**
 * "Pick your character": your name, skin tone, hair and shirt, with a 3D
 * preview you can drag to spin. Resolves once you enter the office.
 */

const ADJ = ["Humble", "Brave", "Sunny", "Clever", "Cozy", "Swift", "Jolly", "Calm", "Witty", "Bold"];
const ANIMAL = ["Newt", "Otter", "Fox", "Panda", "Koala", "Heron", "Badger", "Lynx", "Moose", "Gecko"];
const pickOne = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const HAIR_LABEL: Record<string, string> = {
  short: "Short",
  long: "Long",
  bun: "Bun",
  spiky: "Spiky",
  curly: "Curly",
  ponytail: "Ponytail",
  bald: "Bald",
};

export function pickCharacter(name: string, look: Look): Promise<{ name: string; look: Look }> {
  return new Promise((resolve) => {
    const cur: Look = { ...look };
    const body = document.createElement("div");
    body.className = "charsel";
    body.innerHTML = `
      <div class="charsel-preview"><canvas></canvas><span>Drag to spin</span></div>
      <div class="charsel-opts">
        <label>Your name</label>
        <div class="webhook"><input type="text" maxlength="24" class="name" /><button class="btn dice" title="Random name">🎲</button></div>
        <label>Skin tone</label><div class="swatches skin"></div>
        <label>Hair</label><div class="seg hair"></div>
        <label>Hair color</label><div class="swatches hair-color"></div>
        <label>Shirt</label><div class="swatches shirt"></div>
      </div>`;
    const footer = document.createElement("div");
    footer.style.display = "contents";
    footer.innerHTML = `<button class="btn surprise">🎲 Surprise me</button><span class="grow"></span><button class="btn primary enter">Enter the office 🚪</button>`;

    const input = body.querySelector<HTMLInputElement>(".name")!;
    input.value = name || `${pickOne(ADJ)} ${pickOne(ANIMAL)}`;

    // The preview: its own little renderer and a person turning slowly.
    const canvas = body.querySelector("canvas")!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const effect = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.17, 0.18, 0.26] });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#fff5e6", "#c9a27a", 1.6));
    const sun = new THREE.DirectionalLight("#fff1d6", 1.6);
    sun.position.set(2, 4, 5);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(32, 0.75, 0.1, 50);
    camera.position.set(0, 1.3, 4.6);
    camera.lookAt(0, 1.05, 0);
    const person = new Person("", cur, { tag: false });
    scene.add(person.root);
    let spin = 0.35;
    let dragging = false;
    let lastX = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      spin += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
    });
    canvas.addEventListener("pointerup", () => (dragging = false));
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!dragging) spin += dt * 0.5;
      person.root.rotation.y = Math.sin(spin) * 0.9;
      person.update(dt, 0);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w && h && (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio()))) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      effect.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const swatches = (sel: string, colors: readonly string[], key: "skin" | "hairColor" | "shirt") => {
      const el = body.querySelector<HTMLElement>(sel)!;
      el.innerHTML = colors.map((c, i) => `<button class="swatch" data-i="${i}" style="background:${c}" aria-label="${key} ${i + 1}"></button>`).join("");
      el.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>(".swatch");
        if (!b) return;
        cur[key] = Number(b.dataset.i);
        refresh();
      });
    };
    swatches(".skin", SKIN_TONES, "skin");
    swatches(".hair-color", HAIR_COLORS, "hairColor");
    swatches(".shirt", SHIRT_COLORS, "shirt");
    const hairEl = body.querySelector<HTMLElement>(".hair")!;
    hairEl.innerHTML = HAIR_STYLES.map((h) => `<button class="btn chip" data-h="${h}">${HAIR_LABEL[h]}</button>`).join("");
    hairEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-h]");
      if (!b) return;
      cur.hair = b.dataset.h as Look["hair"];
      refresh();
    });

    const refresh = () => {
      person.setLook(cur);
      const mark = (sel: string, i: number) =>
        body.querySelectorAll<HTMLElement>(`${sel} .swatch`).forEach((s) => s.classList.toggle("sel", Number(s.dataset.i) === i));
      mark(".skin", cur.skin);
      mark(".hair-color", cur.hairColor);
      mark(".shirt", cur.shirt);
      hairEl.querySelectorAll<HTMLElement>("[data-h]").forEach((b) => b.classList.toggle("on", b.dataset.h === cur.hair));
    };
    refresh();

    body.querySelector(".dice")!.addEventListener("click", () => {
      input.value = `${pickOne(ADJ)} ${pickOne(ANIMAL)}`;
    });
    footer.querySelector(".surprise")!.addEventListener("click", () => {
      cur.skin = Math.floor(Math.random() * SKIN_TONES.length);
      cur.hair = pickOne(HAIR_STYLES);
      cur.hairColor = Math.floor(Math.random() * HAIR_COLORS.length);
      cur.shirt = Math.floor(Math.random() * SHIRT_COLORS.length);
      refresh();
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      renderer.dispose();
      person.dispose();
      resolve({ name: input.value.trim().slice(0, 24) || "Guest", look: { ...cur } });
    };
    const modal = openModal({
      title: "Pick your character",
      icon: "👋",
      className: "charpick",
      body,
      footer,
      onClose: finish,
    });
    footer.querySelector(".enter")!.addEventListener("click", () => modal.close());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") modal.close();
    });
    setTimeout(() => input.select(), 0);
  });
}
