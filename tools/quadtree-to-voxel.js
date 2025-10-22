#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

function usage() {
  console.log(`Usage: node quadtree-to-voxel.js --input <dir> --output <dir> [options]\n\n` +
    `Options:\n` +
    `  --lod <n>                Quadtree LOD to convert (default: highest available)\n` +
    `  --chunk-size <n>         Number of voxels per chunk axis (default: 16)\n` +
    `  --height <n>             Vertical voxel layers (default: 8)\n` +
    `  --palette-map <pairs>    Comma separated terrain:height mapping (e.g. forest:4,water:1)\n` +
    `  --sprite-glyph <key>     Glyph key used for building sprites (default: oak_tree)\n` +
    `  --help                   Show this message`);
}

function parseArgs(argv) {
  const args = { chunkSize: 16, height: 8, paletteMap: {}, spriteGlyph: 'oak_tree' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--input':
        args.input = argv[++i];
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--lod':
        args.lod = Number(argv[++i]);
        break;
      case '--chunk-size':
        args.chunkSize = Number(argv[++i]);
        break;
      case '--height':
        args.height = Number(argv[++i]);
        break;
      case '--palette-map': {
        const raw = argv[++i] || '';
        raw.split(',').forEach((pair) => {
          const [key, value] = pair.split(':');
          const height = Number(value);
          if (key) {
            args.paletteMap[key.trim()] = Number.isFinite(height) ? height : null;
          }
        });
        break;
      }
      case '--sprite-glyph':
        args.spriteGlyph = argv[++i] || 'oak_tree';
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.warn(`Unknown argument: ${token}`);
    }
  }
  return args;
}

async function readJson(file) {
  const buffer = await fs.readFile(file, 'utf8');
  return JSON.parse(buffer);
}

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true });
}

function chunkKey(x, y) {
  return `${x}_${y}`;
}

function defaultHeightForKey(key, paletteMap) {
  if (key && paletteMap[key] != null) {
    return paletteMap[key];
  }
  switch (key) {
    case 'water':
      return 1;
    case 'forest':
      return 4;
    case 'mountain':
      return 5;
    default:
      return 3;
  }
}

function defaultVoxelIdForKey(key) {
  switch (key) {
    case 'water':
      return 3;
    case 'forest':
      return 2;
    case 'mountain':
      return 1;
    default:
      return 1;
  }
}

function encodeChunkBase64(heights, voxels) {
  const payload = new Uint8Array(heights.length + voxels.length);
  payload.set(heights, 0);
  payload.set(voxels, heights.length);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(payload).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < payload.length; i++) {
    binary += String.fromCharCode(payload[i]);
  }
  return btoa(binary);
}

function centroidOfPolygon(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return { x: 0, y: 0 };
  }
  let sumX = 0;
  let sumY = 0;
  for (const pt of points) {
    sumX += pt.x;
    sumY += pt.y;
  }
  const n = points.length;
  return { x: sumX / n, y: sumY / n };
}

function spritePaletteRemap() {
  return { canopy: 'forest', trunk: 'mountain' };
}

function toCellPosition(point, bounds, chunkSize) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const cellX = ((point.x - bounds.minX) / width) * chunkSize;
  const cellY = ((point.y - bounds.minY) / height) * chunkSize;
  return {
    x: Math.max(0, Math.min(chunkSize - 1, Math.round(cellX))),
    y: Math.max(0, Math.min(chunkSize - 1, Math.round(cellY)))
  };
}

function quadtreeTilePath(template, lod, x, y) {
  return template
    .replace('{lod}', String(lod))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

async function loadTile(baseDir, template, lod, x, y) {
  const relative = quadtreeTilePath(template, lod, x, y);
  const file = path.join(baseDir, relative);
  return readJson(file);
}

function deriveScale(bounds, gridWidth, gridHeight, chunkSize) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const voxelWidth = width / (gridWidth * chunkSize);
  const voxelHeight = height / (gridHeight * chunkSize);
  return { x: voxelWidth, y: voxelHeight };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help || !args.input || !args.output) {
    usage();
    if (!args.input || !args.output) process.exit(1);
    process.exit(0);
  }

  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const indexPath = path.join(inputDir, 'index.json');
  const index = await readJson(indexPath);
  const template = index.tileTemplate || 'tiles/{lod}/{x}_{y}.json';
  const lod = Number.isInteger(args.lod) ? args.lod : (index.lodRange?.max ?? 0);
  const gridSize = 1 << lod;
  const chunkSize = Math.max(1, Math.floor(args.chunkSize));
  const heightLayers = Math.max(1, Math.floor(args.height));
  const bounds = index.bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const scale = deriveScale(bounds, gridSize, gridSize, chunkSize);

  await ensureDir(path.join(outputDir, 'chunks'));

  const chunkMeta = [];

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const tile = await loadTile(inputDir, template, lod, x, y);
      const terrainKey = tile?.layers?.terrain?.tileKey || index.layers?.terrain?.default || 'grass';
      const cellCount = chunkSize * chunkSize;
      const heights = new Uint8Array(cellCount);
      const voxels = new Uint8Array(cellCount * heightLayers);
      const heightValue = defaultHeightForKey(terrainKey, args.paletteMap);
      const topVoxel = defaultVoxelIdForKey(terrainKey);
      for (let i = 0; i < cellCount; i++) {
        heights[i] = Math.max(1, Math.min(heightLayers, heightValue));
        const base = i * heightLayers;
        for (let z = 0; z < heightLayers; z++) {
          if (z >= heights[i]) {
            voxels[base + z] = 0;
          } else if (z === heights[i] - 1) {
            voxels[base + z] = topVoxel;
          } else {
            voxels[base + z] = 1;
          }
        }
      }

      const base64 = encodeChunkBase64(heights, voxels);
      const chunkFile = path.join(outputDir, 'chunks', `${chunkKey(x, y)}.bin`);
      await fs.writeFile(chunkFile, base64, 'utf8');

      const spriteMeta = { version: 1, chunk: { x, y }, sprites: [] };
      const buildingFeatures = tile?.layers?.buildings?.features || [];
      for (const feature of buildingFeatures) {
        const ring = feature.polygon || feature.poly || [];
        if (!Array.isArray(ring) || ring.length === 0) continue;
        const center = centroidOfPolygon(ring);
        const tileBounds = tile.bounds || bounds;
        const local = toCellPosition(center, tileBounds, chunkSize);
        spriteMeta.sprites.push({
          id: `${feature.id || 'building'}_${x}_${y}`,
          spriteKey: args.spriteGlyph,
          voxelId: topVoxel,
          position: { x: local.x, y: local.y, z: heights[0] },
          paletteRemap: spritePaletteRemap()
        });
      }
      const spriteFile = path.join(outputDir, 'chunks', `${chunkKey(x, y)}.json`);
      await fs.writeFile(spriteFile, JSON.stringify(spriteMeta, null, 2));
      chunkMeta.push({ x, y });
    }
  }

  const voxelIndex = {
    version: 1,
    id: index.id ? `${index.id}-voxel` : 'voxelized-world',
    title: `${index.title || 'Quadtree'} – voxel export`,
    description: 'Auto-generated voxel chunks derived from quadtree tiles.',
    bounds,
    origin: index.origin || { x: 0, y: 0, z: 0 },
    scale: { x: scale.x, y: scale.y, z: scale.y },
    chunkSize: { width: chunkSize, depth: chunkSize, height: heightLayers },
    chunkGrid: { width: gridSize, height: gridSize },
    binaryLayout: {
      encoding: 'base64',
      heightfield: { type: 'uint8', offset: 0, length: chunkSize * chunkSize, stride: 1 },
      voxels: { type: 'uint8', offset: chunkSize * chunkSize, length: chunkSize * chunkSize * heightLayers, stride: 1 }
    },
    palette: {
      voxels: [
        { id: 0, key: 'air', tileKey: 'grass', solid: false },
        { id: 1, key: 'soil', tileKey: 'grass', solid: true },
        { id: 2, key: 'canopy', tileKey: 'forest', solid: true, spriteKey: args.spriteGlyph },
        { id: 3, key: 'water', tileKey: 'water', solid: false },
        { id: 4, key: 'mountain_cap', tileKey: 'mountain', solid: true }
      ],
      sprites: [
        {
          id: args.spriteGlyph,
          glyph: args.spriteGlyph,
          defaultPalette: spritePaletteRemap(),
          anchor: { x: 3.5, y: 6 }
        }
      ]
    },
    spriteLayer: { maxPerChunk: 32, placement: 'world', defaultScale: 1 },
    chunkTemplate: 'chunks/{x}_{y}'
  };

  await fs.writeFile(path.join(outputDir, 'index.json'), JSON.stringify(voxelIndex, null, 2));
  console.log(`[voxel] Wrote ${chunkMeta.length} chunks to ${outputDir}`);
}

main().catch((err) => {
  console.error('[voxel] Export failed:', err);
  process.exit(1);
});
