#!/usr/bin/env bun
/**
 * Postbuild CSS purge — standalone Bun script.
 *
 * Runs after rsbuild build, purges CSS files in dist/ using a database-first
 * component manifest and consumer JSX usage analysis.
 *
 * Conservative rules:
 *   - selectors owned only by unused known components can be removed
 *   - selectors owned by used components but unused known prop variants can be removed
 *   - selectors with unknown ownership are kept
 *   - data/aria runtime state is kept when the owning component selector is kept
 *   - vars/keyframes are removed only after selector purge proves them unreferenced
 */

import { Glob } from "bun";
import { transform } from "lightningcss";
import type { AtRule, Rule } from "postcss";
import postcss from "postcss";
import type {
	ComponentPurgeRecord,
	LegacyComponentManifest,
	PurgeManifest,
	Safelists,
} from "./scan-consumer";
import { buildSafelists, scanConsumerSource } from "./scan-consumer";

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
	distDir: string;
	srcDir: string;
	manifestPath: string;
} {
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

// ── Database normalization ────────────────────────────────────────────────────

interface NormalizedComponentRecord extends LegacyComponentManifest {
	key: string;
	component: string;
	part?: string;
	selectors: string[];
	attributeSelectors: string[];
	cssVars: {
		declared: string[];
		referenced: string[];
	};
	keyframes: {
		declared: string[];
		referenced: string[];
	};
}

interface NormalizedPurgeDatabase {
	version: 2;
	components: Record<string, NormalizedComponentRecord>;
}

function normalizePurgeDatabase(
	manifest: PurgeManifest,
): NormalizedPurgeDatabase {
	const rawComponents =
		"version" in manifest && manifest.version === 2
			? manifest.components
			: manifest;
	const components: Record<string, NormalizedComponentRecord> = {};

	for (const [key, record] of Object.entries(rawComponents)) {
		const maybeV2 = record as ComponentPurgeRecord;
		const [fallbackComponent, fallbackPart] = splitComponentKey(key);
		components[key] = {
			...record,
			key: maybeV2.key ?? key,
			component: maybeV2.component ?? fallbackComponent,
			part: maybeV2.part ?? fallbackPart,
			selectors: maybeV2.selectors ?? [],
			attributeSelectors: maybeV2.attributeSelectors ?? [],
			cssVars: {
				declared: maybeV2.cssVars?.declared ?? [],
				referenced: maybeV2.cssVars?.referenced ?? [],
			},
			keyframes: {
				declared: maybeV2.keyframes?.declared ?? [],
				referenced: maybeV2.keyframes?.referenced ?? [],
			},
		};
	}

	return { version: 2, components };
}

function splitComponentKey(key: string): [string, string | undefined] {
	const [component, ...part] = key.split(".");
	return [component, part.length > 0 ? part.join(".") : undefined];
}

function rootComponent(key: string): string {
	return key.split(".")[0];
}

function collectClassesFromEntry(entry: LegacyComponentManifest): string[] {
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
	return [...new Set(result)];
}

function buildClassOwners(
	database: NormalizedPurgeDatabase,
): Map<string, Set<string>> {
	const owners = new Map<string, Set<string>>();
	for (const [key, entry] of Object.entries(database.components)) {
		for (const cls of collectClassesFromEntry(entry)) {
			const existing = owners.get(cls) ?? new Set<string>();
			existing.add(key);
			owners.set(cls, existing);
		}
	}
	return owners;
}

function isRecordUsed(recordKey: string, safelists: Safelists): boolean {
	return (
		safelists.usedComponents.has(recordKey) ||
		safelists.usedComponents.has(rootComponent(recordKey))
	);
}

function isClassAllowed(
	cls: string,
	owners: Map<string, Set<string>>,
	safelists: Safelists,
): boolean {
	const classOwners = owners.get(cls);
	if (!classOwners) return true;
	for (const owner of classOwners) {
		if (isRecordUsed(owner, safelists) && safelists.classSafelist.has(cls)) {
			return true;
		}
	}
	return false;
}

// ── Selector purge ─────────────────────────────────────────────────────────────

interface SelectorPurgeReport {
	selectorsKeptKnown: number;
	selectorsKeptUnknown: number;
	selectorsRemoved: number;
	selectorsRemovedUnusedComponent: number;
	selectorsRemovedUnusedVariant: number;
	attrSelectorsSeen: number;
	keyframesRemoved: number;
	fontFacesRemoved: number;
}

interface PurgeResult {
	css: string;
	report: SelectorPurgeReport;
}

function emptySelectorReport(): SelectorPurgeReport {
	return {
		selectorsKeptKnown: 0,
		selectorsKeptUnknown: 0,
		selectorsRemoved: 0,
		selectorsRemovedUnusedComponent: 0,
		selectorsRemovedUnusedVariant: 0,
		attrSelectorsSeen: 0,
		keyframesRemoved: 0,
		fontFacesRemoved: 0,
	};
}

/** Unescape CSS identifiers: `icon-\[mdi--cog\]` -> `icon-[mdi--cog]` */
function unescapeCss(s: string): string {
	return s.replace(/\\(.)/g, "$1");
}

function extractClassesFromSelector(selector: string): string[] {
	const matches = selector.matchAll(
		/\.([a-zA-Z_-](?:[a-zA-Z0-9_-]|\\[^\s.#:[>+~,)]*)*)/g,
	);
	return [...matches].map((m) => unescapeCss(m[1]));
}

function extractAttrsFromSelector(selector: string): string[] {
	const matches = selector.matchAll(
		/\[(data-[a-zA-Z0-9_-]+|aria-[a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g,
	);
	return [...matches].map((m) => {
		const value = m[2] ?? m[3] ?? m[4];
		return value === undefined ? `[${m[1]}]` : `[${m[1]}="${value.trim()}"]`;
	});
}

function selectorDecision(
	selector: string,
	owners: Map<string, Set<string>>,
	safelists: Safelists,
):
	| "keep-known"
	| "keep-unknown"
	| "remove-unused-component"
	| "remove-unused-variant" {
	const attrs = extractAttrsFromSelector(selector);
	if (attrs.some((attr) => safelists.attrSafelist.has(attr))) {
		return "keep-known";
	}

	const classes = extractClassesFromSelector(selector);
	if (classes.length === 0) return "keep-unknown";

	const hasUnknownClass = classes.some((cls) => !owners.has(cls));
	if (hasUnknownClass) return "keep-unknown";

	const hasUsedOwner = classes.some((cls) => {
		const classOwners = owners.get(cls);
		return [...(classOwners ?? [])].some((owner) =>
			isRecordUsed(owner, safelists),
		);
	});

	if (!hasUsedOwner) return "remove-unused-component";

	if (classes.every((cls) => isClassAllowed(cls, owners, safelists))) {
		return "keep-known";
	}

	return "remove-unused-variant";
}

function purgeCssWithDatabase(
	css: string,
	manifest: PurgeManifest | NormalizedPurgeDatabase,
	safelists: Safelists,
): PurgeResult {
	const database = normalizePurgeDatabase(manifest as PurgeManifest);
	const classOwners = buildClassOwners(database);
	const report = emptySelectorReport();
	const root = postcss.parse(css);

	root.walkRules((rule) => {
		const selectors = rule.selectors;
		const kept: string[] = [];

		for (const selector of selectors) {
			report.attrSelectorsSeen += extractAttrsFromSelector(selector).length;
			const decision = selectorDecision(selector, classOwners, safelists);
			if (decision === "keep-known") {
				report.selectorsKeptKnown++;
				kept.push(selector);
			} else if (decision === "keep-unknown") {
				report.selectorsKeptUnknown++;
				kept.push(selector);
			} else {
				report.selectorsRemoved++;
				if (decision === "remove-unused-component") {
					report.selectorsRemovedUnusedComponent++;
				} else {
					report.selectorsRemovedUnusedVariant++;
				}
			}
		}

		if (kept.length === 0) {
			rule.remove();
		} else if (kept.length < selectors.length) {
			rule.selectors = kept;
		}
	});

	removeUnusedKeyframes(root, report);
	removeUnusedFontFaces(root, report);
	removeEmptyAtRules(root);

	return { css: root.toString(), report };
}

function removeUnusedKeyframes(
	root: postcss.Root,
	report: SelectorPurgeReport,
) {
	const usedKeyframes = new Set<string>();
	root.walkDecls(/^animation(-name)?$/, (decl) => {
		for (const part of decl.value.split(",")) {
			const name = part.trim().split(/\s+/)[0];
			if (name && !["none", "initial", "inherit", "unset"].includes(name)) {
				usedKeyframes.add(name);
			}
		}
	});

	root.walkAtRules("keyframes", (atRule) => {
		if (!usedKeyframes.has(atRule.params.trim())) {
			atRule.remove();
			report.keyframesRemoved++;
		}
	});
}

function removeUnusedFontFaces(
	root: postcss.Root,
	report: SelectorPurgeReport,
) {
	const usedFonts = new Set<string>();
	root.walkDecls(/^font(-family)?$/, (decl) => {
		for (const part of decl.value.split(",")) {
			const name = part.trim().replace(/^["']|["']$/g, "");
			if (name) usedFonts.add(name);
		}
	});

	root.walkAtRules("font-face", (atRule) => {
		let family = "";
		atRule.walkDecls("font-family", (decl) => {
			family = decl.value.trim().replace(/^["']|["']$/g, "");
		});
		if (family && !usedFonts.has(family)) {
			atRule.remove();
			report.fontFacesRemoved++;
		}
	});
}

function removeEmptyAtRules(root: postcss.Root) {
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

// ── Unused CSS variable cleanup ───────────────────────────────────────────────

interface VarCleanupResult {
	css: string;
	removed: number;
}

// TODO: potentially reduce parsing amount
function cleanUnusedVarsWithReport(
	css: string,
	externallyReferencedVars: Set<string>,
): VarCleanupResult {
	let changed = true;
	let result = css;
	let removed = 0;

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
			for (const ref of decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
				referenced.add(ref[1]);
			}
		});

		for (const [varName, entries] of declared) {
			if (!referenced.has(varName)) {
				for (const entry of entries) {
					entry.rule.walkDecls(entry.prop, (decl) => {
						decl.remove();
						changed = true;
						removed++;
					});
				}
			}
		}

		root.walkRules((rule) => {
			if (rule.nodes && rule.nodes.length === 0) rule.remove();
		});
		removeEmptyAtRules(root);

		result = root.toString();
	}

	return { css: result, removed };
}

function cleanUnusedVars(
	css: string,
	externallyReferencedVars: Set<string>,
): string {
	return cleanUnusedVarsWithReport(css, externallyReferencedVars).css;
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

	const manifest: PurgeManifest = JSON.parse(
		await Bun.file(manifestPath).text(),
	);
	const database = normalizePurgeDatabase(manifest);
	const roots = new Set(Object.keys(database.components).map(rootComponent));
	console.log(
		`[css-purge] Database loaded: ${Object.keys(database.components).length} records (${roots.size} components)`,
	);

	const usages = await scanConsumerSource(srcDir);
	const safelists = buildSafelists(usages, manifest);
	const usedRoots = new Set([...safelists.usedComponents].map(rootComponent));
	const removedRoots = [...roots].filter((root) => !usedRoots.has(root));

	console.log(
		`[css-purge] Components detected: ${usedRoots.size} used, ${removedRoots.length} removable`,
	);
	if (usedRoots.size > 0) {
		console.log(`[css-purge]   used: ${[...usedRoots].sort().join(", ")}`);
	}
	if (removedRoots.length > 0) {
		console.log(`[css-purge]   removable: ${removedRoots.sort().join(", ")}`);
	}
	console.log(
		`[css-purge] Safelist facts: ${safelists.classSafelist.size} classes, ${safelists.attrSafelist.size} attr selectors`,
	);

	const runtimeCssVarRefs = await collectRuntimeCssVarRefs(distDir);
	if (runtimeCssVarRefs.size > 0) {
		console.log(
			`[css-purge] Runtime CSS vars referenced from JS: ${runtimeCssVarRefs.size}`,
		);
	}

	const glob = new Glob("**/*.css");
	let totalBefore = 0;
	let totalAfter = 0;

	for await (const relPath of glob.scan({ cwd: distDir })) {
		const fullPath = `${distDir}/${relPath}`;
		const originalCss = await Bun.file(fullPath).text();
		const originalSize = Buffer.byteLength(originalCss, "utf-8");
		totalBefore += originalSize;

		console.log(
			`[css-purge] Processing ${relPath} (${(originalSize / 1024).toFixed(1)} KB)`,
		);

		const purged = purgeCssWithDatabase(originalCss, database, safelists);
		let purgedCss = purged.css;
		const afterSelectors = Buffer.byteLength(purgedCss, "utf-8");
		console.log(
			`[css-purge]   selectors: ${(originalSize / 1024).toFixed(1)} -> ${(afterSelectors / 1024).toFixed(1)} KB (${purged.report.selectorsRemoved} removed, ${purged.report.selectorsKeptUnknown} kept unknown)`,
		);
		console.log(
			`[css-purge]   attrs seen: ${purged.report.attrSelectorsSeen}; keyframes removed: ${purged.report.keyframesRemoved}`,
		);

		const vars = cleanUnusedVarsWithReport(purgedCss, runtimeCssVarRefs);
		purgedCss = vars.css;
		const afterVars = Buffer.byteLength(purgedCss, "utf-8");
		console.log(
			`[css-purge]   vars: ${(afterSelectors / 1024).toFixed(1)} -> ${(afterVars / 1024).toFixed(1)} KB (${vars.removed} removed)`,
		);

		purgedCss = minify(purgedCss);
		const finalSize = Buffer.byteLength(purgedCss, "utf-8");
		totalAfter += finalSize;
		console.log(`[css-purge]   minify: -> ${(finalSize / 1024).toFixed(1)} KB`);
		console.log(
			`[css-purge]   final: ${(originalSize / 1024).toFixed(1)} -> ${(finalSize / 1024).toFixed(1)} KB (${((1 - finalSize / originalSize) * 100).toFixed(1)}% reduction)`,
		);

		await Bun.write(fullPath, purgedCss);
	}

	console.log(
		`\n[css-purge] Total: ${(totalBefore / 1024).toFixed(1)} -> ${(totalAfter / 1024).toFixed(1)} KB (${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% reduction)`,
	);
}

if (import.meta.main) {
	main();
}

export {
	cleanUnusedVars,
	cleanUnusedVarsWithReport,
	normalizePurgeDatabase,
	purgeCssWithDatabase,
};
export type {
	NormalizedPurgeDatabase,
	PurgeResult,
	SelectorPurgeReport,
	VarCleanupResult,
};
