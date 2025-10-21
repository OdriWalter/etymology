// main.js - entry point tying together world, renderer, input and UI
import { World, DEFAULT_WORLD_SEED } from './world.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { loadAssets } from './assets.js';

const COLS = 50;
const ROWS = 50;

function populatePaletteUI(palette, input) {
  const paletteDiv = document.getElementById('palette');
  paletteDiv.innerHTML = '';
  palette.tiles.forEach((tile) => {
    const btn = document.createElement('button');
    btn.textContent = tile.name;
    btn.style.backgroundColor = tile.color;
    btn.onclick = () => {
      input.currentTileId = tile.id;
      Array.from(paletteDiv.children).forEach(child => {
        child.style.outline = '';
      });
      btn.style.outline = '2px solid black';
    };
    paletteDiv.appendChild(btn);
  });
  if (paletteDiv.children.length > 0) {
    paletteDiv.children[0].click();
  }
}

async function init() {
  try {
    const { palette, glyphs } = await loadAssets();
    const canvas = document.getElementById('canvas');
    const seedInput = document.getElementById('seedInput');
    const applySeedBtn = document.getElementById('applySeed');
    const randomSeedBtn = document.getElementById('randomSeed');

    const initialSeedValue = seedInput && seedInput.value.trim() !== ''
      ? seedInput.value.trim()
      : DEFAULT_WORLD_SEED;

    const world = new World(COLS, ROWS, palette, undefined, initialSeedValue);
    if (seedInput) {
      seedInput.value = world.seed.toString();
    }
    const renderer = new Renderer(canvas, world, glyphs);
    const input = new Input(canvas, renderer, world);
    input.currentTileId = palette.defaultTileId;

    populatePaletteUI(palette, input);

    const updateSeedUI = () => {
      if (seedInput) {
        seedInput.value = world.seed.toString();
      }
      renderer.draw();
    };

    const applySeedFromInput = () => {
      if (!seedInput) return;
      const raw = seedInput.value.trim();
      if (raw === '') return;
      const numeric = Number(raw);
      const nextSeed = Number.isFinite(numeric) ? numeric : raw;
      world.setSeed(nextSeed);
      updateSeedUI();
    };

    if (applySeedBtn) {
      applySeedBtn.onclick = () => {
        applySeedFromInput();
      };
    }

    if (seedInput) {
      seedInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          applySeedFromInput();
        }
      });
    }

    if (randomSeedBtn) {
      randomSeedBtn.onclick = () => {
        const randomSeed = Math.floor(Math.random() * 0xffffffff);
        world.setSeed(randomSeed);
        updateSeedUI();
      };
    }

    // Add cart button
    const addCartBtn = document.getElementById('addCart');
    addCartBtn.onclick = () => {
      const cart = world.addCart();
      world.carts.forEach(c => c.selected = false);
      cart.selected = true;
    };

    const fillAllBtn = document.getElementById('fillAll');
    if (fillAllBtn) {
      fillAllBtn.onclick = () => {
        world.fillAllTiles(input.currentTileId);
      };
    }

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
          updateSeedUI();
          renderer.fitCameraToWorld();
        } catch (ex) {
          alert('Failed to load world: ' + ex.message);
        }
      };
      reader.readAsText(file);
    };

    // Main animation loop
    const FIXED_STEP = 1 / 60;
    const MAX_FRAME_TIME = 0.25; // prevent spiral of death
    let accumulator = 0;
    let lastTime = performance.now();
    function loop(time) {
      let frameTime = (time - lastTime) / 1000;
      lastTime = time;
      if (frameTime > MAX_FRAME_TIME) {
        frameTime = MAX_FRAME_TIME;
      }

      if (playing) {
        accumulator += frameTime;
        while (accumulator >= FIXED_STEP) {
          world.update(FIXED_STEP);
          accumulator -= FIXED_STEP;
        }
      } else {
        accumulator = 0;
      }

      renderer.draw();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  } catch (err) {
    console.error('Failed to initialize engine', err);
    const paletteDiv = document.getElementById('palette');
    paletteDiv.textContent = 'Failed to load assets';
  }
}

init();