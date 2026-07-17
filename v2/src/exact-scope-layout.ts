import { normalizeGraphPath } from './graph-scope.js';
import {
  packGraphCircles,
  roundGraphCoordinate,
  stableGraphHash,
  stableStringCompare,
} from './graph-layout-primitives.js';

const DIRECTORY_LABELS = new Set(['Directory', 'Folder']);
const STRUCTURAL_LABELS = new Set(['Directory', 'Folder', 'File', 'Module', 'Package']);
const MAX_SCOPE_DOMAINS = 12;
const MAX_SELECTED_FILES = 48;
const FILES_PER_DOMAIN_RESERVE = 2;
const CLUSTER_GAP = 28;
const CLUSTER_SPIRAL_STEP = 44;
const DOMAIN_PADDING = 48;
const DOMAIN_GAP = 76;
const DOMAIN_SPIRAL_STEP = 64;

export interface ExactScopeLayoutNode {
  id: number;
  label: string;
  file_path?: string | null;
}

interface ExactScopeLayoutCluster {
  id: number;
  domain_id: number;
  key: string;
  x: number;
  y: number;
  radius: number;
  node_count: number;
}

interface ExactScopeLayoutDomain {
  id: number;
  key: string;
  x: number;
  y: number;
  radius: number;
  node_count: number;
  cluster_count: number;
}

export interface ExactScopeLayout {
  strategy: 'exact-directory-file-v1';
  node_spacing: 16;
  counts_scope: 'all_nodes';
  clusters: ExactScopeLayoutCluster[];
  domains: ExactScopeLayoutDomain[];
}

interface MutableCluster extends ExactScopeLayoutCluster {
  domainKey: string;
}

interface MutableDomain extends ExactScopeLayoutDomain {
  clusters: MutableCluster[];
}

export interface ExactScopeLayoutPlan {
  layout: ExactScopeLayout;
  scopeKey: string;
  selectedDomains: ReadonlySet<string>;
  selectedFiles: ReadonlySet<string>;
  domainByKey: ReadonlyMap<string, ExactScopeLayoutDomain>;
  clusterByKey: ReadonlyMap<string, ExactScopeLayoutCluster>;
}

function nodePathParts(node: ExactScopeLayoutNode) {
  const path = normalizeGraphPath(node.file_path);
  const parts = path.split('/').filter(Boolean);
  const directory = (DIRECTORY_LABELS.has(node.label) ? parts : parts.slice(0, -1)).join('/');
  const file = path.length > 0 ? path : `(virtual)/${node.label}`;
  return { directory, file };
}

function rawDomainKey(node: ExactScopeLayoutNode, scopeKey: string): string {
  const { directory } = nodePathParts(node);
  const scopePrefix = scopeKey === '(root)' ? '' : scopeKey;
  const relative = scopePrefix.length > 0 && directory.startsWith(`${scopePrefix}/`)
    ? directory.slice(scopePrefix.length + 1)
    : directory === scopePrefix
      ? ''
      : directory;
  const child = relative.split('/').filter(Boolean)[0];
  if (!child) return scopeKey;
  return scopePrefix.length > 0 ? `${scopePrefix}/${child}` : child;
}

function sortedCounts(counts: ReadonlyMap<string, number>) {
  return [...counts].sort(([leftKey, leftCount], [rightKey, rightCount]) => (
    rightCount - leftCount || stableStringCompare(leftKey, rightKey)
  ));
}

function otherDomainKey(scopeKey: string): string {
  return scopeKey === '(root)' ? '(other directories)' : `${scopeKey}/(other directories)`;
}

function otherFilesKey(domainKey: string): string {
  return `${domainKey}/(other files)`;
}

function selectDomains(counts: ReadonlyMap<string, number>, scopeKey: string): Set<string> {
  if (counts.size <= MAX_SCOPE_DOMAINS) return new Set(counts.keys());
  const selected = new Set<string>();
  if (counts.has(scopeKey)) selected.add(scopeKey);
  for (const [key] of sortedCounts(counts)) {
    if (selected.size >= MAX_SCOPE_DOMAINS - 1) break;
    selected.add(key);
  }
  return selected;
}

function mappedDomainKey(rawKey: string, selected: ReadonlySet<string>, scopeKey: string): string {
  return selected.has(rawKey) ? rawKey : otherDomainKey(scopeKey);
}

function clusterRadius(nodeCount: number, aggregate: boolean): number {
  const capacity = Math.min(nodeCount, aggregate ? 96 : 64);
  const furthest = capacity <= 1 ? 0 : 12 + Math.sqrt(capacity - 1) * 12;
  return Math.max(44, Math.ceil(furthest + 22));
}

export function buildExactScopeLayout(
  nodes: readonly ExactScopeLayoutNode[],
  rawScopeKey: string,
): ExactScopeLayoutPlan {
  const scopeKey = normalizeGraphPath(rawScopeKey) || '(root)';
  const rawDomainCounts = new Map<string, number>();
  for (const node of nodes) {
    const key = rawDomainKey(node, scopeKey);
    rawDomainCounts.set(key, (rawDomainCounts.get(key) ?? 0) + 1);
  }
  const selectedDomains = selectDomains(rawDomainCounts, scopeKey);

  const domainCounts = new Map<string, number>();
  const fileCounts = new Map<string, { domainKey: string; count: number }>();
  for (const node of nodes) {
    const domainKey = mappedDomainKey(rawDomainKey(node, scopeKey), selectedDomains, scopeKey);
    domainCounts.set(domainKey, (domainCounts.get(domainKey) ?? 0) + 1);
    const fileKey = nodePathParts(node).file;
    const composite = `${domainKey}\0${fileKey}`;
    const current = fileCounts.get(composite);
    fileCounts.set(composite, { domainKey, count: (current?.count ?? 0) + 1 });
  }

  const filesByDomain = new Map<string, Array<[string, number]>>();
  for (const [composite, { domainKey, count }] of fileCounts) {
    const fileKey = composite.slice(domainKey.length + 1);
    const bucket = filesByDomain.get(domainKey);
    if (bucket) bucket.push([fileKey, count]);
    else filesByDomain.set(domainKey, [[fileKey, count]]);
  }
  for (const files of filesByDomain.values()) {
    files.sort(([leftKey, leftCount], [rightKey, rightCount]) => (
      rightCount - leftCount || stableStringCompare(leftKey, rightKey)
    ));
  }

  const selectedFiles = new Set<string>();
  for (const domainKey of [...domainCounts.keys()].sort(stableStringCompare)) {
    for (const [fileKey] of (filesByDomain.get(domainKey) ?? []).slice(0, FILES_PER_DOMAIN_RESERVE)) {
      if (selectedFiles.size >= MAX_SELECTED_FILES) break;
      selectedFiles.add(`${domainKey}\0${fileKey}`);
    }
  }
  const remainingFiles = [...fileCounts.entries()]
    .filter(([composite]) => !selectedFiles.has(composite))
    .sort(([leftKey, left], [rightKey, right]) => (
      right.count - left.count || stableStringCompare(leftKey, rightKey)
    ));
  for (const [composite] of remainingFiles) {
    if (selectedFiles.size >= MAX_SELECTED_FILES) break;
    selectedFiles.add(composite);
  }

  const clusterCounts = new Map<string, { domainKey: string; count: number }>();
  for (const node of nodes) {
    const domainKey = mappedDomainKey(rawDomainKey(node, scopeKey), selectedDomains, scopeKey);
    const fileKey = nodePathParts(node).file;
    const composite = `${domainKey}\0${fileKey}`;
    const clusterKey = selectedFiles.has(composite) ? fileKey : otherFilesKey(domainKey);
    const current = clusterCounts.get(clusterKey);
    clusterCounts.set(clusterKey, { domainKey, count: (current?.count ?? 0) + 1 });
  }

  const domains: MutableDomain[] = [...domainCounts]
    .sort(([left], [right]) => stableStringCompare(left, right))
    .map(([key, nodeCount], id) => ({
      id,
      key,
      x: 0,
      y: 0,
      radius: 0,
      node_count: nodeCount,
      cluster_count: 0,
      clusters: [],
    }));
  const domainByKey = new Map(domains.map((domain) => [domain.key, domain]));
  const clusters: MutableCluster[] = [...clusterCounts]
    .sort(([left], [right]) => stableStringCompare(left, right))
    .map(([key, { domainKey, count }], id) => ({
      id,
      domain_id: domainByKey.get(domainKey)!.id,
      domainKey,
      key,
      x: 0,
      y: 0,
      radius: clusterRadius(count, key === otherFilesKey(domainKey)),
      node_count: count,
    }));
  for (const cluster of clusters) domainByKey.get(cluster.domainKey)!.clusters.push(cluster);

  for (const domain of domains) {
    packGraphCircles(domain.clusters, CLUSTER_GAP, CLUSTER_SPIRAL_STEP);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const cluster of domain.clusters) {
      minX = Math.min(minX, cluster.x - cluster.radius);
      minY = Math.min(minY, cluster.y - cluster.radius);
      maxX = Math.max(maxX, cluster.x + cluster.radius);
      maxY = Math.max(maxY, cluster.y + cluster.radius);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    for (const cluster of domain.clusters) {
      cluster.x -= centerX;
      cluster.y -= centerY;
    }
    domain.radius = Math.ceil(Math.max(
      ...domain.clusters.map((cluster) => Math.hypot(cluster.x, cluster.y) + cluster.radius),
    ) + DOMAIN_PADDING);
    domain.cluster_count = domain.clusters.length;
  }
  packGraphCircles(domains, DOMAIN_GAP, DOMAIN_SPIRAL_STEP);
  for (const domain of domains) {
    for (const cluster of domain.clusters) {
      cluster.x += domain.x;
      cluster.y += domain.y;
    }
  }

  const serialClusters: ExactScopeLayoutCluster[] = clusters.map(({ domainKey: _domainKey, ...cluster }) => ({
    ...cluster,
    x: roundGraphCoordinate(cluster.x),
    y: roundGraphCoordinate(cluster.y),
  }));
  const serialDomains: ExactScopeLayoutDomain[] = domains.map(({ clusters: _clusters, ...domain }) => ({
    ...domain,
    x: roundGraphCoordinate(domain.x),
    y: roundGraphCoordinate(domain.y),
  }));
  return {
    layout: {
      strategy: 'exact-directory-file-v1',
      node_spacing: 16,
      counts_scope: 'all_nodes',
      clusters: serialClusters,
      domains: serialDomains,
    },
    scopeKey,
    selectedDomains,
    selectedFiles,
    domainByKey: new Map(serialDomains.map((domain) => [domain.key, domain])),
    clusterByKey: new Map(serialClusters.map((cluster) => [cluster.key, cluster])),
  };
}

export function positionExactScopeLayoutNode<T extends ExactScopeLayoutNode>(
  plan: ExactScopeLayoutPlan,
  node: T,
): T & { x: number; y: number; cluster_id: number } {
  const domainKey = mappedDomainKey(
    rawDomainKey(node, plan.scopeKey),
    plan.selectedDomains,
    plan.scopeKey,
  );
  const fileKey = nodePathParts(node).file;
  const clusterKey = plan.selectedFiles.has(`${domainKey}\0${fileKey}`)
    ? fileKey
    : otherFilesKey(domainKey);
  const cluster = plan.clusterByKey.get(clusterKey)!;
  const radialUnit = stableGraphHash(`${plan.scopeKey}:${node.id}:radius`) / 0x1_0000_0000;
  const angularUnit = stableGraphHash(`${plan.scopeKey}:${node.id}:angle`) / 0x1_0000_0000;
  const structuralScale = STRUCTURAL_LABELS.has(node.label) ? 0.34 : 1;
  const radius = Math.sqrt(radialUnit) * Math.max(0, cluster.radius - 18) * structuralScale;
  const angle = angularUnit * Math.PI * 2;
  return {
    ...node,
    x: roundGraphCoordinate(cluster.x + Math.cos(angle) * radius),
    y: roundGraphCoordinate(cluster.y + Math.sin(angle) * radius),
    cluster_id: cluster.id,
  };
}
