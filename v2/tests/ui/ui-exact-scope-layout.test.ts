import { describe, expect, it } from 'vitest';
import {
  buildExactScopeLayout,
  positionExactScopeLayoutNode,
} from '../../src/exact-scope-layout.js';

const nodes = [
  { id: 1, label: 'File', file_path: 'src/auth/login.ts' },
  { id: 2, label: 'Function', file_path: 'src/auth/login.ts' },
  { id: 3, label: 'Function', file_path: 'src/auth/token.ts' },
  { id: 4, label: 'File', file_path: 'src\\billing\\invoice.ts' },
  { id: 5, label: 'Directory', file_path: 'src/generated' },
];

describe('exact scope hierarchy layout', () => {
  it('maps directory → file → symbol with portable deterministic positions', () => {
    const forward = buildExactScopeLayout(nodes, 'src');
    const reversed = buildExactScopeLayout([...nodes].reverse(), 'src');

    expect(forward.layout).toEqual(reversed.layout);
    expect(forward.layout).toMatchObject({
      strategy: 'exact-directory-file-v1',
      node_spacing: 16,
      counts_scope: 'all_nodes',
    });
    expect(forward.layout.domains.map((domain) => [domain.key, domain.node_count]))
      .toEqual([
        ['src/auth', 3],
        ['src/billing', 1],
        ['src/generated', 1],
      ]);
    expect(forward.layout.clusters.map((cluster) => cluster.key)).toEqual([
      'src/auth/login.ts',
      'src/auth/token.ts',
      'src/billing/invoice.ts',
      'src/generated',
    ]);

    const positioned = nodes.map((node) => positionExactScopeLayoutNode(forward, node));
    const reversedPositioned = [...nodes].reverse()
      .map((node) => positionExactScopeLayoutNode(reversed, node))
      .reverse();
    expect(positioned).toEqual(reversedPositioned);
    expect(positioned[0].cluster_id).toBe(positioned[1].cluster_id);
    expect(positioned[1].cluster_id).not.toBe(positioned[2].cluster_id);
    expect(positioned.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
      .toBe(true);
  });

  it('bounds hierarchy metadata while retaining every node in exact counts', () => {
    const dense = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      label: index % 3 === 0 ? 'File' : 'Function',
      file_path: `src/area-${index % 20}/file-${index}.ts`,
    }));

    const plan = buildExactScopeLayout(dense, 'src');

    expect(plan.layout.domains.length).toBeLessThanOrEqual(12);
    expect(plan.layout.clusters.length).toBeLessThanOrEqual(60);
    expect(plan.layout.domains.reduce((sum, domain) => sum + domain.node_count, 0)).toBe(120);
    expect(plan.layout.clusters.reduce((sum, cluster) => sum + cluster.node_count, 0)).toBe(120);

    for (let left = 0; left < plan.layout.domains.length; left += 1) {
      const domain = plan.layout.domains[left];
      for (const cluster of plan.layout.clusters.filter((item) => item.domain_id === domain.id)) {
        expect(Math.hypot(cluster.x - domain.x, cluster.y - domain.y) + cluster.radius)
          .toBeLessThan(domain.radius);
      }
      for (let right = left + 1; right < plan.layout.domains.length; right += 1) {
        const other = plan.layout.domains[right];
        expect(Math.hypot(domain.x - other.x, domain.y - other.y))
          .toBeGreaterThanOrEqual(domain.radius + other.radius);
      }
    }
  });
});
