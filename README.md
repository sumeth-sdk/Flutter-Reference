# Flutter Reference

Reference-count CodeLens above Dart declarations — like Visual Studio's
"N references" hint above C# symbols — plus a workspace-wide scan for
unused Dart files, assets, and `pubspec.yaml` dependencies.

Requires the [Dart-Code](https://marketplace.visualstudio.com/items?itemName=Dart-Code.dart-code)
extension (provides the language server this extension queries).

## What it shows

Above every class / method / function / constructor / field / property /
enum / enum member / interface / variable in your Dart code:

```text
3 refs
Widget build(BuildContext context) { … }
```

Click the count to jump to a "Find All References" view of just the
references this extension counts.

The lens deliberately ignores noise:

- **Class ↔ constructor double-count** is collapsed (both share the
  same name token, so a single `Foo()` call would otherwise count
  twice).
- **Framework callbacks are excluded by default.** References from the
  `flutter` and `flutter_test` packages aren't counted, so an
  `@override Widget build(...)` doesn't get inflated by Flutter SDK
  callsites.
- **Doc-comment references can be skipped** (`/// See [build]`) via a
  setting.

## Commands

- **Flutter Reference: Refresh** — clear cache and recompute
  (useful after large refactors).
- **Flutter Reference: Toggle On/Off** — flip the lens without
  opening Settings.
- **Flutter Reference: Find Unused Files, Assets & Dependencies**
  — workspace-wide scan. For each Dart file under `lib/`, asset under
  `assets/` (excluding `assets/fonts/`), and top-level dependency in
  `pubspec.yaml`, checks whether the basename / package name appears as
  a substring in any Dart file. Anything that doesn't is published as
  an `Information` diagnostic with the `Unnecessary` tag (struck-through
  in the editor) and listed in the Output channel.

  Any Dart file with a top-level `main()` is treated as an entrypoint
  and never reported.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `flutterReference.enabled` | boolean | `true` | Toggle the lens. |
| `flutterReference.filterDocComments` | boolean | `false` | Skip references on `///` documentation-comment lines. |
| `flutterReference.excludePackages` | string[] | `["flutter", "flutter_test"]` | Packages whose references are not counted. Use the special value `"all"` to exclude every reference outside `lib/`. |

Symbol kinds annotated are baked in: Class, Method, Function,
Constructor, Field, Property, Enum, EnumMember, Interface, Variable.

## How it works

- Registers a `CodeLensProvider` for `language: dart`.
- Pulls symbols via `vscode.executeDocumentSymbolProvider` (served by
  the Dart analyzer).
- For each symbol, queries `vscode.executeReferenceProvider` lazily in
  `resolveCodeLens` so off-screen lenses don't trigger work.
- Per-document lens cache (keyed by version, LRU-capped at 200) and a
  per-file line cache for the doc-comment filter (also LRU-capped at
  200, invalidated on save).
- Package-name detection covers `.pub-cache/hosted/<host>/<pkg>-<ver>/`,
  `.pub-cache/git/<pkg>-<hash>/`, and `flutter/packages/<pkg>/`.

## Caveats

- The CodeLens API only renders lens on **open** editors — close a file
  and its lens isn't computed. Use **Find Unused Files** for
  workspace-wide reporting.
- Reference lookups are O(symbols × analyzer round-trip). Large files
  may flash counts as lenses resolve.
- The first scan after opening a project can be slow while the Dart
  analyzer warms up — subsequent runs reuse its index.
- Package-name detection for `excludePackages` doesn't recognise
  path-based deps in arbitrary locations. If your refs live outside
  `.pub-cache/` or the Flutter SDK, listing the package in
  `excludePackages` may have no effect.

## Build from source

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension flutter-reference-0.1.0.vsix --force
```
