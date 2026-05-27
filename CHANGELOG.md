# Changelog

## 0.1.0

First publish release.

### Features

- **Reference-count CodeLens** above Dart declarations (classes,
  methods, functions, constructors, fields, properties, enums, enum
  members, interfaces, variables) — like Visual Studio's "N references"
  hint above C# symbols.
- **Smart filtering** so counts reflect *your* code, not framework
  callbacks:
  - References inside the workspace `lib/` always count.
  - The class ↔ constructor double-count (both share the same name
    token) is collapsed.
  - References from packages listed in `flutterReference.excludePackages`
    are excluded (defaults: `flutter`, `flutter_test`).
  - Special value `"all"` in `excludePackages` excludes every reference
    outside `lib/`.
  - Optional `flutterReference.filterDocComments` drops references on
    `///` doc-comment lines (default off).
- **Find Unused Files, Assets & Dependencies** — workspace-wide
  text-search scan that flags:
  - Dart files under `lib/` with no other file referencing their
    basename (entrypoints with a top-level `main()` are always kept).
  - Asset files under `assets/` (excluding `assets/fonts/`) whose
    basename isn't mentioned in any Dart file.
  - Top-level dependencies in `pubspec.yaml` whose package name isn't
    mentioned in any Dart file.

  Results are published as `Information` diagnostics (clickable in the
  Problems panel) and also listed in the Output channel.
- **Toggle command** for quickly turning the lens on/off without
  opening Settings.

### Implementation notes

- Reference lookups happen lazily in `resolveCodeLens`, so off-screen
  lenses don't cost analyzer round-trips.
- Per-document lens cache (keyed by version, LRU-capped at 200) and a
  parallel per-file line cache (used by the doc-comment filter, also
  LRU-capped at 200, invalidated on save).
- The workspace scan reads each Dart file once and checks all
  candidates against its content in a single pass.
- Zero runtime dependencies — `pubspec.yaml` parsing is done inline.
