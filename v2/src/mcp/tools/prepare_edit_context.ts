// v2/src/mcp/tools/prepare_edit_context.ts
// The flagship "intelligent" MCP tool.
// Given a file path (or symbol name), returns EVERYTHING the agent needs to know
// before editing: code structure, human notes, bugs, ADRs, refactors, blast radius,
// risk assessment, conventions, and stale data warnings.

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../../constants.js';
import { computeRiskScore } from '../../reports/risk.js';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';

export class PrepareEditContextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'prepare_edit_context',
      description: 'The flagship V2 tool. Call this BEFORE editing any source file. Returns: code nodes in the file, their dependencies (callers/callees), linked human notes (ADRs, bugs, refactors, conventions), blast radius (how many routes/modules/functions depend on this file), risk score, stale data warnings, and recommendations. This is the single call that makes the agent "smart" about what it is about to modify.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          file_path: {
            type: 'string',
            description: 'File path to analyze (e.g. "src/auth/login.ts"). Matches against the code graph file_path field (substring match).',
          },
          symbol_name: {
            type: 'string',
            description: 'Alternative: search by symbol name (function/class/module name) instead of file path.',
          },
        },
        anyOf: [
          { required: ['file_path'] },
          { required: ['symbol_name'] },
        ],
        additionalProperties: false,
      },
      handler: PrepareEditContextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const filePath = this.optionalString(args, 'file_path');
      const symbolName = this.optionalString(args, 'symbol_name');

      if (!filePath && !symbolName) {
        return this.error('Either file_path or symbol_name is required.');
      }

      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph not available. Run "cbm index_repository" first.');
      }

      // Step 1: Find code nodes matching the file_path or symbol_name.
      let matchingNodes: any[] = [];
      if (filePath) {
        // Search by file_path substring.
        matchingNodes = codeReader.listNodes(project, { limit: MAX_NODES_PER_LABEL });
        matchingNodes = matchingNodes.filter((n) =>
          n.file_path.toLowerCase().includes(filePath.toLowerCase())
        );
      } else if (symbolName) {
        // Search by name.
        matchingNodes = codeReader.searchCode(project, symbolName, 50);
      }

      if (matchingNodes.length === 0) {
        return this.json({
          project,
          file_path: filePath,
          symbol_name: symbolName,
          found: false,
          warning: 'No code nodes found matching the query. The file/symbol may not be indexed, or the code graph is stale.',
          graph_freshness: this.getGraphFreshness(project, codeReader),
          recommendation: 'Verify the file path or run "cbm index_repository" to refresh the code graph.',
        });
      }

      // Step 2: For each matching node, gather context.
      const nodesWithContext = [];
      const allBlastRadiusNodes = new Set<number>();
      let maxRiskScore = 0;
      let highestRiskNode: any = null;
      const allBugs: any[] = [];
      const allAdrs: any[] = [];
      const allRefactors: any[] = [];
      const allConventions: any[] = [];

      for (const node of matchingNodes.slice(0, 20)) { // limit to 20 nodes
        // Get neighbors (callers and callees).
        const neighbors = codeReader.getNeighbors(node.id, 'both', 50);
        const outNeighbors = neighbors.filter((n) => n.edge.source_id === node.id);
        const inNeighbors = neighbors.filter((n) => n.edge.target_id === node.id);

        // Blast radius: count unique nodes that depend on this node (in-edges).
        inNeighbors.forEach((n) => allBlastRadiusNodes.add(n.node.id));

        // Get human notes linked to this node.
        const humanNotes = this.humanStore.listNodesByCbmNodeId(project, node.id);
        const bugs = humanNotes.filter((n) => n.label === 'BugNote' && n.status === 'active');
        const adrs = humanNotes.filter((n) => n.label === 'ADR' && n.status === 'active');
        const refactors = humanNotes.filter((n) => n.label === 'RefactorPlan' && n.status === 'active');
        const conventions = humanNotes.filter((n) => n.label === 'Convention' && n.status === 'active');

        allBugs.push(...bugs);
        allAdrs.push(...adrs);
        allRefactors.push(...refactors);
        allConventions.push(...conventions);

        // Risk score.
        const props = safeJsonParse(node.properties_json, {} as Record<string, any>);
        const complexity = props.complexity ?? props.complexity_avg ?? 0;
        const riskScore = computeRiskScore(inNeighbors.length, complexity, humanNotes.length);
        if (riskScore > maxRiskScore) {
          maxRiskScore = riskScore;
          highestRiskNode = node;
        }

        nodesWithContext.push({
          node: {
            id: node.id,
            label: node.label,
            name: node.name,
            qualified_name: node.qualified_name,
            file_path: node.file_path,
            start_line: node.start_line,
            end_line: node.end_line,
          },
          dependencies: {
            calls: outNeighbors.slice(0, 20).map((n) => ({
              type: n.edge.type,
              target: `${n.node.label}:${n.node.name}`,
              target_id: n.node.id,
            })),
            called_by: inNeighbors.slice(0, 20).map((n) => ({
              type: n.edge.type,
              source: `${n.node.label}:${n.node.name}`,
              source_id: n.node.id,
            })),
            callers_count: inNeighbors.length,
            callees_count: outNeighbors.length,
          },
          human_notes: {
            bugs: bugs.map((b) => ({ id: b.id, title: b.title, status: b.status, body_excerpt: b.body_markdown.slice(0, 200) })),
            adrs: adrs.map((a) => ({ id: a.id, title: a.title, status: a.status, body_excerpt: a.body_markdown.slice(0, 200) })),
            refactors: refactors.map((r) => ({ id: r.id, title: r.title, status: r.status, body_excerpt: r.body_markdown.slice(0, 200) })),
            conventions: conventions.map((c) => ({ id: c.id, title: c.title, body_excerpt: c.body_markdown.slice(0, 200) })),
            total_notes: humanNotes.length,
          },
          risk: {
            score: riskScore,
            level: riskScore >= 0.7 ? 'HIGH' : riskScore >= 0.4 ? 'MEDIUM' : 'LOW',
            complexity,
            degree: inNeighbors.length + outNeighbors.length,
            documented: humanNotes.length > 0,
          },
        });
      }

      // Step 3: Build blast radius summary.
      const blastRadius = {
        total_dependent_nodes: allBlastRadiusNodes.size,
        affected_modules: this.countByLabel(matchingNodes, 'Module', codeReader, project),
        affected_routes: this.countByLabel(matchingNodes, 'Route', codeReader, project),
        affected_functions: this.countByLabel(matchingNodes, 'Function', codeReader, project),
      };

      // Step 4: Build recommendation.
      let recommendation = '';
      const warnings: string[] = [];

      if (maxRiskScore >= 0.7) {
        warnings.push(`HIGH RISK: ${highestRiskNode?.name} has risk score ${maxRiskScore.toFixed(2)}. ${allBlastRadiusNodes.size} nodes depend on this file.`);
      }
      if (allBugs.length > 0) {
        warnings.push(`${allBugs.length} known bug(s) affect this file. Review before editing: ${allBugs.map((b) => b.title).join(', ')}`);
      }
      if (allRefactors.length > 0) {
        warnings.push(`${allRefactors.length} refactor plan(s) target this file. Check if your edit conflicts: ${allRefactors.map((r) => r.title).join(', ')}`);
      }
      if (allConventions.length > 0) {
        warnings.push(`${allConventions.length} convention(s) apply to this file. Respect: ${allConventions.map((c) => c.title).join(', ')}`);
      }

      const freshness = this.getGraphFreshness(project, codeReader);
      if (freshness.score < 0.5) {
        warnings.push(`STALE DATA: Code graph freshness is ${freshness.label} (score ${freshness.score.toFixed(2)}). ${freshness.status.recommendation}`);
      }

      if (warnings.length === 0) {
        recommendation = 'SAFE TO EDIT: No known bugs, refactors, or conventions affect this file. Risk is low.';
      } else {
        recommendation = `⚠️ PROCEED WITH CAUTION:\n${warnings.map((w) => `  - ${w}`).join('\n')}`;
      }

      // Step 5: Return the complete context.
      return this.json({
        project,
        file_path: filePath,
        symbol_name: symbolName,
        found: true,
        nodes_analyzed: nodesWithContext.length,
        nodes: nodesWithContext,
        blast_radius: blastRadius,
        human_memory_summary: {
          open_bugs: allBugs.length,
          active_adrs: allAdrs.length,
          pending_refactors: allRefactors.length,
          applicable_conventions: allConventions.length,
        },
        risk_assessment: {
          max_risk_score: maxRiskScore,
          max_risk_level: maxRiskScore >= 0.7 ? 'HIGH' : maxRiskScore >= 0.4 ? 'MEDIUM' : 'LOW',
          highest_risk_node: highestRiskNode ? highestRiskNode.name : null,
        },
        graph_freshness: freshness,
        recommendation,
      });
    } catch (e: any) {
      return this.error(e.message);
    }
  }

  private getGraphFreshness(project: string, codeReader: any): any {
    try {
      const status = getGraphStatus(project, codeReader, process.cwd());
      const score = getFreshnessScore(status);
      return {
        score,
        label: freshnessLabel(score),
        status: {
          available: status.available,
          last_indexed: status.last_indexed,
          age_seconds: status.age_seconds,
          stale: status.stale,
          stale_reason: status.stale_reason,
          stale_files_count: status.stale_files_count,
          total_nodes: status.total_nodes,
          total_edges: status.total_edges,
          recommendation: status.recommendation,
        },
      };
    } catch {
      return { score: 0, label: 'UNKNOWN', status: { available: false } };
    }
  }

  private countByLabel(matchingNodes: any[], _label: string, _codeReader: any, _project: string): number {
    // Count unique modules/routes/functions in the blast radius.
    // This is a simplified version — a full implementation would traverse the graph.
    return matchingNodes.filter((n) => n.label === _label).length;
  }
}
