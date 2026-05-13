#!/usr/bin/env bun
/**
 * Postbuild CSS purge — standalone Bun script.
 *
 * Runs after rsbuild build, purges CSS files in dist/ using the purge manifest
 * and consumer JSX analysis. Zero Node imports.
 *
 * Three-level purge:
 *   L1 — class-level: drop rules whose class selectors aren't in the safelist (postcss)
 *   L2 — attr-level: drop rules with data/aria attribute selectors for unused props (postcss)
 *   L3 — var cleanup: iteratively remove declared-but-unreferenced CSS custom properties (postcss)
 *   Final — minification via Lightning CSS
 *
 * Usage:
 *   bunx @pathscale/rsbuild-plugin-ui-css-purge \
 *     --dist dist --src src --manifest node_modules/@pathscale/ui/dist/purge-manifest.json
 */

import { Glob } from "bun";
import { transform } from "lightningcss";
import postcss from "postcss";
import type { Rule, AtRule } from "postcss";
import { scanConsumerSource, buildSafelists } from "./scan-consumer";
import type { PurgeManifest } from "./scan-consumer";

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { distDir: string; srcDir: string; manifestPath: string } {
  const args = argv.slice(2);
  let distDir = "./dist";
  let srcDir = "./src";
  let manifestPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dist" && args[i + 1]) distDir = args[++i];
    else if (args[i] === "--src" && args[i + 1]) srcDir = args[++i];
    else if (args[i] === "--manifest" && args[i + 1]) manifestPath = args[++i];
  }

  if (!manifestPath) {
    console.error(
      "Usage: bunx @pathscale/rsbuild-plugin-ui-css-purge --manifest <path> [--dist <path>] [--src <path>]",
    );
    process.exit(1);
  }

  return { distDir, srcDir, manifestPath };
}

// ── Build kill-list: classes from components that are never imported ──────────

function collectClassesFromEntry(entry: { classes: { always: string[]; byProp: Record<string, string[] | Record<string, string[]>> } }): string[] {
  const result = [...entry.classes.always];
  for (const value of Object.values(entry.classes.byProp)) {
    if (Array.isArray(value)) {
      result.push(...value);
    } else {
      for (const classes of Object.values(value)) {
        result.push(...classes);
      }
    }
  }
  return result;
}

interface KillListResult {
  killList: Set<string>;
  /**
   * BEM root classes of components the consumer actually uses. Used to
   * preserve pure attribute selector rules like
   * `[data-slot="checkbox-default-indicator--checkmark"]` that have no class
   * reference but are still component-scoped.
   */
  usedBemRoots: Set<string>;
}

export function buildKillList(
  manifest: PurgeManifest,
  importedComponents: Set<string>,
): KillListResult {
  // For each manifest entry, collect BEM root classes (from classes.always).
  // A class is considered a BEM-owned class of a component if it matches
  // one of its roots: exact match, root--, or root__.
  // Everything else (Tailwind utilities like gap-1, flex-col) is never killed.
  const componentBemRoots = new Map<string, Set<string>>();

  for (const [key, entry] of Object.entries(manifest)) {
    const root = key.split(".")[0];
    const existing = componentBemRoots.get(root) ?? new Set();
    for (const cls of entry.classes.always) {
      existing.add(cls);
    }
    componentBemRoots.set(root, existing);
  }

  // Collect ALL classes per component
  const componentClasses = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(manifest)) {
    const root = key.split(".")[0];
    const existing = componentClasses.get(root) ?? [];
    existing.push(...collectClassesFromEntry(entry));
    componentClasses.set(root, existing);
  }

  // Filter: only include classes that match a BEM root of their component
  function isBemClass(cls: string, bemRoots: Set<string>): boolean {
    for (const root of bemRoots) {
      if (cls === root || cls.startsWith(`${root}--`) || cls.startsWith(`${root}__`)) {
        return true;
      }
    }
    return false;
  }

  const killList = new Set<string>();
  const safeClasses = new Set<string>();
  const usedBemRoots = new Set<string>();

  for (const [component, classes] of componentClasses) {
    const bemRoots = componentBemRoots.get(component) ?? new Set();
    if (importedComponents.has(component)) {
      for (const cls of classes) safeClasses.add(cls);
      for (const root of bemRoots) usedBemRoots.add(root);
    } else {
      // Only kill BEM-owned classes, not Tailwind utilities
      for (const cls of classes) {
        if (isBemClass(cls, bemRoots)) {
          killList.add(cls);
        }
      }
    }
  }

  // If a class appears in BOTH used and unused components, keep it
  for (const cls of safeClasses) {
    killList.delete(cls);
  }

  return { killList, usedBemRoots };
}

/** Convert kebab-case directory name to PascalCase component name */
function kebabToPascal(s: string): string {
  return s.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

async function scanImportedComponents(srcDir: string): Promise<Set<string>> {
  const imported = new Set<string>();
  const glob = new Glob("**/*.{tsx,ts,jsx,js}");

  for await (const relPath of glob.scan({ cwd: srcDir })) {
    if (relPath.includes("node_modules")) continue;
    const fullPath = `${srcDir}/${relPath}`;
    const code = await Bun.file(fullPath).text();
    if (!code.includes("@pathscale/ui")) continue;

    // Match barrel: import { Foo, Bar as Baz } from "@pathscale/ui"
    const barrelRegex = /import\s*\{([^}]+)\}\s*from\s*['"]@pathscale\/ui['"]/g;
    for (const match of code.matchAll(barrelRegex)) {
      const specifiers = match[1].split(",");
      for (const spec of specifiers) {
        const trimmed = spec.trim();
        if (trimmed.startsWith("type ")) continue;
        const name = trimmed.split(/\s+as\s+/)[0].trim();
        if (name && /^[A-Z]/.test(name)) {
          imported.add(name);
        }
      }
    }

    // Match deep-path default: import Foo from "@pathscale/ui/components/foo-bar"
    const deepDefaultRegex = /import\s+([A-Z][a-zA-Z0-9]*)\s+from\s*['"]@pathscale\/ui\/components\/([^'"]+)['"]/g;
    for (const match of code.matchAll(deepDefaultRegex)) {
      imported.add(match[1]);
    }

    // Match deep-path named: import { Foo, Bar } from "@pathscale/ui/components/foo-bar"
    const deepNamedRegex = /import\s*\{([^}]+)\}\s*from\s*['"]@pathscale\/ui\/components\/([^'"]+)['"]/g;
    for (const match of code.matchAll(deepNamedRegex)) {
      const specifiers = match[1].split(",");
      for (const spec of specifiers) {
        const trimmed = spec.trim();
        if (trimmed.startsWith("type ")) continue;
        const name = trimmed.split(/\s+as\s+/)[0].trim();
        if (name && /^[A-Z]/.test(name)) {
          imported.add(name);
        }
      }
      // Also add the PascalCase name from the path itself (covers sub-components)
      const dirName = match[2].split("/")[0];
      imported.add(kebabToPascal(dirName));
    }
  }

  return imported;
}

/**
 * Build dependency graph from manifest `deps` fields.
 */
function buildDepGraphFromManifest(manifest: PurgeManifest): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(manifest)) {
    const root = key.split(".")[0];
    if (entry.deps && entry.deps.length > 0 && !graph.has(root)) {
      graph.set(root, new Set(entry.deps));
    }
  }
  return graph;
}

/**
 * Given directly imported components and a dependency graph,
 * transitively resolve all components that are needed.
 */
function resolveTransitiveDeps(
  imported: Set<string>,
  depGraph: Map<string, Set<string>>,
): Set<string> {
  const resolved = new Set(imported);
  const queue = [...imported];

  while (queue.length > 0) {
    const comp = queue.pop()!;
    const deps = depGraph.get(comp);
    if (!deps) continue;
    for (const dep of deps) {
      if (!resolved.has(dep)) {
        resolved.add(dep);
        queue.push(dep);
      }
    }
  }

  return resolved;
}

// ── Level 1: class-level purge + keyframes + font-face + element selectors ───

/** Unescape CSS identifiers: `icon-\[mdi--cog\]` → `icon-[mdi--cog]` */
function unescapeCss(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

function extractClassesFromSelector(selector: string): string[] {
  // Match class selectors including CSS escape sequences (e.g. .icon-\[mdi--cog\])
  const matches = selector.matchAll(/\.([a-zA-Z_-](?:[a-zA-Z0-9_-]|\\[^\s])*)/g);
  return [...matches].map((m) => unescapeCss(m[1]));
}

// Elements that are always kept (fundamental reset targets).
// Everything else (sub, sup, img, select, textarea, etc.) is stripped
// unless it appears alongside a safelisted class.
const ALWAYS_KEEP_SELECTORS = new Set([
  "*", "html", "body", ":root", "::before", "::after",
  ":before", ":after", "::backdrop",
]);

/**
 * Extract all `[data-slot="..."]` attribute values from a selector. Handles
 * quoted and unquoted forms (Lightning CSS strips quotes when the value is a
 * simple identifier-like token, so post-minify CSS often looks like
 * `[data-slot=checkbox-default-indicator--checkmark]`).
 */
export function extractDataSlotValues(sel: string): string[] {
  const values: string[] = [];
  const re = /\[data-slot=(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\]/g;
  for (const m of sel.matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v) values.push(v);
  }
  return values;
}

/**
 * True when every `[data-slot="X"]` in `sel` belongs to a used component —
 * X matches one of `usedBemRoots` as exact, or as `root-`, `root__`, `root--`
 * prefix. Returns false when the selector has no `[data-slot]` at all
 * (caller decides via other heuristics) or when any slot doesn't match.
 */
export function dataSlotsMatchUsedRoots(sel: string, usedBemRoots: Set<string>): boolean {
  const slots = extractDataSlotValues(sel);
  if (slots.length === 0) return false;
  for (const slot of slots) {
    let matched = false;
    for (const root of usedBemRoots) {
      if (
        slot === root ||
        slot.startsWith(`${root}-`) ||
        slot.startsWith(`${root}__`) ||
        slot.startsWith(`${root}--`)
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

export function isKeepableNonClassSelector(
  sel: string,
  usedBemRoots: Set<string> = new Set(),
): boolean {
  const stripped = sel.trim();

  // Exact match on fundamental selectors
  for (const el of ALWAYS_KEEP_SELECTORS) {
    if (stripped === el) return true;
    // Allow pseudo-elements/classes attached to fundamental selectors
    // e.g. *::before, html:not([data-theme])
    if (stripped.startsWith(el + ":") || stripped.startsWith(el + "[") || stripped.startsWith(el + " ")) return true;
  }

  // Keep :root with pseudo/attr (theme selectors like :root:not([data-theme]))
  if (/^:root/.test(stripped)) return true;

  // Keep attribute-only selectors like [data-theme=dark] — theme variable declarations
  if (/^\[data-theme/.test(stripped)) return true;

  // Keep [hidden] reset rules
  if (/^\[hidden/.test(stripped)) return true;

  // Keep pure attribute-selector rules that target a component-scoped
  // [data-slot="<root>..."] when the owning component is used by the consumer.
  // Without this, base-state rules like
  //   [data-slot="checkbox-default-indicator--checkmark"] { opacity: 0; ... }
  // get dropped while their `data-selected=true` counterparts survive, leaving
  // the indicator drawn at rest.
  if (dataSlotsMatchUsedRoots(stripped, usedBemRoots)) return true;

  // Drop everything else: :host, :where(select...), element selectors (sub, sup, img, etc.)
  return false;
}

export function purgeClasses(
  css: string,
  killList: Set<string>,
  usedBemRoots: Set<string> = new Set(),
): string {
  const root = postcss.parse(css);

  // Pass 1: remove selectors where ALL classes are on the kill-list
  // (i.e. they belong exclusively to unused UI components).
  // Any selector with even one class NOT on the kill-list is kept.
  root.walkRules((rule) => {
    const selectors = rule.selectors;
    const kept: string[] = [];

    for (const sel of selectors) {
      const classes = extractClassesFromSelector(sel);
      if (classes.length === 0) {
        if (isKeepableNonClassSelector(sel, usedBemRoots)) {
          kept.push(sel);
        }
        continue;
      }

      // Keep if ANY class is not on the kill-list
      if (classes.some((c) => !killList.has(c))) {
        kept.push(sel);
      }
    }

    if (kept.length === 0) {
      rule.remove();
    } else if (kept.length < selectors.length) {
      rule.selectors = kept;
    }
  });

  // Pass 2: collect animation names referenced by surviving rules
  const usedKeyframes = new Set<string>();
  root.walkDecls(/^animation(-name)?$/, (decl) => {
    // animation-name can be comma-separated
    for (const part of decl.value.split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name && name !== "none" && name !== "initial" && name !== "inherit") {
        usedKeyframes.add(name);
      }
    }
  });

  // Pass 3: remove unused @keyframes
  root.walkAtRules("keyframes", (atRule) => {
    if (!usedKeyframes.has(atRule.params.trim())) {
      atRule.remove();
    }
  });

  // Pass 4: collect font families referenced by surviving rules
  const usedFonts = new Set<string>();
  root.walkDecls(/^font(-family)?$/, (decl) => {
    // Extract font family names (rough but catches common patterns)
    for (const part of decl.value.split(",")) {
      const name = part.trim().replace(/^["']|["']$/g, "");
      if (name) usedFonts.add(name);
    }
  });

  // Pass 5: remove unused @font-face
  root.walkAtRules("font-face", (atRule) => {
    let family = "";
    atRule.walkDecls("font-family", (decl) => {
      family = decl.value.trim().replace(/^["']|["']$/g, "");
    });
    if (family && !usedFonts.has(family)) {
      atRule.remove();
    }
  });

  // Pass 6: clean empty at-rules
  let cleaned = true;
  while (cleaned) {
    cleaned = false;
    root.walkAtRules((atRule) => {
      if (atRule.nodes && atRule.nodes.length === 0) {
        atRule.remove();
        cleaned = true;
      }
    });
  }

  return root.toString();
}

// ── Level 2: attribute purge (postcss) ───────────────────────────────────────

function purgeAttributes(css: string, attrSafelist: Set<string>): string {
  const root = postcss.parse(css);

  root.walkRules((rule) => {
    const selectors = rule.selectors;
    const kept: string[] = [];

    for (const sel of selectors) {
      const attrMatches = sel.matchAll(/\[(data-[a-z-]+|aria-[a-z-]+)="([^"]+)"\]/g);
      let shouldKeep = true;

      for (const match of attrMatches) {
        if (match[1] === "data-slot") continue;
        const attrSelector = `[${match[1]}="${match[2]}"]`;
        if (!attrSafelist.has(attrSelector)) {
          shouldKeep = false;
          break;
        }
      }

      if (shouldKeep) kept.push(sel);
    }

    if (kept.length === 0) {
      rule.remove();
    } else if (kept.length < selectors.length) {
      rule.selectors = kept;
    }
  });

  return root.toString();
}

// ── Runtime CSS variable references ──────────────────────────────────────────

async function collectRuntimeCssVarRefs(distDir: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const glob = new Glob("**/*.{js,mjs,cjs}");

  for await (const relPath of glob.scan({ cwd: distDir })) {
    const fullPath = `${distDir}/${relPath}`;
    const code = await Bun.file(fullPath).text();
    for (const match of code.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      refs.add(match[1]);
    }
  }

  return refs;
}

// ── Level 3: unused CSS variable cleanup (postcss) ───────────────────────────

function cleanUnusedVars(
  css: string,
  externallyReferencedVars: Set<string>,
): string {
  let changed = true;
  let result = css;

  while (changed) {
    changed = false;
    const root = postcss.parse(result);

    const declared = new Map<string, { rule: Rule | AtRule; prop: string }[]>();
    root.walkDecls(/^--/, (decl) => {
      const entries = declared.get(decl.prop) ?? [];
      entries.push({ rule: decl.parent as Rule, prop: decl.prop });
      declared.set(decl.prop, entries);
    });

    const referenced = new Set<string>(externallyReferencedVars);
    root.walkDecls((decl) => {
      const refs = decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g);
      for (const ref of refs) referenced.add(ref[1]);
    });

    for (const [varName, entries] of declared) {
      if (!referenced.has(varName)) {
        for (const entry of entries) {
          entry.rule.walkDecls(entry.prop, (decl) => {
            decl.remove();
            changed = true;
          });
        }
      }
    }

    root.walkRules((rule) => {
      if (rule.nodes && rule.nodes.length === 0) rule.remove();
    });
    root.walkAtRules((atRule) => {
      if (atRule.nodes && atRule.nodes.length === 0) atRule.remove();
    });

    result = root.toString();
  }

  return result;
}

// ── Minification: Lightning CSS ──────────────────────────────────────────────

function minify(css: string): string {
  const { code } = transform({
    filename: "purged.css",
    code: Buffer.from(css),
    minify: true,
    errorRecovery: true,
  });
  return code.toString();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { distDir, srcDir, manifestPath } = parseArgs(process.argv);

  // 1. Load manifest
  const manifest: PurgeManifest = JSON.parse(
    await Bun.file(manifestPath).text(),
  );
  const totalComponents = new Set(Object.keys(manifest).map(k => k.split(".")[0])).size;
  console.log(`[css-purge] Manifest loaded: ${Object.keys(manifest).length} entries (${totalComponents} components)`);

  // 2. Scan consumer source for directly imported components
  const directImports = await scanImportedComponents(srcDir);
  console.log(`[css-purge] Direct imports from app: ${directImports.size} / ${totalComponents}`);

  // 3. Resolve transitive dependencies from manifest deps
  const depGraph = buildDepGraphFromManifest(manifest);
  const importedComponents = resolveTransitiveDeps(directImports, depGraph);
  const transitive = importedComponents.size - directImports.size;
  console.log(`[css-purge] Transitive deps: +${transitive} → ${importedComponents.size} total used components`);

  // 4. Build kill-list (classes from components never imported) + attr safelist
  const { killList, usedBemRoots } = buildKillList(manifest, importedComponents);
  console.log(`[css-purge] Kill-list: ${killList.size} classes from ${totalComponents - importedComponents.size} unused components`);
  console.log(`[css-purge] Used BEM roots: ${usedBemRoots.size} (preserves [data-slot] rules for used components)`);

  // Also scan for prop-level attr purging
  const usages = await scanConsumerSource(srcDir);
  const { attrSafelist } = buildSafelists(usages, manifest);
  const runtimeCssVarRefs = await collectRuntimeCssVarRefs(distDir);
  if (runtimeCssVarRefs.size > 0) {
    console.log(
      `[css-purge] Runtime CSS vars referenced from JS: ${runtimeCssVarRefs.size}`,
    );
  }

  // 4. Glob CSS files in dist
  const glob = new Glob("**/*.css");
  let totalBefore = 0;
  let totalAfter = 0;

  for await (const relPath of glob.scan({ cwd: distDir })) {
    const fullPath = `${distDir}/${relPath}`;
    const originalCss = await Bun.file(fullPath).text();
    const originalSize = Buffer.byteLength(originalCss, "utf-8");
    totalBefore += originalSize;

    console.log(`[css-purge] Processing ${relPath} (${(originalSize / 1024).toFixed(1)} KB)`);

    // Level 1: class-level purge (unused components only)
    let purgedCss = purgeClasses(originalCss, killList, usedBemRoots);
    const afterL1 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L1 class purge: ${(originalSize / 1024).toFixed(1)} → ${(afterL1 / 1024).toFixed(1)} KB`);

    // Level 2: attribute-level purge
    purgedCss = purgeAttributes(purgedCss, attrSafelist);
    const afterL2 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L2 attr purge: ${(afterL1 / 1024).toFixed(1)} → ${(afterL2 / 1024).toFixed(1)} KB`);

    // Level 3: unused CSS variable cleanup
    purgedCss = cleanUnusedVars(purgedCss, runtimeCssVarRefs);
    const afterL3 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L3 var cleanup: → ${(afterL3 / 1024).toFixed(1)} KB`);

    // Final: minification via Lightning CSS
    purgedCss = minify(purgedCss);
    const finalSize = Buffer.byteLength(purgedCss, "utf-8");
    totalAfter += finalSize;
    console.log(`[css-purge]   Minify (lightningcss): → ${(finalSize / 1024).toFixed(1)} KB`);
    console.log(`[css-purge]   Final: ${(originalSize / 1024).toFixed(1)} → ${(finalSize / 1024).toFixed(1)} KB (${((1 - finalSize / originalSize) * 100).toFixed(1)}% reduction)`);

    await Bun.write(fullPath, purgedCss);
  }

  console.log(`\n[css-purge] Total: ${(totalBefore / 1024).toFixed(1)} → ${(totalAfter / 1024).toFixed(1)} KB (${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% reduction)`);
}

if (import.meta.main) {
  main();
}
