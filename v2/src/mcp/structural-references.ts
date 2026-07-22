import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  assertPathInsideRoot,
  isPathInside,
  safeRealpathStrict,
} from '../utils/safe-path.js';

const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_PACKAGES = 2_000;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface StructuralReferenceTarget {
  name: string;
  path: string;
  definitionLine?: number;
}

export interface StructuralReferenceOptions {
  root: string;
  indexedPaths: readonly string[];
  target: StructuralReferenceTarget;
  includeTests: boolean;
  scopePrefix?: string;
  maxResults: number;
}

export interface StructuralCallSite {
  path: string;
  line: number;
  column: number;
}

export interface StructuralCallSiteResult {
  call_sites: StructuralCallSite[];
  results_truncated: boolean;
  complete: boolean;
  incomplete_reasons: string[];
  source_files_analyzed: number;
}

export interface StructuralTypeImpactResult {
  files: string[];
  results_truncated: boolean;
  complete: boolean;
  incomplete_reasons: string[];
  source_files_analyzed: number;
}

interface AnalysisInputs {
  rootNames: string[];
  repositoryPathByAbsolute: Map<string, string>;
  incompleteReasons: Set<string>;
}

interface RepositorySource {
  path: string;
  source: ts.SourceFile;
}

interface StructuralAnalysis {
  checker: ts.TypeChecker | null;
  sources: RepositorySource[];
  targetKey: string | null;
  reasons: Set<string>;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRepositoryPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function absolutePathKey(filePath: string): string {
  const absolute = resolve(filePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function supportedSourcePath(filePath: string): boolean {
  return /\.(?:tsx?|[cm]ts)$/iu.test(filePath);
}

/**
 * A product directory named src/.../test remains production. Repository test
 * roots and test/spec files are excluded by default.
 */
function productionSourcePath(filePath: string): boolean {
  const normalized = normalizedRepositoryPath(filePath).toLowerCase();
  if (/(^|\/)node_modules(\/|$)/u.test(normalized)) return false;
  if (/(^|\/)(?:tests|__tests__)(\/|$)/u.test(normalized)) return false;
  if (
    /(^|\/)test(\/|$)/u.test(normalized)
    && !/(^|\/)src\/.*\/test(\/|$)/u.test(normalized)
  ) return false;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
}

function normalizedScopePrefix(scopePrefix: string | undefined): string | undefined {
  if (scopePrefix === undefined) return undefined;
  const normalized = normalizedRepositoryPath(scopePrefix).replace(/\/+$/u, '');
  if (
    normalized.length === 0
    || isAbsolute(normalized)
    || normalized.split('/').some((part) => part === '..')
  ) throw new Error('Argument scope_prefix must be a non-empty repository-relative path prefix.');
  return normalized;
}

function pathInScope(filePath: string, scopePrefix: string | undefined): boolean {
  return scopePrefix === undefined
    || filePath === scopePrefix
    || filePath.startsWith(`${scopePrefix}/`);
}

function collectAnalysisInputs(
  root: string,
  indexedPaths: readonly string[],
): AnalysisInputs {
  const realRoot = safeRealpathStrict(root);
  const rootNames: string[] = [];
  const repositoryPathByAbsolute = new Map<string, string>();
  const incompleteReasons = new Set<string>();
  let totalBytes = 0;

  for (const rawPath of indexedPaths) {
    const repositoryPath = normalizedRepositoryPath(rawPath);
    if (!supportedSourcePath(repositoryPath)) continue;
    if (
      repositoryPath.length === 0
      || isAbsolute(repositoryPath)
      || repositoryPath.split('/').some((part) => part === '..')
    ) {
      incompleteReasons.add('unsafe_source_paths');
      continue;
    }

    let absolutePath: string;
    try {
      absolutePath = assertPathInsideRoot(realRoot, repositoryPath);
      if (!isPathInside(realRoot, absolutePath)) throw new Error('source path escaped root');
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile()) throw new Error('source path is not a file');
      if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
        incompleteReasons.add('oversized_source_files');
        continue;
      }
      if (totalBytes + fileStat.size > MAX_SOURCE_BYTES) {
        incompleteReasons.add('source_byte_budget');
        break;
      }
      totalBytes += fileStat.size;
    } catch {
      incompleteReasons.add('unreadable_source_files');
      continue;
    }

    const key = absolutePathKey(absolutePath);
    if (repositoryPathByAbsolute.has(key)) continue;
    repositoryPathByAbsolute.set(key, repositoryPath);
    rootNames.push(absolutePath);
  }

  rootNames.sort(stableCompare);
  return { rootNames, repositoryPathByAbsolute, incompleteReasons };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const fileStat = statSync(path);
    if (!fileStat.isFile() || fileStat.size > MAX_PACKAGE_JSON_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function workspacePatterns(rootPackage: Record<string, unknown>): string[] {
  const value = rootPackage.workspaces;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const packages = (value as Record<string, unknown>).packages;
    if (Array.isArray(packages)) return packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function workspaceDirectories(root: string, pattern: string): string[] {
  const normalized = normalizedRepositoryPath(pattern).replace(/\/+$/u, '');
  if (
    normalized.length === 0
    || isAbsolute(normalized)
    || normalized.split('/').some((part) => part === '..')
  ) return [];
  const parts = normalized.split('/');
  const wildcardIndex = parts.indexOf('*');
  if (wildcardIndex === -1) return [normalized];
  if (wildcardIndex !== parts.length - 1 || parts.filter((part) => part === '*').length !== 1) return [];
  const parent = parts.slice(0, -1).join('/');
  const absoluteParent = resolve(root, ...parent.split('/'));
  if (!isPathInside(root, absoluteParent)) return [];
  try {
    const realParent = safeRealpathStrict(absoluteParent);
    if (!isPathInside(root, realParent)) return [];
    return readdirSync(realParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`.replace(/^\//u, ''))
      .sort(stableCompare);
  } catch {
    return [];
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return stringField(object.types)
    ?? stringField(object.import)
    ?? stringField(object.default)
    ?? stringField(object.require);
}

function addWorkspacePackagePaths(
  root: string,
  configuredPaths: Record<string, string[]>,
  reasons: Set<string>,
): Record<string, string[]> {
  const result = { ...configuredPaths };
  const rootPackage = readJsonObject(join(root, 'package.json'));
  if (!rootPackage) return result;
  const directories = [...new Set(workspacePatterns(rootPackage)
    .flatMap((pattern) => workspaceDirectories(root, pattern)))]
    .sort(stableCompare);
  if (directories.length > MAX_WORKSPACE_PACKAGES) reasons.add('workspace_package_limit');

  for (const directory of directories.slice(0, MAX_WORKSPACE_PACKAGES)) {
    let manifestPath: string;
    try {
      manifestPath = assertPathInsideRoot(root, `${directory}/package.json`);
    } catch {
      reasons.add('workspace_manifest_unsafe');
      continue;
    }
    const manifest = readJsonObject(manifestPath);
    const packageName = manifest ? stringField(manifest.name) : undefined;
    if (!manifest || !packageName) continue;
    const exports = manifest.exports;
    if (exports !== null && typeof exports === 'object' && !Array.isArray(exports)) {
      for (const [subpath, value] of Object.entries(exports as Record<string, unknown>)) {
        if (subpath !== '.' && !subpath.startsWith('./')) continue;
        const target = exportTarget(value);
        if (
          !target
          || isAbsolute(target)
          || target.includes('\\')
          || target.split('/').some((part) => part === '..')
        ) continue;
        const key = subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`;
        result[key] ??= [`./${directory}/${target.replace(/^\.\//u, '')}`];
      }
    }
    const rootTargetCandidate = stringField(manifest.types)
      ?? stringField(manifest.typings)
      ?? exportTarget(manifest.exports)
      ?? 'index.d.ts';
    const rootTarget = !isAbsolute(rootTargetCandidate)
      && !rootTargetCandidate.split('/').some((part) => part === '..')
      && !rootTargetCandidate.includes('\\')
      ? rootTargetCandidate
      : 'index.d.ts';
    result[packageName] ??= [`./${directory}/${rootTarget.replace(/^\.\//u, '')}`];
  }
  return result;
}

function compilerOptions(root: string, reasons: Set<string>): ts.CompilerOptions {
  let configured: ts.CompilerOptions = {};
  const configPath = join(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      reasons.add('tsconfig_unreadable');
    } else {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
      if (parsed.errors.length > 0) reasons.add('tsconfig_invalid');
      configured = parsed.options;
    }
  }
  const configuredPaths = Object.fromEntries(Object.entries(configured.paths ?? {})
    .map(([key, values]) => [key, [...values]]));
  return {
    ...configured,
    allowImportingTsExtensions: true,
    allowJs: false,
    baseUrl: configured.baseUrl ?? root,
    checkJs: false,
    jsx: configured.jsx ?? ts.JsxEmit.ReactJSX,
    module: configured.module ?? ts.ModuleKind.ESNext,
    moduleResolution: configured.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: addWorkspacePackagePaths(root, configuredPaths, reasons),
    skipLibCheck: true,
    target: configured.target ?? ts.ScriptTarget.ESNext,
  };
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return canonicalSymbol(checker, checker.getSymbolAtLocation(node));
}

function symbolKey(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | null {
  const canonical = canonicalSymbol(checker, symbol);
  if (!canonical) return null;
  const roots = checker.getRootSymbols(canonical);
  const identities = roots.length > 0 ? roots : [canonical];
  const declarations = identities.flatMap((identity) => (
    identity.declarations ?? (identity.valueDeclaration ? [identity.valueDeclaration] : [])
  ));
  if (declarations.length > 0) {
    return declarations.map((declaration) => (
      `${absolutePathKey(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`
    )).sort(stableCompare).join('|');
  }
  return `synthetic:${canonical.flags}:${canonical.getName()}`;
}

function repositoryPathForSource(
  root: string,
  source: ts.SourceFile,
  repositoryPathByAbsolute: ReadonlyMap<string, string>,
): string | null {
  const direct = repositoryPathByAbsolute.get(absolutePathKey(source.fileName));
  if (direct) return direct;
  const relativePath = normalizedRepositoryPath(relative(root, source.fileName));
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) return null;
  return repositoryPathByAbsolute.has(absolutePathKey(resolve(root, relativePath)))
    ? relativePath
    : null;
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function namedNode(node: ts.Node): ts.Identifier | ts.StringLiteral | null {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isVariableDeclaration(node)
      || ts.isPropertyAssignment(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isEnumDeclaration(node))
    && node.name
    && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) return node.name;
  return null;
}

function isCallableTarget(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isVariableDeclaration(node)) {
    return !!node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
  }
  return ts.isPropertyAssignment(node)
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
}

function isNamedTypeTarget(node: ts.Node): boolean {
  return ts.isTypeAliasDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node);
}

function findTargetKeys(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  target: StructuralReferenceTarget,
  kind: 'callable' | 'type',
): string[] {
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = namedNode(node);
    const validKind = kind === 'callable' ? isCallableTarget(node) : isNamedTypeTarget(node);
    if (
      validKind
      && name?.text === target.name
      && (target.definitionLine === undefined || sourceLine(source, name) === target.definitionLine)
    ) {
      const key = symbolKey(checker, symbolAt(checker, name));
      if (key) keys.add(key);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...keys].sort(stableCompare);
}

function buildAnalysis(
  options: StructuralReferenceOptions,
  kind: 'callable' | 'type',
): StructuralAnalysis {
  const root = safeRealpathStrict(options.root);
  const inputs = collectAnalysisInputs(root, options.indexedPaths);
  const reasons = inputs.incompleteReasons;
  if (inputs.rootNames.length === 0) reasons.add('no_supported_source_files');

  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: inputs.rootNames,
      options: compilerOptions(root, reasons),
    });
  } catch {
    reasons.add('typescript_program_failed');
    return { checker: null, sources: [], targetKey: null, reasons };
  }

  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().map((source): RepositorySource | null => {
    const path = repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute);
    return path ? { path, source } : null;
  }).filter((entry): entry is RepositorySource => entry !== null)
    .sort((left, right) => stableCompare(left.path, right.path));
  const targetPath = normalizedRepositoryPath(options.target.path);
  const targetSource = sources.find((entry) => entry.path === targetPath)?.source;
  if (!targetSource) reasons.add('target_source_not_found');
  const targetKeys = targetSource ? findTargetKeys(checker, targetSource, options.target, kind) : [];
  if (targetKeys.length === 0) reasons.add('target_symbol_not_found');
  if (targetKeys.length > 1) reasons.add('target_symbol_ambiguous');
  return {
    checker,
    sources,
    targetKey: targetKeys.length === 1 ? targetKeys[0] : null,
    reasons,
  };
}

function calleeSymbol(checker: ts.TypeChecker, expression: ts.LeftHandSideExpression): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) return symbolAt(checker, expression);
  if (ts.isPropertyAccessExpression(expression)) return symbolAt(checker, expression.name);
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) return symbolAt(checker, expression.argumentExpression);
  return undefined;
}

function sourceLocation(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: location.line + 1, column: location.character + 1 };
}

function analyzableSources(
  analysis: StructuralAnalysis,
  options: StructuralReferenceOptions,
): RepositorySource[] {
  const scopePrefix = normalizedScopePrefix(options.scopePrefix);
  return analysis.sources.filter(({ path }) => (
    pathInScope(path, scopePrefix)
    && (options.includeTests || productionSourcePath(path))
  ));
}

export function findStructuralCallSites(
  options: StructuralReferenceOptions,
): StructuralCallSiteResult {
  const analysis = buildAnalysis(options, 'callable');
  const callSites: StructuralCallSite[] = [];
  const sources = analyzableSources(analysis, options);
  let sourceFilesAnalyzed = 0;
  let totalCallSites = 0;
  const callSiteKey = (site: StructuralCallSite): string => (
    `${site.path}:${site.line}:${site.column}`
  );
  const insertBounded = (site: StructuralCallSite): void => {
    let low = 0;
    let high = callSites.length;
    const key = callSiteKey(site);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (stableCompare(callSiteKey(callSites[middle]), key) <= 0) low = middle + 1;
      else high = middle;
    }
    callSites.splice(low, 0, site);
    if (callSites.length > options.maxResults) callSites.pop();
  };
  if (analysis.checker && analysis.targetKey) {
    for (const { path, source } of sources) {
      sourceFilesAnalyzed++;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && symbolKey(analysis.checker!, calleeSymbol(analysis.checker!, node.expression)) === analysis.targetKey
        ) {
          totalCallSites++;
          insertBounded({ path, ...sourceLocation(source, node) });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const resultsTruncated = totalCallSites > options.maxResults;
  if (resultsTruncated) analysis.reasons.add('results_truncated');
  return {
    call_sites: callSites,
    results_truncated: resultsTruncated,
    complete: analysis.reasons.size === 0,
    incomplete_reasons: [...analysis.reasons].sort(stableCompare),
    source_files_analyzed: sourceFilesAnalyzed,
  };
}

function namedTypeDeclaration(node: ts.Node): ts.Identifier | null {
  if (
    ts.isTypeAliasDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isEnumDeclaration(node)
  ) return node.name;
  if (ts.isClassDeclaration(node) && node.name) return node.name;
  return null;
}

export function findTransitiveTypeImpact(
  options: StructuralReferenceOptions,
): StructuralTypeImpactResult {
  const analysis = buildAnalysis(options, 'type');
  const sources = analyzableSources(analysis, options);
  const checker = analysis.checker;
  const reverseDependencies = new Map<string, Set<string>>();
  let sourceFilesAnalyzed = 0;

  if (checker && analysis.targetKey) {
    for (const { source } of sources) {
      sourceFilesAnalyzed++;
      const visitDeclaration = (node: ts.Node): void => {
        const name = namedTypeDeclaration(node);
        if (name) {
          const dependent = symbolKey(checker, symbolAt(checker, name));
          const dependencies = new Set<string>();
          const visitType = (child: ts.Node): void => {
            if (child !== name && ts.isIdentifier(child)) {
              const referenced = symbolKey(checker, symbolAt(checker, child));
              if (referenced && referenced !== dependent) dependencies.add(referenced);
            }
            ts.forEachChild(child, visitType);
          };
          visitType(node);
          if (dependent) {
            for (const dependency of dependencies) {
              const dependents = reverseDependencies.get(dependency) ?? new Set<string>();
              dependents.add(dependent);
              reverseDependencies.set(dependency, dependents);
            }
          }
        }
        ts.forEachChild(node, visitDeclaration);
      };
      visitDeclaration(source);
    }
  }

  const impacted = new Set<string>();
  const queue: string[] = [];
  if (analysis.targetKey) {
    impacted.add(analysis.targetKey);
    queue.push(analysis.targetKey);
  }
  while (queue.length > 0) {
    const dependency = queue.shift()!;
    for (const dependent of reverseDependencies.get(dependency) ?? []) {
      if (impacted.has(dependent)) continue;
      impacted.add(dependent);
      queue.push(dependent);
    }
  }

  const files = new Set<string>();
  if (checker && analysis.targetKey) {
    for (const { path, source } of sources) {
      const visitReference = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node)
          && impacted.has(symbolKey(checker, symbolAt(checker, node)) ?? '')
        ) files.add(path);
        ts.forEachChild(node, visitReference);
      };
      visitReference(source);

      const visitStarExports = (node: ts.Node): void => {
        if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
          const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
          if (
            moduleSymbol
            && checker.getExportsOfModule(moduleSymbol)
              .some((symbol) => impacted.has(symbolKey(checker, symbol) ?? ''))
          ) files.add(path);
        }
        ts.forEachChild(node, visitStarExports);
      };
      visitStarExports(source);
    }
  }

  const sortedFiles = [...files].sort(stableCompare);
  const resultsTruncated = sortedFiles.length > options.maxResults;
  if (resultsTruncated) analysis.reasons.add('results_truncated');
  return {
    files: sortedFiles.slice(0, options.maxResults),
    results_truncated: resultsTruncated,
    complete: analysis.reasons.size === 0,
    incomplete_reasons: [...analysis.reasons].sort(stableCompare),
    source_files_analyzed: sourceFilesAnalyzed,
  };
}
