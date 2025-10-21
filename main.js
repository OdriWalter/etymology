// main.js - entry point tying together world, renderer, input and UI
import { World, TILE_TYPES } from './world.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';

// Parameters for the world grid
const TILE_SIZE = 32;
const COLS = 50;
const ROWS = 50;

const canvas = document.getElementById('canvas');
const world = new World(COLS, ROWS, TILE_SIZE);
const renderer = new Renderer(canvas, world);
const input = new Input(canvas, renderer, world);

// Build the palette of tile types
const paletteDiv = document.getElementById('palette');
for (const key of Object.keys(TILE_TYPES)) {
  const tile = TILE_TYPES[key];
  const btn = document.createElement('button');
  btn.textContent = tile.name;
  btn.style.backgroundColor = tile.color;
  btn.onclick = () => {
    input.currentTileId = tile.id;
    // indicate selected button visually
    Array.from(paletteDiv.children).forEach(child => {
      child.style.outline = '';
    });
    btn.style.outline = '2px solid black';
  };
  paletteDiv.appendChild(btn);
}
// select first tile type by default
paletteDiv.children[0].click();

// Add cart button
const addCartBtn = document.getElementById('addCart');
addCartBtn.onclick = () => {
  const cart = world.addCart();
  world.carts.forEach(c => c.selected = false);
  cart.selected = true;
};

// Play/pause button
const playPauseBtn = document.getElementById('playPause');
let playing = false;
playPauseBtn.onclick = () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? 'Pause' : 'Play';
};

// Save button
const saveBtn = document.getElementById('saveBtn');
saveBtn.onclick = () => {
  const data = world.serialize();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'world.json';
  a.click();
  URL.revokeObjectURL(url);
};

// Load button
const loadBtn = document.getElementById('loadBtn');
const loadInput = document.getElementById('loadInput');
loadBtn.onclick = () => {
  loadInput.value = '';
  loadInput.click();
};
loadInput.onchange = () => {
  const file = loadInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      world.deserialize(data);
    } catch (ex) {
      alert('Failed to load world: ' + ex.message);
    }
  };
  reader.readAsText(file);
};

// Main animation loop
let lastTime = performance.now();
function loop(time) {
  const dt = (time - lastTime) / 1000;
  lastTime = time;
  if (playing) {
    world.update(dt);
  }
  renderer.draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);