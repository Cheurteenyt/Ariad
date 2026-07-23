import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  assertPathInsideRoot,
  isPathInside,
  safeRealpathStrict,
} from '../utils/safe-path.js';

const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_MANIFESTS = 2048;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;

export interface StructuralTypeTarget {
  name: string;
  path: string;
}

export interface StructuralTypeTargetCandidate {
  name: string;
  path: string;
  definition_line: number;
  declaration_kind: 'type' | 'interface' | 'class' | 'enum';
}

export interface StructuralTypeDependentsResult {
  files: string[];
  total_files: number;
  files_truncated: boolean;
  dependent_symbols: number;
  target_candidates: StructuralTypeTargetCandidate[];
  complete: boolean;
  incomplete_reasons: string[];
  source_files_analyzed: number;
}

interface AnalysisInputs {
  rootNames: string[];
  repositoryPathByAbsolute: Map<string, string>;
  incompleteReasons: Set<string>;
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
  return /\.(?:[cm]?tsx?)$/iu.test(filePath);
}

/** Keep production `src/.../test` packages while excluding test roots/files. */
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

function collectAnalysisInputs(root: string, indexedPaths: readonly string[]): AnalysisInputs {
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

function exportedTypeTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportedTypeTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['types', 'typings', 'import', 'default', 'require']) {
    const target = exportedTypeTarget(record[key]);
    if (target) return target;
  }
  return null;
}

function workspacePackagePaths(
  root: string,
  indexedPaths: readonly string[],
  incompleteReasons: Set<string>,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const manifests = [...new Set(indexedPaths.map(normalizedRepositoryPath).filter((path) => (
    path === 'package.json' || path.endsWith('/package.json')
  )))].sort(stableCompare);
  if (manifests.length > MAX_PACKAGE_MANIFESTS) incompleteReasons.add('package_manifest_limit');

  for (const manifestPath of manifests.slice(0, MAX_PACKAGE_MANIFESTS)) {
    try {
      const absolutePath = assertPathInsideRoot(root, manifestPath);
      if (!isPathInside(root, absolutePath)) throw new Error('package manifest escaped root');
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile() || fileStat.size > MAX_PACKAGE_MANIFEST_BYTES) {
        incompleteReasons.add('package_manifest_unreadable');
        continue;
      }
      const manifest = JSON.parse(readFileSync(absolutePath, 'utf8')) as Record<string, unknown>;
      const name = typeof manifest.name === 'string' ? manifest.name : '';
      if (!name) continue;
      const packageDirectory = normalizedRepositoryPath(manifestPath.slice(0, -'package.json'.length))
        .replace(/\/$/u, '');
      const relativeTarget = (target: string): string => {
        const normalized = normalizedRepositoryPath(target);
        return packageDirectory ? `./${packageDirectory}/${normalized}` : `./${normalized}`;
      };
      const add = (specifier: string, target: string | null, allowBareTarget = false): void => {
        if (!target || paths[specifier]) return;
        const normalizedTarget = target.replace(/\\/gu, '/');
        const localTarget = normalizedTarget.startsWith('./')
          ? normalizedTarget.slice(2)
          : allowBareTarget
            ? normalizedTarget
            : null;
        if (
          !localTarget
          || localTarget.startsWith('/')
          || /^[a-z]:/iu.test(localTarget)
          || localTarget.split('/').some((part) => part === '..')
          || /[\r\n\0]/u.test(localTarget)
        ) {
          incompleteReasons.add('package_manifest_unsafe_target');
          return;
        }
        paths[specifier] = [relativeTarget(localTarget)];
      };

      add(name, typeof manifest.types === 'string'
        ? manifest.types
        : typeof manifest.typings === 'string'
          ? manifest.typings
          : null, true);
      const exportsValue = manifest.exports;
      if (exportsValue && typeof exportsValue === 'object' && !Array.isArray(exportsValue)) {
        const exportsRecord = exportsValue as Record<string, unknown>;
        const subpathKeys = Object.keys(exportsRecord).filter((key) => key === '.' || key.startsWith('./'));
        if (subpathKeys.length > 0) {
          for (const subpath of subpathKeys) {
            const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
            add(specifier, exportedTypeTarget(exportsRecord[subpath]));
          }
        } else {
          add(name, exportedTypeTarget(exportsRecord));
        }
      }
      if (!paths[name]) add(name, exportedTypeTarget(manifest.main), true);
      if (!paths[`${name}/*`]) {
        paths[`${name}/*`] = [packageDirectory ? `./${packageDirectory}/*` : './*'];
      }
    } catch {
      incompleteReasons.add('package_manifest_unreadable');
    }
  }
  return paths;
}

function compilerOptions(
  root: string,
  indexedPaths: readonly string[],
  incompleteReasons: Set<string>,
): ts.CompilerOptions {
  let configured: ts.CompilerOptions = {};
  const configPath = join(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      incompleteReasons.add('tsconfig_unreadable');
    } else {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
      if (parsed.errors.length > 0) incompleteReasons.add('tsconfig_invalid');
      configured = parsed.options;
    }
  }
  const workspacePaths = workspacePackagePaths(root, indexedPaths, incompleteReasons);
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
    paths: { ...workspacePaths, ...(configured.paths ?? {}) },
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
    return declarations.map((declaration) => {
      const source = declaration.getSourceFile();
      return `${absolutePathKey(source.fileName)}:${declaration.pos}:${declaration.end}`;
    }).sort(stableCompare).join('|');
  }
  return `synthetic:${canonical.flags}:${canonical.getName()}`;
}

function namedTypeDeclaration(node: ts.Node): node is (
  ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration | ts.EnumDeclaration
) {
  return (
    ts.isTypeAliasDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
  ) && Boolean(node.name && ts.isIdentifier(node.name));
}

function declarationKind(
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration | ts.EnumDeclaration,
): StructuralTypeTargetCandidate['declaration_kind'] {
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isClassDeclaration(node)) return 'class';
  return 'enum';
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

function matchesPrefix(filePath: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => filePath === prefix || filePath.startsWith(
    prefix.endsWith('/') ? prefix : `${prefix}/`,
  ));
}

export function traceStructuralTypeDependents(options: {
  root: string;
  indexedPaths: readonly string[];
  target: StructuralTypeTarget;
  includePrefixes: readonly string[];
  includeTests: boolean;
  maxFiles: number;
}): StructuralTypeDependentsResult {
  const root = safeRealpathStrict(options.root);
  const inputs = collectAnalysisInputs(root, options.indexedPaths);
  const reasons = inputs.incompleteReasons;
  if (inputs.rootNames.length === 0) reasons.add('no_supported_source_files');

  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: inputs.rootNames,
      options: compilerOptions(root, options.indexedPaths, reasons),
    });
  } catch {
    reasons.add('typescript_program_failed');
    return {
      files: [],
      total_files: 0,
      files_truncated: false,
      dependent_symbols: 0,
      target_candidates: [],
      complete: false,
      incomplete_reasons: [...reasons].sort(stableCompare),
      source_files_analyzed: 0,
    };
  }

  const checker = program.getTypeChecker();
  const targetPath = normalizedRepositoryPath(options.target.path);
  const targetSource = program.getSourceFiles().find((source) => (
    repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute) === targetPath
  ));
  if (!targetSource) reasons.add('target_source_not_found');

  const targetDeclarations: Array<
    ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration | ts.EnumDeclaration
  > = [];
  if (targetSource) {
    const visitTarget = (node: ts.Node): void => {
      if (namedTypeDeclaration(node) && node.name?.text === options.target.name) {
        targetDeclarations.push(node);
      }
      ts.forEachChild(node, visitTarget);
    };
    visitTarget(targetSource);
  }
  if (targetDeclarations.length === 0) reasons.add('target_symbol_not_found');
  if (targetDeclarations.length > 1) reasons.add('target_symbol_ambiguous');

  const targetCandidates = targetDeclarations.map((declaration) => ({
    name: options.target.name,
    path: targetPath,
    definition_line: sourceLine(declaration.getSourceFile(), declaration),
    declaration_kind: declarationKind(declaration),
  })).sort((left, right) => (
    left.definition_line - right.definition_line
    || stableCompare(left.declaration_kind, right.declaration_kind)
  ));

  const originKey = targetDeclarations.length === 1
    ? symbolKey(checker, symbolAt(checker, targetDeclarations[0].name!))
    : null;
  if (!originKey && targetDeclarations.length === 1) reasons.add('target_symbol_identity_unavailable');

  const reverseDependencies = new Map<string, Set<string>>();
  const eligibleSources: Array<{ source: ts.SourceFile; path: string }> = [];
  for (const source of program.getSourceFiles()) {
    const path = repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute);
    if (!path || (!options.includeTests && !productionSourcePath(path))) continue;
    eligibleSources.push({ source, path });

    const visitDeclaration = (node: ts.Node): void => {
      if (namedTypeDeclaration(node)) {
        const dependent = symbolKey(checker, symbolAt(checker, node.name!));
        if (dependent) {
          const dependencies = new Set<string>();
          const visitType = (nested: ts.Node): void => {
            if (nested !== node.name && ts.isIdentifier(nested)) {
              const referenced = symbolKey(checker, symbolAt(checker, nested));
              if (referenced && referenced !== dependent) dependencies.add(referenced);
            }
            ts.forEachChild(nested, visitType);
          };
          visitType(node);
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

  const impacted = new Set<string>();
  const queue: string[] = [];
  if (originKey) {
    impacted.add(originKey);
    queue.push(originKey);
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
  if (originKey) {
    for (const { source, path } of eligibleSources) {
      if (!matchesPrefix(path, options.includePrefixes)) continue;
      const visitReference = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const key = symbolKey(checker, symbolAt(checker, node));
          if (key && impacted.has(key)) files.add(path);
        }
        ts.forEachChild(node, visitReference);
      };
      visitReference(source);

      const visitStarExports = (node: ts.Node): void => {
        if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
          const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
          if (moduleSymbol && checker.getExportsOfModule(moduleSymbol).some((symbol) => {
            const key = symbolKey(checker, symbol);
            return key ? impacted.has(key) : false;
          })) files.add(path);
        }
        ts.forEachChild(node, visitStarExports);
      };
      visitStarExports(source);
    }
  }

  const orderedFiles = [...files].sort(stableCompare);
  const safeMaxFiles = Math.max(1, Math.floor(options.maxFiles));
  const filesTruncated = orderedFiles.length > safeMaxFiles;
  if (filesTruncated) reasons.add('result_files_truncated');

  return {
    files: orderedFiles.slice(0, safeMaxFiles),
    total_files: orderedFiles.length,
    files_truncated: filesTruncated,
    dependent_symbols: impacted.size,
    target_candidates: targetCandidates,
    complete: reasons.size === 0,
    incomplete_reasons: [...reasons].sort(stableCompare),
    source_files_analyzed: eligibleSources.length,
  };
}
