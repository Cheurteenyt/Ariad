import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import { BaseTool } from './base.js';
import type { ToolDefinition } from './index.js';
import {
  assertPathInsideRoot,
  isPathInside,
  safeRealpathStrict,
} from '../../utils/safe-path.js';

const MAX_QUERIES = 10;
const MAX_QUERY_LENGTH = 256;
const DEFAULT_RESULTS_PER_QUERY = 20;
const MAX_RESULTS_PER_QUERY = 50;
const MAX_INDEXED_FILES = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500;

interface SourceMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  text_truncated?: true;
}

interface QueryResult {
  query: string;
  matches: SourceMatch[];
  matches_truncated: boolean;
}

interface IncompleteReasons {
  unsafe_paths?: number;
  unreadable_files?: number;
  non_file_paths?: number;
  oversized_files?: number;
  binary_files?: number;
  indexed_file_limit?: number;
  byte_budget?: number;
}

function stablePathCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedIndexedPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function hasParentTraversal(filePath: string): boolean {
  return filePath.split('/').some((part) => part === '..');
}

function lineStartsFor(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function sourceMatch(
  content: string,
  starts: number[],
  offset: number,
  filePath: string,
): SourceMatch {
  const lineIndex = lineIndexAt(starts, offset);
  const lineStart = starts[lineIndex];
  let lineEnd = content.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) lineEnd--;

  const fullLine = content.slice(lineStart, lineEnd);
  const columnOffset = offset - lineStart;
  if (fullLine.length <= MAX_TEXT_LENGTH) {
    return {
      path: filePath,
      line: lineIndex + 1,
      column: columnOffset + 1,
      text: fullLine,
    };
  }

  const excerptStart = Math.max(
    0,
    Math.min(columnOffset - 120, fullLine.length - MAX_TEXT_LENGTH),
  );
  const excerptEnd = Math.min(fullLine.length, excerptStart + MAX_TEXT_LENGTH);
  return {
    path: filePath,
    line: lineIndex + 1,
    column: columnOffset + 1,
    text: `${excerptStart > 0 ? '…' : ''}${fullLine.slice(excerptStart, excerptEnd)}${excerptEnd < fullLine.length ? '…' : ''}`,
    text_truncated: true,
  };
}

function incrementReason(reasons: IncompleteReasons, key: keyof IncompleteReasons): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

export class LookupSourceTextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'lookup_source_text',
      description: 'Find exact case-sensitive single-line literals in indexed project files. Use one bounded call to retrieve exact declaration values or 1-based source occurrence lines; accepts up to 10 literals and returns only matching line excerpts.',
      annotations: {
        title: 'Look up exact source text',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUERIES,
            items: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
            description: 'Unique, case-sensitive, single-line literal strings to find.',
          },
          max_results_per_query: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_RESULTS_PER_QUERY,
            default: DEFAULT_RESULTS_PER_QUERY,
          },
        },
        required: ['queries'],
        additionalProperties: false,
      },
      handler: LookupSourceTextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const queries = this.validateQueries(args);
      const maxResults = Math.max(1, Math.min(
        MAX_RESULTS_PER_QUERY,
        Math.floor(this.optionalNumber(args, 'max_results_per_query') ?? DEFAULT_RESULTS_PER_QUERY),
      ));
      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph reader not configured. Index the project first.');
      }
      const root = codeReader.getProjectRoot(project);
      if (!root) {
        return this.error(`Indexed repository root is unavailable for project "${project}".`);
      }
      const realRoot = safeRealpathStrict(root);

      const indexedPathProbe = codeReader.listProjectFilePaths(project, MAX_INDEXED_FILES + 1);
      const reasons: IncompleteReasons = {};
      if (indexedPathProbe.length > MAX_INDEXED_FILES) {
        reasons.indexed_file_limit = indexedPathProbe.length - MAX_INDEXED_FILES;
      }
      const indexedPaths = [...new Set(
        indexedPathProbe
          .slice(0, MAX_INDEXED_FILES)
          .map(normalizedIndexedPath),
      )].sort(stablePathCompare);

      const results: QueryResult[] = queries.map((query) => ({
        query,
        matches: [],
        matches_truncated: false,
      }));
      const seenRealPaths = new Set<string>();
      let filesScanned = 0;
      let bytesScanned = 0;

      for (const filePath of indexedPaths) {
        if (
          filePath.length === 0
          || hasParentTraversal(filePath)
          || (!isAbsolute(filePath) && (posix.isAbsolute(filePath) || win32.isAbsolute(filePath)))
        ) {
          incrementReason(reasons, 'unsafe_paths');
          continue;
        }

        let realFilePath: string;
        try {
          realFilePath = isAbsolute(filePath)
            ? safeRealpathStrict(filePath)
            : assertPathInsideRoot(realRoot, filePath);
          if (!isPathInside(realRoot, realFilePath)) {
            incrementReason(reasons, 'unsafe_paths');
            continue;
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('Path traversal rejected')) {
            incrementReason(reasons, 'unsafe_paths');
          } else {
            incrementReason(reasons, 'unreadable_files');
          }
          continue;
        }

        const realPathKey = process.platform === 'win32'
          ? realFilePath.toLowerCase()
          : realFilePath;
        if (seenRealPaths.has(realPathKey)) continue;
        seenRealPaths.add(realPathKey);

        let fileStat;
        try {
          fileStat = await stat(realFilePath);
        } catch {
          incrementReason(reasons, 'unreadable_files');
          continue;
        }
        if (!fileStat.isFile()) {
          incrementReason(reasons, 'non_file_paths');
          continue;
        }
        if (fileStat.size > MAX_FILE_BYTES) {
          incrementReason(reasons, 'oversized_files');
          continue;
        }
        if (bytesScanned + fileStat.size > MAX_TOTAL_BYTES) {
          incrementReason(reasons, 'byte_budget');
          break;
        }

        let buffer: Buffer;
        try {
          buffer = await readFile(realFilePath);
        } catch {
          incrementReason(reasons, 'unreadable_files');
          continue;
        }
        if (buffer.length > MAX_FILE_BYTES) {
          incrementReason(reasons, 'oversized_files');
          continue;
        }
        if (bytesScanned + buffer.length > MAX_TOTAL_BYTES) {
          incrementReason(reasons, 'byte_budget');
          break;
        }
        filesScanned++;
        bytesScanned += buffer.length;
        if (buffer.includes(0)) {
          incrementReason(reasons, 'binary_files');
          continue;
        }

        const content = buffer.toString('utf8');
        let starts: number[] | undefined;
        for (const result of results) {
          if (result.matches_truncated) continue;
          let offset = content.indexOf(result.query);
          while (offset !== -1) {
            if (result.matches.length >= maxResults) {
              result.matches_truncated = true;
              break;
            }
            starts ??= lineStartsFor(content);
            result.matches.push(sourceMatch(content, starts, offset, filePath));
            offset = content.indexOf(result.query, offset + result.query.length);
          }
        }
      }

      const response: Record<string, unknown> = {
        project,
        results,
        files_scanned: filesScanned,
        bytes_scanned: bytesScanned,
        scan_complete: Object.keys(reasons).length === 0,
      };
      if (Object.keys(reasons).length > 0) response.scan_incomplete_reasons = reasons;
      return this.json(response);
    } catch (error: unknown) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private validateQueries(args: Record<string, unknown>): string[] {
    const rawQueries = this.optionalArray(args, 'queries');
    if (!rawQueries || rawQueries.length === 0 || rawQueries.length > MAX_QUERIES) {
      throw new Error(`Argument queries must contain 1-${MAX_QUERIES} strings.`);
    }
    const queries = rawQueries.map((query, index) => {
      if (typeof query !== 'string') {
        throw new Error(`Argument queries[${index}] must be a string.`);
      }
      if (query.trim().length === 0 || query.length > MAX_QUERY_LENGTH) {
        throw new Error(`Argument queries[${index}] must contain 1-${MAX_QUERY_LENGTH} non-whitespace characters.`);
      }
      if (query.includes('\n') || query.includes('\r') || query.includes('\0')) {
        throw new Error(`Argument queries[${index}] must be a single-line text literal.`);
      }
      return query;
    });
    if (new Set(queries).size !== queries.length) {
      throw new Error('Argument queries must not contain duplicate literals.');
    }
    return queries;
  }
}
