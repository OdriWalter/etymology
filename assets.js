import embeddedPaletteData from './data/paletteData.js';
import embeddedGlyphData from './data/glyphsData.js';

const PALETTE_PATH = './data/palette.json';
const GLYPHS_PATH = './data/glyphs.json';

const CARDINAL_DIRECTIONS = ['north', 'south', 'east', 'west'];

function normaliseTransitions(rawTransitions, byKey) {
  if (!rawTransitions || typeof rawTransitions !== 'object') {
    return null;
  }
  const resolved = {};
  for (const [neighborKey, definition] of Object.entries(rawTransitions)) {
    const neighborTile = byKey[neighborKey];
    if (!neighborTile || !definition || typeof definition !== 'object') {
      continue;
    }
    const entries = {};
    for (const direction of CARDINAL_DIRECTIONS) {
      const glyphKey = definition[direction];
      if (typeof glyphKey === 'string' && glyphKey.trim().length > 0) {
        entries[direction] = glyphKey;
      }
    }
    if (Object.keys(entries).length > 0) {
      resolved[neighborTile.id] = entries;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

function buildPaletteLUT(data) {
  const tiles = (data.tiles || []).map((tile, index) => {
    const assignedId = tile.id != null ? tile.id : index;
    return { ...tile, id: assignedId };
  });
  if (tiles.length === 0) {
    throw new Error('Palette definition contains no tiles');
  }
  const byKey = {};
  const byId = {};
  for (const tile of tiles) {
    if (!tile.key) {
      throw new Error('Palette tile missing key');
    }
    byKey[tile.key] = tile;
    byId[tile.id] = tile;
  }
  for (const tile of tiles) {
    tile.edgeTransitions = normaliseTransitions(tile.transitions, byKey);
  }
  const fallbackKey = data.defaultTile && byKey[data.defaultTile]
    ? data.defaultTile
    : tiles[0].key;
  const defaultTileId = byKey[fallbackKey].id;
  return {
    tiles,
    byKey,
    byId,
    defaultTileKey: fallbackKey,
    defaultTileId
  };
}

function parseHexColor(hex) {
  const normalized = hex.replace(/^#/, '');
  if (![3, 4, 6, 8].includes(normalized.length)) {
    throw new Error(`Unsupported hex colour: ${hex}`);
  }
  const expand = (value) => value.length === 1 ? value + value : value;
  let r, g, b, a = 255;
  if (normalized.length === 3 || normalized.length === 4) {
    const rHex = expand(normalized[0]);
    const gHex = expand(normalized[1]);
    const bHex = expand(normalized[2]);
    const aHex = normalized.length === 4 ? expand(normalized[3]) : 'ff';
    r = parseInt(rHex, 16);
    g = parseInt(gHex, 16);
    b = parseInt(bHex, 16);
    a = parseInt(aHex, 16);
  } else {
    r = parseInt(normalized.slice(0, 2), 16);
    g = parseInt(normalized.slice(2, 4), 16);
    b = parseInt(normalized.slice(4, 6), 16);
    if (normalized.length === 8) {
      a = parseInt(normalized.slice(6, 8), 16);
    }
  }
  return { r, g, b, a };
}

function decodeRLE(rle, expected) {
  if (!rle) return [];
  const tokens = rle.trim().split(/\s+/);
  const pixels = [];
  for (const token of tokens) {
    const parts = token.split('*');
    if (parts.length !== 2) {
      throw new Error(`Invalid RLE token: ${token}`);
    }
    const count = Number(parts[0]);
    const value = Number(parts[1]);
    if (!Number.isFinite(count) || !Number.isFinite(value)) {
      throw new Error(`Invalid RLE pair: ${token}`);
    }
    for (let i = 0; i < count; i++) {
      pixels.push(value);
    }
  }
  if (expected != null && pixels.length !== expected) {
    throw new Error(`RLE length ${pixels.length} does not match expected ${expected}`);
  }
  return pixels;
}

function expandGlyph(definition) {
  const { width, height, palette = [], rle } = definition;
  const pixelCount = width * height;
  const pixels = decodeRLE(rle, pixelCount);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < pixelCount; i++) {
    const paletteIndex = pixels[i];
    const color = palette[paletteIndex];
    const offset = i * 4;
    if (!color) {
      imageData.data[offset] = 0;
      imageData.data[offset + 1] = 0;
      imageData.data[offset + 2] = 0;
      imageData.data[offset + 3] = 0;
      continue;
    }
    const { r, g, b, a } = parseHexColor(color);
    imageData.data[offset] = r;
    imageData.data[offset + 1] = g;
    imageData.data[offset + 2] = b;
    imageData.data[offset + 3] = a;
  }
  ctx.putImageData(imageData, 0, 0);
  return {
    ...definition,
    pixels,
    canvas
  };
}

function buildGlyphRegistry(data) {
  const glyphs = {};
  const list = [];
  for (const def of data.glyphs || []) {
    if (!def.key) {
      throw new Error('Glyph definition missing key');
    }
    const expanded = expandGlyph(def);
    glyphs[def.key] = expanded;
    list.push(expanded);
  }
  return { byKey: glyphs, list };
}

function loadEmbeddedAssetJson() {
  if (!embeddedPaletteData) {
    throw new Error('Embedded palette data missing');
  }
  if (!embeddedGlyphData) {
    throw new Error('Embedded glyph data missing');
  }
  return { paletteJson: embeddedPaletteData, glyphJson: embeddedGlyphData };
}

async function fetchAssetJson() {
  const [paletteRes, glyphRes] = await Promise.all([
    fetch(PALETTE_PATH),
    fetch(GLYPHS_PATH)
  ]);
  if (!paletteRes.ok) {
    throw new Error(`Failed to load palette: ${paletteRes.status}`);
  }
  if (!glyphRes.ok) {
    throw new Error(`Failed to load glyphs: ${glyphRes.status}`);
  }
  const [paletteJson, glyphJson] = await Promise.all([
    paletteRes.json(),
    glyphRes.json()
  ]);
  return { paletteJson, glyphJson };
}

function logAssetSummary(palette, glyphs, source) {
  const tileCount = palette.tiles.length;
  const glyphCount = glyphs.list.length;
  const message = `[assets] Loaded ${tileCount} palette tiles and ${glyphCount} glyphs (${source}).`;
  if (tileCount === 0 || glyphCount === 0) {
    console.warn(message);
  } else {
    console.info(message);
  }
}

export async function loadAssets(options = {}) {
  const preferFetch = options.preferFetch === true;
  let paletteJson;
  let glyphJson;
  const errors = [];

  if (!preferFetch) {
    try {
      ({ paletteJson, glyphJson } = loadEmbeddedAssetJson());
    } catch (err) {
      errors.push(err);
      console.warn(`[assets] Embedded asset load failed: ${err.message}`);
    }
  }

  let source = 'embedded data';
  if (!paletteJson || !glyphJson) {
    try {
      ({ paletteJson, glyphJson } = await fetchAssetJson());
      source = 'network fetch';
    } catch (err) {
      errors.push(err);
    }
  }

  if (!paletteJson || !glyphJson) {
    const details = errors.map((err) => err && err.message ? err.message : String(err)).join('; ');
    throw new Error(`Unable to load palette/glyph assets: ${details || 'unknown error'}`);
  }

  const palette = buildPaletteLUT(paletteJson);
  const glyphs = buildGlyphRegistry(glyphJson);
  logAssetSummary(palette, glyphs, source);
  return { palette, glyphs };
}
