// Page controller: loads the catalog and images, owns what's on screen (garment, branch, skin colour),
// turns clicks into Outfit changes and redraws. Data, rules, ordering and drawing live in their own modules.

import { GARMENTS, GARMENT_LABEL, TEMPLATE, SHOWCASE } from "./config.js";
import { loadCatalog, parseName } from "./catalog.js";
import { Outfit } from "./outfit.js";
import { outfitWarnings, plateCount, rankForPlates, PLATE, RANK_PLATES, isArmour } from "./rules.js";
import { loadImage, forgetImage, drawTemplate, drawShowcase, newCanvas, canvasBlob, layersZip, saveBlob } from "./render.js";
import { itemSections, customSection, updateCounts, updateCustomPositions, branchButtons, filterList, syncPicks, loadError } from "./ui.js";

const $ = id => document.getElementById(id);
const view = { garment: "shirt", branch: null, skin: SHOWCASE.skinDefault, query: "", filter: "all" };
const addMsg = { shirt: "", pants: "" };
const templates = { shirt: newCanvas(), pants: newCanvas() };     // off-screen, for the showcase
const images = new Map();                                          // src -> loaded image
let catalog = null, outfit = null, ready = false;
const branchOf = name => catalog.branches.find(b => b.name === name);
const fileName = kind => `${view.branch} ${kind}.png`;

// ---- Loading -------------------------------------------------------------------------------------------
// Only what the first screen needs loads before the page is ready: the branch's frames and showcase card and
// the ticked items. Other images load when they're needed (a tick, another branch), and the current branch's
// items load quietly in the background. The item list uses small thumbnails.

const failed = new Set();          // images that couldn't load
const brokenItems = [];            // names of items dropped because their image failed

async function start() {
  ready = false;
  setDownloads(false);
  $("count").textContent = "Loading layers…";
  $("list").replaceChildren(Object.assign(document.createElement("p"), { className: "msg", textContent: "Loading items…" }));
  try {
    catalog = await loadCatalog();
  } catch (e) {
    $("count").textContent = "";
    $("list").replaceChildren(loadError(`${e.message} Reload the page or try again.`, start));
    return;
  }
  if (!GARMENTS.some(g => catalog.garments[g].items.length)) {
    $("count").textContent = "";
    $("list").replaceChildren(loadError("No items were found. The Drive update may not have run yet.", start));
    return;
  }
  outfit = new Outfit(catalog);
  $("branches").replaceChildren(...branchButtons(catalog.branches, setBranch));
  setBranch(catalog.branches[0].name, { defaults: true });
  await ensure(needed());
  ready = true;
  if (!dropBrokenItems()) renderList();
  await refresh();
  setDownloads(true);
  prefetch();
}

// Everything drawing needs right now: the branch's frames and card, and every ticked layer of both garments.
function needed() {
  const b = branchOf(view.branch);
  return [b.showcase, ...GARMENTS.map(g => b.frame[g]), ...GARMENTS.flatMap(g => outfit.stack(g, view.branch).map(l => l.src))];
}
const allLoaded = () => needed().every(s => images.has(s) || failed.has(s));

// Loads for what's on screen (ticks, branch switches) count as "wanted"; background loading waits for them.
let wanted = 0, wantedDone = Promise.resolve(), wantedEnd = () => {};
async function ensure(srcs, priority = "high") {
  const missing = [...new Set(srcs)].filter(s => s && !images.has(s) && !failed.has(s));
  if (!missing.length) return;
  if (priority === "high" && wanted++ === 0) wantedDone = new Promise(r => { wantedEnd = r; });
  try {
    const loaded = await Promise.all(missing.map(s => loadImage(s, priority)));
    missing.forEach((s, i) => loaded[i] ? images.set(s, loaded[i]) : failed.add(s));
  } finally {
    if (priority === "high" && --wanted === 0) wantedEnd();
  }
}

// The rest of this branch's items for this garment, a few at a time, so ticking them is instant.
// It pauses whenever something the player just picked is loading, so that goes first.
let prefetchRun = 0;
async function prefetch() {
  const run = ++prefetchRun, g = view.garment;
  const todo = catalog.garments[g].items.filter(l => l.branch === view.branch && !images.has(l.src) && !failed.has(l.src)).map(l => l.src);
  for (let i = 0; i < todo.length && run === prefetchRun; i += 4) {
    while (wanted) await wantedDone;
    await ensure(todo.slice(i, i + 4), "low");
    if (todo.slice(i, i + 4).some(s => failed.has(s))) dropBrokenItems();   // hide it before anyone ticks it
  }
}

// Items whose image failed are unticked and hidden, and reported. Returns true if the list was redrawn.
function dropBrokenItems() {
  let dropped = false;
  for (const g of GARMENTS) {
    const gar = catalog.garments[g];
    for (const l of gar.items) if (failed.has(l.src)) { brokenItems.push(l.label); outfit.on[g].delete(l.id); dropped = true; }
    if (!dropped) continue;
    gar.items = gar.items.filter(l => !failed.has(l.src));
    for (const s of gar.sections) s.items = s.items.filter(l => !failed.has(l.src));
  }
  const brokenArt = catalog.branches.flatMap(b => [[b.showcase, `${b.name} showcase card`], ...GARMENTS.map(g => [b.frame[g], `${b.name} ${g} frame`])])
    .filter(([src]) => failed.has(src)).map(([, what]) => what);
  const n = brokenItems.length;
  showNotice([
    n ? `${n} item${n === 1 ? "" : "s"} couldn't load and ${n === 1 ? "is" : "are"} hidden: ${brokenItems.join(", ")}.` : "",
    brokenArt.length ? `Couldn't load the ${brokenArt.join(", ")}.` : "",
  ].filter(Boolean).join(" ") + (n || brokenArt.length ? " Reload the page to try again." : ""));
  if (dropped) renderList();
  return dropped;
}

function showNotice(text) {
  $("notice").hidden = !text;
  $("notice").textContent = text;
}

function setDownloads(on) {
  $("save").disabled = $("save-layers").disabled = !on;
  if (on && !frameImage(view.garment)) $("save").disabled = true;
  $("save-sc").disabled = !on || !images.has(branchOf(view.branch)?.showcase);
}

// ---- Drawing -------------------------------------------------------------------------------------------

const frameImage = g => images.get(branchOf(view.branch).frame[g]);

// Counts and warnings update at once; the preview and showcase redraw once their images are in.
// The returned promise resolves after that redraw, so downloads can wait for it.
async function refresh() {
  if (!ready) return;
  const g = view.garment;
  showStatus();
  updateCounts(document, id => outfit.on[g].has(id));
  updateCustomPositions($("mine"), outfit.stack(g, view.branch));
  if (!allLoaded()) await ensure(needed());
  // An item whose image failed (now or in the background) is unticked before drawing; drawing it would fail.
  if (needed().some(s => failed.has(s))) dropBrokenItems();
  draw();
}

function draw() {
  if (!ready || !allLoaded()) return;          // a later refresh draws once the rest is in
  const g = view.garment;
  drawTemplate($("out"), outfit.stack(g, view.branch), images, frameImage(g));
  $("save").disabled = !frameImage(g);           // never hand out a template without its frame
  showShowcase();
}

function showShowcase() {
  if (!ready || !allLoaded()) return;
  const card = images.get(branchOf(view.branch).showcase);
  $("save-sc").disabled = !card;
  if (!card) { $("sc").getContext("2d").clearRect(0, 0, SHOWCASE.w, SHOWCASE.h); return; }
  for (const g of GARMENTS) drawTemplate(templates[g], outfit.stack(g, view.branch), images, frameImage(g));
  drawShowcase($("sc"), card, view.skin, templates);
}

function showStatus() {
  const g = view.garment, isOn = l => outfit.isOn(l);
  const n = outfit.items(g).filter(isOn).length;
  const { messages, flagged } = outfitWarnings({
    branches: catalog.branches,
    allItems: GARMENTS.flatMap(x => catalog.garments[x].items),
    garmentItems: outfit.items(g),
    isOn,
  });
  // Plates across the whole outfit (shirt and pants, every branch); warn past the 24-piece maximum.
  const plates = plateCount(GARMENTS.flatMap(x => catalog.garments[x].items), isOn), rank = rankForPlates(plates);
  if (plates > PLATE.full) messages.push(`This outfit has ${plates} plates. The most anyone can wear is ${PLATE.full} (a full harness).`);
  $("count").innerHTML = `${n} item${n === 1 ? "" : "s"} on` + (messages.length ? `<span class="pill">Conflict</span>` : "");
  $("plate-num").textContent = plates;
  $("plate-word").textContent = plates === 1 ? "plate" : "plates";
  $("plate-rank").textContent = rank || "Over max";
  $("plate-meter").setAttribute("aria-valuenow", Math.min(plates, PLATE.full));
  $("plate-meter").classList.toggle("over", !rank);
  $("plate-fill").style.width = `${Math.min(plates / PLATE.full, 1) * 100}%`;
  // The same numbers in the small bar pinned over the item list on phones.
  document.querySelector(".mini-num").textContent = plates;
  document.querySelector(".mini-word").textContent = plates === 1 ? "plate" : "plates";
  document.querySelector(".mini-rank").textContent = rank || "Over max";
  document.querySelector(".mini-track").classList.toggle("over", !rank);
  document.querySelector(".mini-fill").style.width = $("plate-fill").style.width;
  $("warn").hidden = !messages.length;
  $("warn").textContent = messages.join(" ");
  const ids = new Set([...flagged].map(l => l.id));
  document.querySelectorAll(".row[data-id]").forEach(r => r.classList.toggle("clash", ids.has(+r.dataset.id)));
}

// ---- Lists ---------------------------------------------------------------------------------------------

function renderList() {
  const g = view.garment;
  const sections = catalog.garments[g].sections.filter(s => s.branch === view.branch);
  $("list").replaceChildren(...itemSections(sections, {
    isOn: l => outfit.isOn(l),
    groupIsEmpty: group => outfit.groupIsEmpty(g, group),
    onToggle: (l, on) => { outfit.set(l, on); syncPicks($("list"), id => outfit.on[g].has(id)); refresh(); },
    onGroupNone: group => { outfit.clearGroup(g, group); syncPicks($("list"), id => outfit.on[g].has(id)); refresh(); },
  }));
  $("mine").replaceChildren(customSection({
    title: `Custom ${GARMENT_LABEL[g]} Layers`,
    garment: g,
    size: TEMPLATE,
    items: [...outfit.custom[g]].sort((a, b) => a.id - b.id),     // newest first
    message: addMsg[g],
    isOn: l => outfit.isOn(l),
    onAdd: files => addCustom(g, files),
    onToggle: (l, on) => { outfit.set(l, on); refresh(); },
    onMove: (l, dir) => { if (outfit.moveCustom(l, dir, view.branch)) refresh(); },
    onRemove: l => {
      outfit.removeCustom(l);
      images.delete(l.src);
      forgetImage(l.src);
      URL.revokeObjectURL(l.src);
      addMsg[g] = "";
      renderList();
      refresh();
      $("mine").querySelector(".add-btn").focus();
    },
  }));
  applyFilter();
}

// Search box and All / Armour / Clothing / Ticked only. Runs when the list is rebuilt or the filter changes,
// not on every tick, so an item doesn't vanish under "Ticked only" the moment it's unticked.
function applyFilter() {
  const byId = new Map(catalog.garments[view.garment].items.map(l => [l.id, l]));
  const q = view.query.trim().toLowerCase(), f = view.filter;
  const filtering = !!q || f !== "all";
  const shown = filterList($("list"), id => {
    const l = byId.get(id);
    if (!l) return true;
    if (q && !`${l.label} ${l.tags.join(" ")}`.toLowerCase().includes(q)) return false;
    if (f === "armour") return isArmour(l);
    if (f === "clothing") return !isArmour(l);
    if (f === "on") return outfit.isOn(l);
    return true;
  }, filtering);
  $("no-match").hidden = !(filtering && shown === 0);
}

async function addCustom(g, files) {
  const errors = [];
  for (const file of files) {
    if (file.type !== "image/png") { errors.push(`${file.name} isn't a PNG.`); continue; }
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (!img || img.naturalWidth !== TEMPLATE.w || img.naturalHeight !== TEMPLATE.h) {
      errors.push(img ? `${file.name} is ${img.naturalWidth}×${img.naturalHeight}; it must be ${TEMPLATE.w}×${TEMPLATE.h}.` : `${file.name} couldn't be read.`);
      URL.revokeObjectURL(url);
      continue;
    }
    const name = file.name.replace(/\.png$/i, "");
    images.set(url, img);
    outfit.addCustom(g, { name, src: url, parsed: parseName(name) });
  }
  addMsg[g] = errors.join(" ");
  if (view.garment === g) { renderList(); refresh(); }
}

// ---- Controls ------------------------------------------------------------------------------------------

function setGarment(g) {
  view.garment = g;
  document.querySelectorAll(".switch button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.file === g)));
  if (!outfit) return;
  renderList();
  refresh();
  if (ready) prefetch();
}

// Switching branch shows its items and frame; ticked items stay ticked (one shared outfit).
function setBranch(b, { defaults = false } = {}) {
  view.branch = b;
  document.querySelectorAll("#branches button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.branch === b)));
  $("defaults").textContent = `Use ${b} defaults`;
  $("defaults").title = `Replace the outfit with the ${b} default uniform on both the shirt and the pants. Your own PNGs stay.`;
  if (defaults) outfit.useDefaults(b);
  renderList();
  refresh();
  if (ready) prefetch();
}

document.querySelectorAll(".switch button").forEach(b => b.addEventListener("click", () => setGarment(b.dataset.file)));

$("search").addEventListener("input", e => { view.query = e.target.value; if (outfit) applyFilter(); });
document.querySelectorAll(".filters button").forEach(b => b.addEventListener("click", () => {
  view.filter = b.dataset.filter;
  document.querySelectorAll(".filters button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  if (outfit) applyFilter();
}));

// Rank marks under the plate bar (LR3 at 4 plates … HR3 at 24).
$("plate-ladder").replaceChildren(...RANK_PLATES.filter(([max]) => max > 0).map(([max, rank]) =>
  Object.assign(document.createElement("span"), { textContent: rank, style: `left: ${max / PLATE.full * 100}%` })));

// The pinned header's height, so the sticky preview column sits just under it.
new ResizeObserver(() => document.documentElement.style.setProperty("--head-h", `${$("top").offsetHeight}px`)).observe($("top"));

$("defaults").addEventListener("click", () => { if (!outfit) return; outfit.useDefaults(view.branch); renderList(); refresh(); });
$("clear").addEventListener("click", () => { if (!outfit) return; outfit.clearItems(); renderList(); refresh(); });

$("skin").addEventListener("input", e => {
  const v = e.target.value.trim().replace(/^#?/, "#");
  const ok = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
  e.target.setAttribute("aria-invalid", String(!ok));
  if (ok) { view.skin = v; showShowcase(); }
});

$("save").addEventListener("click", async () => {
  await refresh();
  saveBlob(await canvasBlob($("out")), fileName(GARMENT_LABEL[view.garment]));
});

$("save-sc").addEventListener("click", async () => {
  await refresh();
  saveBlob(await canvasBlob($("sc")), fileName("Showcase"));
});

// Ticked items (not the frame) as full-size PNGs in a .zip, numbered from the bottom layer (01) up.
$("save-layers").addEventListener("click", async () => {
  const msg = $("msg"), btn = $("save-layers"), g = view.garment;
  await refresh();
  const layers = outfit.stack(g, view.branch);
  msg.hidden = true;
  if (!layers.length) { msg.hidden = false; msg.textContent = "Tick at least one item to download its layers."; return; }
  btn.disabled = true;
  try {
    saveBlob(await layersZip(layers, images), fileName(GARMENT_LABEL[g]).replace(".png", " layers.zip"));
  } catch (e) {
    msg.hidden = false;
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

start();
