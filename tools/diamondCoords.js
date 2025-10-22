#!/usr/bin/env node
/**
 * Utility conversions between Cartesian (x, y) world coordinates and the
 * renderer's diamond-space coordinates. The transformation assumes the origin
 * lies at the bottom-left of the quadtree and that tiles are square before the
 * isometric projection is applied.
 */

export function cartesianToDiamond({ x, y }, { origin = { x: 0, y: 0 }, scale = 1 } = {}) {
  const dx = (x - origin.x) * scale;
  const dy = (y - origin.y) * scale;
  return {
    u: dx - dy,
    v: (dx + dy) * 0.5
  };
}

export function diamondToCartesian({ u, v }, { origin = { x: 0, y: 0 }, scale = 1 } = {}) {
  const dx = (v + u * 0.5) / scale;
  const dy = (v - u * 0.5) / scale;
  return {
    x: dx + origin.x,
    y: dy + origin.y
  };
}

export function transformFeatureGeometry(feature, transform) {
  const clonePoint = (point) => transform(point);
  const cloneLine = (line = []) => line.map((point) => clonePoint(point));

  if (Array.isArray(feature.line)) {
    return { ...feature, line: cloneLine(feature.line) };
  }
  if (Array.isArray(feature.poly)) {
    return { ...feature, poly: cloneLine(feature.poly) };
  }
  if (Array.isArray(feature.polygon)) {
    return { ...feature, polygon: cloneLine(feature.polygon) };
  }
  return feature;
}
