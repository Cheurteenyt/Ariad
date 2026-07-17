const MIN_SPATIAL_CELL_SIZE = 128;

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableGraphHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function roundGraphCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Deterministic collision-safe packing shared by overview and exact scopes. */
export function packGraphCircles<T extends { key: string; radius: number; x: number; y: number }>(
  items: T[],
  gap: number,
  spiralStep: number,
): void {
  const packingOrder = [...items]
    .sort((a, b) => b.radius - a.radius || stableStringCompare(a.key, b.key));
  const medianRadius = packingOrder[Math.floor(packingOrder.length / 2)]?.radius ?? 0;
  const typicalDiameter = medianRadius * 2 + gap;
  const spatialCellSize = Math.max(MIN_SPATIAL_CELL_SIZE, typicalDiameter);
  const effectiveSpiralStep = typicalDiameter > MIN_SPATIAL_CELL_SIZE * 2
    ? Math.max(spiralStep, typicalDiameter * 0.5)
    : spiralStep;
  const placed: T[] = [];
  let outerRadius = 0;
  const spatialCells = new Map<string, Set<T>>();
  const forEachSpatialCell = (
    x: number,
    y: number,
    radius: number,
    visit: (cellKey: string) => void,
  ) => {
    const minCellX = Math.floor((x - radius) / spatialCellSize);
    const maxCellX = Math.floor((x + radius) / spatialCellSize);
    const minCellY = Math.floor((y - radius) / spatialCellSize);
    const maxCellY = Math.floor((y + radius) / spatialCellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        visit(`${cellX},${cellY}`);
      }
    }
  };
  const indexItem = (item: T) => {
    forEachSpatialCell(item.x, item.y, item.radius, (cellKey) => {
      const cell = spatialCells.get(cellKey);
      if (cell) cell.add(item);
      else spatialCells.set(cellKey, new Set([item]));
    });
  };
  const overlapsPlaced = (item: T, candidateX: number, candidateY: number): boolean => {
    const nearby = new Set<T>();
    forEachSpatialCell(candidateX, candidateY, item.radius + gap, (cellKey) => {
      for (const other of spatialCells.get(cellKey) ?? []) nearby.add(other);
    });
    for (const other of nearby) {
      if (
        Math.hypot(candidateX - other.x, candidateY - other.y)
          < item.radius + other.radius + gap
      ) return true;
    }
    return false;
  };

  let spiralIndex = 0;
  for (const item of packingOrder) {
    if (placed.length === 0) {
      item.x = 0;
      item.y = 0;
      placed.push(item);
      outerRadius = item.radius;
      indexItem(item);
      continue;
    }

    let found = false;
    for (let attempt = 0; attempt < 50_000; attempt += 1) {
      spiralIndex += 1;
      const distance = effectiveSpiralStep * Math.sqrt(spiralIndex);
      const angle = spiralIndex * GOLDEN_ANGLE;
      const candidateX = Math.cos(angle) * distance;
      const candidateY = Math.sin(angle) * distance;
      if (overlapsPlaced(item, candidateX, candidateY)) continue;
      item.x = candidateX;
      item.y = candidateY;
      found = true;
      break;
    }

    if (!found) {
      item.x = outerRadius + item.radius + gap;
      item.y = 0;
    }
    placed.push(item);
    outerRadius = Math.max(outerRadius, Math.hypot(item.x, item.y) + item.radius);
    indexItem(item);
  }
}
