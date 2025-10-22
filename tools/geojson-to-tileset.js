#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { cartesianToDiamond, transformFeatureGeometry } from './diamondCoords.js';

function usage() {
  console.log(`Usage: node geojson-to-tileset.js --input <file> --output <dir> [options]\n\n` +
    `Options:\n` +
    `  --lod-min <n>          Lowest level-of-detail to export (default: 0)\n` +
    `  --lod-max <n>          Highest level-of-detail to export (default: 3)\n` +
    `  --bounds <minX,minY,maxX,maxY>  Explicit dataset bounds in source units\n` +
    `  --terrain-default <key>         Palette key used when no tile key present\n` +
    `  --diamond             Transform coordinates into diamond space\n` +
    `  --seed <n>            World seed used when generating procedural nodes\n` +
    `  --id <string>         Identifier written to index.json (default: derived from input)\n` +
    `  --title <string>      Title written to index.json`);
}

function parseArgs(argv) {
  const args = { lodMin: 0, lodMax: 3, diamond: false, seed: 0, terrainDefault: 'grass' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--input':
        args.input = argv[++i];
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--lod-min':
        args.lodMin = Number(argv[++i]);
        break;
      case '--lod-max':
        args.lodMax = Number(argv[++i]);
        break;
      case '--bounds': {
        const raw = argv[++i];
        if (raw) {
          const parts = raw.split(',').map(Number);
          if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) {
            args.bounds = { minX: parts[0], minY: parts[1], maxX: parts[2], maxY: parts[3] };
          }
        }
        break;
      }
      case '--terrain-default':
        args.terrainDefault = argv[++i];
        break;
      case '--diamond':
        args.diamond = true;
        break;
      case '--seed':
        args.seed = Number(argv[++i]) >>> 0;
        break;
      case '--id':
        args.id = argv[++i];
        break;
      case '--title':
        args.title = argv[++i];
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

function rdp(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3) {
    return points ? [...points] : [];
  }
  const stack = [[0, points.length - 1]];
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const dist = (p, q, r) => {
    const area = Math.abs((p.x * (q.y - r.y) + q.x * (r.y - p.y) + r.x * (p.y - q.y)));
    const bottom = Math.hypot(r.x - p.x, r.y - p.y);
    return bottom === 0 ? 0 : area / bottom;
  };

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = dist(points[start], points[i], points[end]);
      if (d > maxDist) {
        index = i;
        maxDist = d;
      }
    }
    if (maxDist > epsilon && index !== -1) {
      keep[index] = true;
      stack.push([start, index]);
      stack.push([index, end]);
    }
  }

  return points.filter((_, idx) => keep[idx]);
}

function simplifyFeature(feature, tolerance) {
  if (!feature) return feature;
  if (Array.isArray(feature.line)) {
    return { ...feature, line: rdp(feature.line, tolerance) };
  }
  if (Array.isArray(feature.poly)) {
    return { ...feature, poly: rdp(feature.poly, tolerance) };
  }
  if (Array.isArray(feature.polygon)) {
    return { ...feature, polygon: rdp(feature.polygon, tolerance) };
  }
  return feature;
}

function featureBounds(feature) {
  const collect = [];
  if (Array.isArray(feature.line)) collect.push(...feature.line);
  if (Array.isArray(feature.poly)) collect.push(...feature.poly);
  if (Array.isArray(feature.polygon)) collect.push(...feature.polygon);
  if (!collect.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of collect) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }
  return { minX, minY, maxX, maxY };
}

function intersects(a, b) {
  return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
}

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true });
}

function tileBounds(globalBounds, lod, x, y) {
  const width = globalBounds.maxX - globalBounds.minX;
  const height = globalBounds.maxY - globalBounds.minY;
  const divisions = 1 << lod;
  const tileWidth = width / divisions;
  const tileHeight = height / divisions;
  const minX = globalBounds.minX + tileWidth * x;
  const maxX = minX + tileWidth;
  const maxY = globalBounds.maxY - tileHeight * y;
  const minY = maxY - tileHeight;
  return { minX, minY, maxX, maxY };
}

function pointToFeature(point) {
  return { x: point[0], y: point[1] };
}

function geojsonGeometryToFeature(geometry) {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'LineString':
      return { line: geometry.coordinates.map(pointToFeature) };
    case 'Polygon':
      return { poly: geometry.coordinates[0]?.map(pointToFeature) || [] };
    case 'MultiLineString': {
      const lines = geometry.coordinates.map((line) => line.map(pointToFeature));
      return { line: lines.flat() };
    }
    case 'MultiPolygon': {
      const polys = geometry.coordinates.map((poly) => poly[0]?.map(pointToFeature) || []);
      return { poly: polys.flat() };
    }
    default:
      return null;
  }
}

function groupFeatureByLayer(feature, layers) {
  const layerKey = feature.properties?.layer || feature.properties?.category;
  if (!layerKey) return;
  switch (layerKey) {
    case 'terrain':
      layers.terrain.push(feature);
      break;
    case 'vector':
    case 'road':
    case 'river':
      layers.vectors.push(feature);
      break;
    case 'parcel':
      layers.parcels.push(feature);
      break;
    case 'building':
      layers.buildings.push(feature);
      break;
    default:
      layers.vectors.push(feature);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const raw = await fs.readFile(args.input, 'utf8');
  const geojson = JSON.parse(raw);
  const features = Array.isArray(geojson.features) ? geojson.features : [];

  const projectedFeatures = features.map((feature, index) => {
    const geometry = geojsonGeometryToFeature(feature.geometry);
    if (!geometry) return null;
    const id = feature.id || feature.properties?.id || `feature-${index}`;
    let mapped = { id, properties: { ...feature.properties }, ...geometry };
    if (args.diamond) {
      mapped = transformFeatureGeometry(mapped, (point) => cartesianToDiamond(point));
    }
    return mapped;
  }).filter(Boolean);

  const bounds = args.bounds || (() => {
    const bbox = projectedFeatures
      .map(featureBounds)
      .filter(Boolean)
      .reduce((acc, current) => {
        if (!acc) return { ...current };
        return {
          minX: Math.min(acc.minX, current.minX),
          minY: Math.min(acc.minY, current.minY),
          maxX: Math.max(acc.maxX, current.maxX),
          maxY: Math.max(acc.maxY, current.maxY)
        };
      }, null);
    if (!bbox) {
      throw new Error('Unable to determine dataset bounds from input; please provide --bounds');
    }
    return bbox;
  })();

  await ensureDir(path.join(args.output, 'quadtree'));
  await ensureDir(path.join(args.output, 'tiles'));

  const index = {
    version: 1,
    id: args.id || path.basename(args.input, path.extname(args.input)),
    title: args.title || 'Generated Tileset',
    description: 'Auto-generated from GeoJSON using geojson-to-tileset.js',
    coordinateSystem: 'EPSG:3857',
    units: 'meters',
    origin: { x: bounds.minX, y: bounds.minY },
    bounds,
    lodRange: { min: args.lodMin, max: args.lodMax },
    tileTemplate: 'tiles/{lod}/{x}_{y}.json',
    layers: {
      terrain: { id: 'global-terrain', kind: 'raster', default: args.terrainDefault },
      vectors: { id: 'regional-vectors', kind: 'polyline' },
      parcels: { id: 'city-parcels', kind: 'polygon' },
      buildings: { id: 'building-footprints', kind: 'polygon' }
    },
    root: { lod: 0, x: 0, y: 0, id: 'root', children: 4 },
    metadata: {
      seed: args.seed,
      featureCount: projectedFeatures.length
    }
  };

  for (let lod = args.lodMin; lod <= args.lodMax; lod++) {
    const tilesPerAxis = 1 << lod;
    const lodDir = path.join(args.output, 'tiles', `${lod}`);
    await ensureDir(lodDir);
    for (let y = 0; y < tilesPerAxis; y++) {
      for (let x = 0; x < tilesPerAxis; x++) {
        const tileBBox = tileBounds(bounds, lod, x, y);
        const layers = { terrain: [], vectors: [], parcels: [], buildings: [] };
        const tolerance = Math.max(0.5, Math.pow(2, args.lodMax - lod));
        for (const feature of projectedFeatures) {
          const bbox = featureBounds(feature);
          if (!bbox || !intersects(tileBBox, bbox)) continue;
          const simplified = simplifyFeature(feature, tolerance);
          groupFeatureByLayer(simplified, layers);
        }
        const tile = {
          lod,
          x,
          y,
          id: lod === 0 ? 'root' : null,
          bounds: tileBBox,
          layers: {
            terrain: { tileKey: args.terrainDefault },
            vectors: { features: layers.vectors },
            parcels: { features: layers.parcels },
            buildings: { features: layers.buildings }
          },
          children: [],
          proceduralSeed: `${index.id}:${lod}:${x}:${y}`
        };
        const fileName = path.join(lodDir, `${x}_${y}.json`);
        await fs.writeFile(fileName, JSON.stringify(tile, null, 2));
      }
    }
  }

  await fs.writeFile(path.join(args.output, 'quadtree', 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Tileset exported to ${args.output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
