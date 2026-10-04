import type { Deck, DeckSlide, Goal } from "../../shared/progress.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/loop.css";

/**
 * Research deliverables as slide decks: a viewer (16:9 slides, thumbnails,
 * arrow keys, full-screen presenting with speaker notes), downloads as
 * PowerPoint and Markdown, and a painter that draws a slide onto a canvas for
 * the screens in the 3D office.
 */

const INK = "#2b2d42";
const PAPER = "#fffaf3";
const MUTED = "#7a6f65";
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
/** A color per slide, cycled, for the band across the top. */
const BANDS = ["#ff8a5b", "#5bc0eb", "#06d6a0", "#9b5de5", "#ffd166", "#ef476f"];

// ---------------------------------------------------------------------------
// Painting a slide onto a canvas (3D screens)
// ---------------------------------------------------------------------------

const images = new Map<string, HTMLImageElement | "loading" | "failed">();

/**
 * Draw a slide in the deck style. Images load in the background (CORS only,
 * so the canvas stays usable as a WebGL texture); `onImage` is called once one
 * arrives so the caller can repaint.
 */
export function paintDeckSlide(
  c: HTMLCanvasElement,
  slide: DeckSlide | null,
  index: number,
  total: number,
  opts: { deckTitle?: string; onImage?: () => void } = {},
): void {
  const g = c.getContext("2d")!;
  const w = c.width;
  const h = c.height;
  const u = w / 1000;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, w, h);
  if (!slide) {
    g.fillStyle = INK;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${44 * u}px ${F}`;
    g.fillText("📊 No slides yet", w / 2, h / 2 - 20 * u);
    g.fillStyle = MUTED;
    g.font = `700 ${24 * u}px ${F}`;
    g.fillText("Workers write the deck as they research", w / 2, h / 2 + 26 * u);
    return;
  }
  const band = BANDS[index % BANDS.length];
  g.fillStyle = band;
  g.fillRect(0, 0, w, 16 * u);
  const cover = index === 0;

  let img: HTMLImageElement | null = null;
  if (slide.image) {
    const hit = images.get(slide.image);
    if (hit instanceof HTMLImageElement) img = hit;
    else if (!hit) {
      images.set(slide.image, "loading");
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => {
        images.set(slide.image!, el);
        opts.onImage?.();
      };
      el.onerror = () => images.set(slide.image!, "failed");
      el.src = slide.image;
    }
  }

  const pad = 56 * u;
  const textW = img ? w * 0.56 - pad : w - pad * 2;
  g.textAlign = cover ? "center" : "left";
  g.textBaseline = "top";
  g.fillStyle = INK;
  const titleSize = (cover ? 60 : 46) * u;
  g.font = `900 ${titleSize}px ${F}`;
  const titleLines = wrap(g, slide.title, cover && !img ? w - pad * 2 : textW, 2);
  let y = cover ? h * 0.3 : 48 * u;
  const tx = cover && !img ? w / 2 : pad;
  for (const line of titleLines) {
    g.fillText(line, tx, y);
    y += titleSize * 1.15;
  }
  if (!cover) {
    g.fillStyle = band;
    g.fillRect(pad, y + 6 * u, 90 * u, 7 * u);
  }
  y += 34 * u;

  g.font = `700 ${(cover ? 28 : 27) * u}px ${F}`;
  const lh = (cover ? 28 : 27) * u * 1.35;
  for (const b of slide.bullets) {
    if (y > h - 90 * u) break;
    g.fillStyle = cover ? MUTED : INK;
    const lines = wrap(g, b, textW - 34 * u, 3);
    if (!cover) {
      g.beginPath();
      g.arc(pad + 9 * u, y + lh / 2 - 2 * u, 7 * u, 0, Math.PI * 2);
      g.fillStyle = band;
      g.fill();
      g.fillStyle = INK;
    }
    for (const line of lines) {
      g.fillText(line, cover && !img ? w / 2 : pad + (cover ? 0 : 30 * u), y);
      y += lh;
    }
    y += 8 * u;
  }

  if (img) {
    const bx = w * 0.6;
    const bw = w * 0.4 - pad;
    const bh = h - 150 * u;
    const s = Math.min(bw / img.width, bh / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    g.drawImage(img, bx + (bw - iw) / 2, 70 * u + (bh - ih) / 2, iw, ih);
  }

  g.textAlign = "right";
  g.textBaseline = "alphabetic";
  g.fillStyle = MUTED;
  g.font = `800 ${18 * u}px ${F}`;
  g.fillText(`${opts.deckTitle ? opts.deckTitle + "  ·  " : ""}${index + 1} / ${total}`, w - 28 * u, h - 22 * u);
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (g.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && cur) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "…");
  return lines;
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

let open: { goalId: string; refresh: (goal: Goal) => void } | null = null;

/** Keep an open viewer in step as workers add slides. */
export function refreshDeck(goals: Goal[]): void {
  if (!open) return;
  const g = goals.find((x) => x.id === open!.goalId);
  if (g) open.refresh(g);
}

function slideHtml(s: DeckSlide, i: number, total: number, deckTitle: string): string {
  const band = BANDS[i % BANDS.length];
  const cover = i === 0;
  return `<div class="slide ${cover ? "cover" : ""} ${s.image ? "has-img" : ""}" style="--band:${band}">
    <div class="s-text">
      <h2>${esc(s.title)}</h2>
      ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    </div>
    ${s.image ? `<img src="${esc(s.image)}" alt="" referrerpolicy="no-referrer" />` : ""}
    <span class="s-num">${esc(deckTitle)} · ${i + 1} / ${total}</span>
  </div>`;
}

/** Open a research goal's deck. */
export function openDeck(goal: Goal, start = 0): void {
  let deck: Deck | null = goal.deck;
  let i = Math.max(0, Math.min(start, (deck?.slides.length ?? 1) - 1));
  let title = goal.title;
  const body = document.createElement("div");
  body.className = "deck";
  body.innerHTML = `
    <div class="deck-stage"><div class="deck-slide"></div>
      <button class="deck-nav prev" aria-label="Previous slide">‹</button>
      <button class="deck-nav next" aria-label="Next slide">›</button>
    </div>
    <p class="deck-notes"></p>
    <div class="deck-thumbs"></div>`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow deck-meta"></span>
    <button class="btn small md">⬇ Markdown</button>
    <button class="btn small pptx">⬇ PowerPoint</button>
    <button class="btn primary present">▶ Present</button>`;
  const stage = body.querySelector<HTMLElement>(".deck-stage")!;
  const slideEl = body.querySelector<HTMLElement>(".deck-slide")!;
  const notesEl = body.querySelector<HTMLElement>(".deck-notes")!;
  const thumbs = body.querySelector<HTMLElement>(".deck-thumbs")!;
  const meta = footer.querySelector<HTMLElement>(".deck-meta")!;

  const render = (thumbsToo = false) => {
    const slides = deck?.slides ?? [];
    if (!slides.length) {
      slideEl.innerHTML = `<div class="slide cover"><div class="s-text"><h2>📊 No slides yet</h2><ul><li>Workers on this goal write the deck as they research.</li></ul></div></div>`;
      notesEl.textContent = "";
      thumbs.innerHTML = "";
      meta.textContent = "";
      return;
    }
    i = Math.max(0, Math.min(i, slides.length - 1));
    slideEl.innerHTML = slideHtml(slides[i], i, slides.length, title);
    notesEl.textContent = slides[i].notes ? `🗒 ${slides[i].notes}` : "";
    if (thumbsToo || thumbs.children.length !== slides.length) {
      thumbs.innerHTML = slides
        .map((s, k) => `<button class="thumb" data-i="${k}" title="${esc(s.title)}"><b>${k + 1}</b><span>${esc(s.title)}</span></button>`)
        .join("");
    }
    thumbs.querySelectorAll<HTMLElement>(".thumb").forEach((t) => t.classList.toggle("on", Number(t.dataset.i) === i));
    thumbs.querySelector<HTMLElement>(".thumb.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    meta.textContent = `${slides.length} slides${deck ? ` · updated ${new Date(deck.updatedAt).toLocaleTimeString()}` : ""}`;
  };
  const go = (d: number) => {
    i += d;
    render();
  };

  let modal: Modal | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (!modal) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") go(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);
  modal = openModal({
    title: `${goal.kind === "research" ? "📊" : "🖼"} ${goal.title}`,
    className: "deck-modal",
    body,
    footer,
    onClose: () => {
      window.removeEventListener("keydown", onKey, true);
      if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
      modal = null;
      open = null;
    },
  });
  open = {
    goalId: goal.id,
    refresh: (g) => {
      deck = g.deck;
      title = g.title;
      render(true);
    },
  };
  body.querySelector(".prev")!.addEventListener("click", () => go(-1));
  body.querySelector(".next")!.addEventListener("click", () => go(1));
  thumbs.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
    if (!t) return;
    i = Number(t.dataset.i);
    render();
  });
  footer.querySelector(".present")!.addEventListener("click", () => {
    void stage.requestFullscreen?.().catch(() => {});
  });
  footer.querySelector(".md")!.addEventListener("click", () => {
    if (deck) download(`${slug(title)}.md`, new Blob([deckToMarkdown(title, deck.slides)], { type: "text/markdown" }));
  });
  const pptxBtn = footer.querySelector<HTMLButtonElement>(".pptx")!;
  pptxBtn.addEventListener("click", async () => {
    if (!deck?.slides.length) return;
    pptxBtn.disabled = true;
    pptxBtn.textContent = "Building…";
    try {
      await exportPptx(title, goal.why, deck.slides);
    } catch (err) {
      console.error(err);
      pptxBtn.textContent = "Export failed";
      setTimeout(() => (pptxBtn.textContent = "⬇ PowerPoint"), 2500);
      pptxBtn.disabled = false;
      return;
    }
    pptxBtn.disabled = false;
    pptxBtn.textContent = "⬇ PowerPoint";
  });
  render(true);
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export function deckToMarkdown(title: string, slides: DeckSlide[]): string {
  const parts = slides.map((s) => {
    const lines = [`# ${s.title}`, ""];
    for (const b of s.bullets) lines.push(`- ${b}`);
    if (s.image) lines.push("", `![](${s.image})`);
    if (s.notes) lines.push("", `Note: ${s.notes}`);
    return lines.join("\n");
  });
  return `<!-- ${title} -->\n\n${parts.join("\n\n---\n\n")}\n`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "deck";
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const hex = (c: string) => c.replace("#", "").toUpperCase();

/** Build the deck as a .pptx in the office's look and save it. */
export async function exportPptx(title: string, subtitle: string, slides: DeckSlide[]): Promise<void> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const build = (withImages: boolean) => {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
    pptx.title = title;
    pptx.company = "domain";
    const font = "Nunito";
    slides.forEach((s, i) => {
      const band = hex(BANDS[i % BANDS.length]);
      const slide = pptx.addSlide();
      slide.background = { color: hex(PAPER) };
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.16, fill: { color: band }, line: { color: band } });
      const img = withImages && s.image ? s.image : null;
      const textW = img ? 7.4 : 12.1;
      if (i === 0) {
        slide.addText(s.title, { x: 0.6, y: 2.2, w: img ? textW : 12.1, h: 1.6, fontFace: font, fontSize: 44, bold: true, color: hex(INK), align: img ? "left" : "center", valign: "middle" });
        const sub = s.bullets.length ? s.bullets.join("\n") : subtitle;
        if (sub) slide.addText(sub, { x: 0.6, y: 3.9, w: img ? textW : 12.1, h: 1.4, fontFace: font, fontSize: 20, color: hex(MUTED), align: img ? "left" : "center", valign: "top" });
      } else {
        slide.addText(s.title, { x: 0.6, y: 0.45, w: textW, h: 1.0, fontFace: font, fontSize: 32, bold: true, color: hex(INK), valign: "middle" });
        slide.addShape(pptx.ShapeType.rect, { x: 0.65, y: 1.5, w: 1.0, h: 0.07, fill: { color: band }, line: { color: band } });
        if (s.bullets.length) {
          slide.addText(
            s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })),
            { x: 0.6, y: 1.8, w: textW, h: 5.0, fontFace: font, fontSize: 20, color: hex(INK), valign: "top" },
          );
        }
      }
      if (img) slide.addImage({ path: img, x: 8.3, y: 1.6, w: 4.5, h: 4.5, sizing: { type: "contain", w: 4.5, h: 4.5 } });
      slide.addText(`${i + 1} / ${slides.length}`, { x: 11.3, y: 6.95, w: 1.8, h: 0.4, fontFace: font, fontSize: 11, color: hex(MUTED), align: "right" });
      if (s.notes) slide.addNotes(s.notes);
    });
    return pptx;
  };
  const name = `${slug(title)}.pptx`;
  try {
    await build(true).writeFile({ fileName: name });
  } catch {
    // An image that can't be fetched (CORS, offline) fails the whole file: try without.
    await build(false).writeFile({ fileName: name });
  }
}

