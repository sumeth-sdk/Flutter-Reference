import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type SymKindName = keyof typeof vscode.SymbolKind;

// Symbol kinds we lens. Hardcoded — was previously a setting, now baked in.
const INCLUDED_KINDS = new Set(
  [
    'Class',
    'Method',
    'Function',
    'Constructor',
    'Field',
    'Property',
    'Enum',
    'EnumMember',
    'Interface',
    'Variable',
  ].map(k => k.toLowerCase()),
);

// ────────────────────────────────────────────────────────────────────────────
// Helpers shared by the CodeLens provider.
// ────────────────────────────────────────────────────────────────────────────

function isSelfRef(
  r: vscode.Location,
  uri: vscode.Uri,
  sym: vscode.DocumentSymbol,
): boolean {
  return (
    r.uri.toString() === uri.toString() &&
    r.range.start.line === sym.selectionRange.start.line &&
    r.range.start.character === sym.selectionRange.start.character
  );
}

// Drop refs that land on another target symbol's name token in the same file.
// Collapses Dart's class<->constructor double-count (both share the name).
function dropSiblingDeclRefs(
  refs: vscode.Location[],
  uri: vscode.Uri,
  selfSym: vscode.DocumentSymbol,
  siblings: vscode.DocumentSymbol[],
): vscode.Location[] {
  const sameFileDecls = siblings.filter(s => s !== selfSym);
  return refs.filter(r => {
    if (r.uri.toString() !== uri.toString()) return true;
    for (const s of sameFileDecls) {
      if (s.selectionRange.contains(r.range.start)) return false;
    }
    return true;
  });
}

function collectTargets(
  symbols: vscode.DocumentSymbol[],
): vscode.DocumentSymbol[] {
  const out: vscode.DocumentSymbol[] = [];
  const walk = (syms: vscode.DocumentSymbol[]) => {
    for (const s of syms) {
      const kindName = vscode.SymbolKind[s.kind] as SymKindName;
      if (INCLUDED_KINDS.has(kindName.toLowerCase())) out.push(s);
      if (s.children?.length) walk(s.children);
    }
  };
  walk(symbols);
  return out;
}

// Extract a package name from a reference URI for external code.
// Recognises pub-cache (hosted + git) and Flutter SDK paths.
function detectPackageName(fsPath: string): string | undefined {
  // pub-cache hosted: /.pub-cache/hosted/<host>/<pkg>-<ver>/lib/...
  let m = fsPath.match(
    /[\\/]\.pub-cache[\\/]hosted[\\/][^\\/]+[\\/]([A-Za-z_][\w]*)-[^\\/]+[\\/]/,
  );
  if (m) return m[1];
  // pub-cache git: /.pub-cache/git/<pkg>-<hash>/lib/...
  m = fsPath.match(
    /[\\/]\.pub-cache[\\/]git[\\/]([A-Za-z_][\w]*)-[A-Fa-f0-9]+[\\/]/,
  );
  if (m) return m[1];
  // Flutter SDK packages: /flutter/packages/<pkg>/lib/...
  m = fsPath.match(/[\\/]flutter[\\/]packages[\\/]([A-Za-z_][\w]*)[\\/]/);
  if (m) return m[1];
  return undefined;
}

// File-line cache for doc-comment detection. Cleared on save, and bounded
// by LINE_CACHE_MAX to avoid unbounded growth across a long session.
const LINE_CACHE_MAX = 200;
const lineCache = new Map<string, string[] | null>();
function invalidateLineCache() {
  lineCache.clear();
}
function getLines(fsPath: string): string[] | null {
  const cached = lineCache.get(fsPath);
  if (cached !== undefined) {
    // touch for LRU semantics
    lineCache.delete(fsPath);
    lineCache.set(fsPath, cached);
    return cached;
  }
  let lines: string[] | null;
  try {
    lines = fs.readFileSync(fsPath, 'utf-8').split(/\r?\n/);
  } catch {
    lines = null;
  }
  lineCache.set(fsPath, lines);
  if (lineCache.size > LINE_CACHE_MAX) {
    const oldest = lineCache.keys().next().value;
    if (oldest) lineCache.delete(oldest);
  }
  return lines;
}

// Drop refs whose line is a `///` documentation comment — those are link
// hints (e.g. `/// See [build]`), not real call sites.
function dropDocCommentRefs(refs: vscode.Location[]): vscode.Location[] {
  if (refs.length === 0) return refs;
  return refs.filter(r => {
    const lines = getLines(r.uri.fsPath);
    if (!lines) return true;
    const lineText = lines[r.range.start.line];
    if (lineText === undefined) return true;
    return !/^\s*\/\/\//.test(lineText);
  });
}

function refIsCountable(
  ref: vscode.Location,
  workspaceLibFsPath: string | undefined,
  excludePackages: Set<string>,
): boolean {
  const p = ref.uri.fsPath;
  if (
    workspaceLibFsPath &&
    (p === workspaceLibFsPath || p.startsWith(workspaceLibFsPath + path.sep))
  ) {
    return true;
  }
  // Wildcard: "all" means exclude every package outside lib/.
  if (excludePackages.has('all')) return false;
  const pkg = detectPackageName(p);
  if (!pkg) return false;
  return !excludePackages.has(pkg);
}

// ────────────────────────────────────────────────────────────────────────────
// CodeLens provider.
// ────────────────────────────────────────────────────────────────────────────

const LENS_CACHE_MAX = 200;
const WARMUP_RETRY_LIMIT = 5;

class FlutterReferenceProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  private cache = new Map<
    string,
    { version: number; lenses: vscode.CodeLens[] }
  >();
  // Per-doc warm-up retry counter so a permanently-broken analyzer or an
  // empty file doesn't pin a 1Hz onDidChange forever.
  private warmupRetries = new Map<string, number>();

  refresh() {
    this.cache.clear();
    this.warmupRetries.clear();
    this._onDidChange.fire();
  }

  invalidate(uri: vscode.Uri) {
    const k = uri.toString();
    this.cache.delete(k);
    this.warmupRetries.delete(k);
    this._onDidChange.fire();
  }

  async provideCodeLenses(
    doc: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const cfg = vscode.workspace.getConfiguration('flutterReference');
    if (!cfg.get<boolean>('enabled', true)) return [];

    const cacheKey = doc.uri.toString();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.version === doc.version) return cached.lenses;

    let symbols: vscode.DocumentSymbol[] = [];
    try {
      symbols =
        (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          doc.uri,
        )) ?? [];
    } catch {
      symbols = [];
    }

    if (symbols.length === 0) {
      // Only retry if the file actually has content — empty files
      // legitimately produce 0 symbols, no point spinning.
      const tries = this.warmupRetries.get(cacheKey) ?? 0;
      if (doc.lineCount > 0 && tries < WARMUP_RETRY_LIMIT) {
        this.warmupRetries.set(cacheKey, tries + 1);
        setTimeout(() => this._onDidChange.fire(), 1000);
      }
      return [];
    }
    this.warmupRetries.delete(cacheKey);

    const targets = collectTargets(symbols);

    const lenses = targets.map(s => {
      const lens = new vscode.CodeLens(s.selectionRange);
      (lens as any)._symbol = s;
      (lens as any)._uri = doc.uri;
      (lens as any)._siblings = targets;
      return lens;
    });

    this.cache.set(cacheKey, { version: doc.version, lenses });
    if (this.cache.size > LENS_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const sym: vscode.DocumentSymbol | undefined = (lens as any)._symbol;
    const uri: vscode.Uri | undefined = (lens as any)._uri;
    const siblings: vscode.DocumentSymbol[] = (lens as any)._siblings ?? [];
    if (!sym || !uri) {
      lens.command = { title: '', command: '' };
      return lens;
    }

    let refs: vscode.Location[] = [];
    try {
      refs =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          sym.selectionRange.start,
        )) ?? [];
    } catch {
      lens.command = { title: '? refs', command: '' };
      return lens;
    }

    const cfg = vscode.workspace.getConfiguration('flutterReference');
    const excludePackages = new Set(
      cfg.get<string[]>('excludePackages', ['flutter', 'flutter_test']),
    );
    const filterDocComments = cfg.get<boolean>('filterDocComments', false);
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    const libFs = ws ? path.join(ws.uri.fsPath, 'lib') : undefined;

    const stage1 = dropSiblingDeclRefs(
      refs.filter(r => !isSelfRef(r, uri, sym)),
      uri,
      sym,
      siblings,
    ).filter(r => refIsCountable(r, libFs, excludePackages));
    const filtered = filterDocComments ? dropDocCommentRefs(stage1) : stage1;

    const count = filtered.length;
    lens.command = {
      title: `${count} ref${count === 1 ? '' : 's'}`,
      command: 'editor.action.showReferences',
      arguments: [uri, sym.selectionRange.start, filtered],
    };
    return lens;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Find Unused Files, Assets & Dependencies (text-search, esentis-style).
// ────────────────────────────────────────────────────────────────────────────

interface UnusedFilesResult {
  unusedDartFiles: vscode.Uri[];
  unusedAssets: vscode.Uri[];
  unusedDeps: Array<{ name: string; line: number }>;
  scannedDart: number;
}

// Tiny pubspec parser: pulls top-level dep names + the line they live on,
// without bringing in a YAML library (so the extension has zero runtime deps).
function parsePubspecDeps(
  pubspecPath: string,
): { deps: string[]; lines: Map<string, number> } {
  const result = { deps: [] as string[], lines: new Map<string, number>() };
  let raw: string;
  try {
    raw = fs.readFileSync(pubspecPath, 'utf-8');
  } catch {
    return result;
  }
  const lines = raw.split(/\r?\n/);
  let inDeps = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[^\s#].*:\s*$/.test(l) || /^[^\s#].*:\s*\S/.test(l)) {
      // top-level key
      inDeps = /^dependencies\s*:/.test(l);
      continue;
    }
    if (!inDeps) continue;
    // dep entry — exactly two spaces of indent, then `name:`
    const m = l.match(/^ {2}([A-Za-z_][\w]*)\s*:/);
    if (m) {
      const name = m[1];
      if (name !== 'flutter' && name !== 'flutter_test') {
        result.deps.push(name);
        result.lines.set(name, i);
      }
    }
  }
  return result;
}

async function scanUnusedFiles(
  ws: vscode.WorkspaceFolder,
  token: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<UnusedFilesResult> {
  const exclude =
    '**/{.dart_tool,build,.fvm,ios/Pods,android/.gradle,node_modules}/**';

  const [dartFiles, assetFiles] = await Promise.all([
    vscode.workspace.findFiles(
      new vscode.RelativePattern(ws, 'lib/**/*.dart'),
      exclude,
    ),
    vscode.workspace.findFiles(
      new vscode.RelativePattern(ws, 'assets/**/*'),
      new vscode.RelativePattern(ws, 'assets/fonts/**/*'),
    ),
  ]);

  // vscode.workspace.findFiles only returns files, not directories — no need
  // to stat each entry.
  const dartBasenames = new Set(dartFiles.map(u => path.basename(u.fsPath)));
  const assetBasenames = new Set(
    assetFiles.map(u => path.basename(u.fsPath)),
  );

  const pubspecPath = path.join(ws.uri.fsPath, 'pubspec.yaml');
  const { deps, lines: depLines } = parsePubspecDeps(pubspecPath);

  const referencedDartFiles = new Set<string>();
  const referencedAssets = new Set<string>();
  const referencedDeps = new Set<string>();
  const entrypointPaths = new Set<string>();
  // Top-level `main(` — start of line, optional return type, then `main(`.
  const mainRe = /^(?:[A-Za-z_][\w<>?,\s]*\s+)?main\s*\(/m;

  let scanned = 0;
  const step = Math.max(1, Math.floor(dartFiles.length / 100));
  for (const uri of dartFiles) {
    if (token.isCancellationRequested) break;
    scanned++;
    if (scanned % step === 0) {
      progress.report({
        message: `${scanned}/${dartFiles.length} dart files`,
        increment: (step / Math.max(1, dartFiles.length)) * 100,
      });
    }
    let content: string;
    try {
      content = fs.readFileSync(uri.fsPath, 'utf-8');
    } catch {
      continue;
    }
    if (mainRe.test(content)) entrypointPaths.add(uri.fsPath);
    const self = path.basename(uri.fsPath);
    for (const name of dartBasenames) {
      if (name === self || referencedDartFiles.has(name)) continue;
      if (content.includes(name)) referencedDartFiles.add(name);
    }
    for (const name of assetBasenames) {
      if (referencedAssets.has(name)) continue;
      if (content.includes(name)) referencedAssets.add(name);
    }
    for (const name of deps) {
      if (referencedDeps.has(name)) continue;
      if (content.includes(name)) referencedDeps.add(name);
    }
  }

  const unusedDartFiles = dartFiles.filter(u => {
    if (entrypointPaths.has(u.fsPath)) return false;
    return !referencedDartFiles.has(path.basename(u.fsPath));
  });
  const unusedAssets = assetFiles.filter(
    u => !referencedAssets.has(path.basename(u.fsPath)),
  );
  const unusedDeps = deps
    .filter(d => !referencedDeps.has(d))
    .map(name => ({ name, line: depLines.get(name) ?? 0 }));

  return { unusedDartFiles, unusedAssets, unusedDeps, scannedDart: scanned };
}

async function findUnusedFiles(
  output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
) {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Flutter Reference: no workspace folder open.');
    return;
  }

  diagnostics.clear();
  output.clear();
  output.show(true);
  output.appendLine(
    'Flutter Reference: scanning lib/, assets/, and pubspec.yaml for unused entries…',
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Flutter Reference: finding unused files/assets/deps',
      cancellable: true,
    },
    async (progress, token) => {
      let result: UnusedFilesResult;
      try {
        result = await scanUnusedFiles(ws, token, progress);
      } catch (err) {
        output.appendLine(`\nError during scan: ${String(err)}`);
        vscode.window.showErrorMessage(
          `Flutter: scan failed — see Output panel for details.`,
        );
        return;
      }

      const firstLine = new vscode.Range(0, 0, 0, 0);
      const mkDiag = (msg: string) => {
        const d = new vscode.Diagnostic(
          firstLine,
          msg,
          vscode.DiagnosticSeverity.Information,
        );
        d.source = 'flutter-reference';
        d.tags = [vscode.DiagnosticTag.Unnecessary];
        return d;
      };

      for (const uri of result.unusedDartFiles) {
        diagnostics.set(uri, [
          mkDiag(`[Unused dart file] ${path.basename(uri.fsPath)}`),
        ]);
      }
      for (const uri of result.unusedAssets) {
        diagnostics.set(uri, [
          mkDiag(`[Unused asset] ${path.basename(uri.fsPath)}`),
        ]);
      }
      if (result.unusedDeps.length > 0) {
        const pubspecUri = vscode.Uri.file(
          path.join(ws.uri.fsPath, 'pubspec.yaml'),
        );
        const diags = result.unusedDeps.map(({ name, line }) => {
          const d = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, Math.max(1, name.length + 2)),
            `[Unused dependency] ${name}`,
            vscode.DiagnosticSeverity.Information,
          );
          d.source = 'flutter-reference';
          d.tags = [vscode.DiagnosticTag.Unnecessary];
          return d;
        });
        diagnostics.set(pubspecUri, diags);
      }

      const status = token.isCancellationRequested ? 'Cancelled' : 'Done';
      output.appendLine(
        `\n${status}. Scanned ${result.scannedDart} dart file(s).`,
      );

      const section = (title: string) => {
        output.appendLine('');
        output.appendLine(`──── ${title} ────`);
      };

      const pubspecAbs = path.join(ws.uri.fsPath, 'pubspec.yaml');

      section(`Unused dart files (${result.unusedDartFiles.length})`);
      if (result.unusedDartFiles.length === 0) {
        output.appendLine('(none)');
      } else {
        result.unusedDartFiles.forEach((u, i) => {
          output.appendLine(`${i + 1}. ${u.fsPath}`);
        });
      }

      section(`Unused assets (${result.unusedAssets.length})`);
      if (result.unusedAssets.length === 0) {
        output.appendLine('(none)');
      } else {
        result.unusedAssets.forEach((u, i) => {
          output.appendLine(`${i + 1}. ${u.fsPath}`);
        });
      }

      section(`Unused dependencies (${result.unusedDeps.length})`);
      if (result.unusedDeps.length === 0) {
        output.appendLine('(none)');
      } else {
        result.unusedDeps.forEach(({ name, line }, i) => {
          output.appendLine(`${i + 1}. ${name}  ${pubspecAbs}:${line + 1}`);
        });
      }

      output.appendLine('');
      output.appendLine(
        'Also visible in the Problems panel (filter by "flutter-reference") — click any entry to jump.',
      );
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Activation.
// ────────────────────────────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new FlutterReferenceProvider();
  const output = vscode.window.createOutputChannel('Flutter Reference');
  const diagnostics = vscode.languages.createDiagnosticCollection(
    'flutter-reference',
  );

  ctx.subscriptions.push(
    output,
    diagnostics,
    vscode.languages.registerCodeLensProvider(
      { language: 'dart', scheme: 'file' },
      provider,
    ),
    vscode.commands.registerCommand('flutterReference.refresh', () =>
      provider.refresh(),
    ),
    vscode.commands.registerCommand('flutterReference.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('flutterReference');
      const next = !cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(
        `Flutter Reference: ${next ? 'enabled' : 'disabled'}`,
        2000,
      );
    }),
    vscode.commands.registerCommand('flutterReference.findUnusedFiles', () =>
      findUnusedFiles(output, diagnostics),
    ),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('flutterReference')) provider.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'dart') {
        invalidateLineCache();
        provider.refresh();
      }
    }),
  );
}

export function deactivate() {}
