/**
 * Consumer-side JSX scanner.
 *
 * Walks a consumer source tree, resolves @pathscale/ui imports with SWC, and
 * records canonical component/part usage plus prop facts for database-first CSS
 * purge decisions.
 *
 * Usage:  bun run src/scan-consumer.ts <consumer-src-dir> <purge-manifest.json>
 */

import swc from "@swc/core";
import { Glob } from "bun";

// ── Types ──────────────────────────────────────────────────────────────────────

interface LegacyComponentManifest {
	classes: {
		always: string[];
		byProp: Record<string, string[] | Record<string, string[]>>;
	};
	attrs?: Record<string, Record<string, string>>;
	deps?: string[];
}

interface ComponentPurgeRecord extends LegacyComponentManifest {
	key?: string;
	component?: string;
	part?: string;
	selectors?: string[];
	attributeSelectors?: string[];
	cssVars?: {
		declared?: string[];
		referenced?: string[];
	};
	keyframes?: {
		declared?: string[];
		referenced?: string[];
	};
}

interface PurgeDatabaseV2 {
	version: 2;
	components: Record<string, ComponentPurgeRecord>;
	shared?: {
		selectors?: unknown[];
		cssVars?: Record<string, unknown>;
		keyframes?: Record<string, unknown>;
	};
}

type PurgeManifest = Record<string, LegacyComponentManifest> | PurgeDatabaseV2;

/** What we collect per component usage from JSX */
interface PropUsage {
	component: string;
	props: Map<string, string | "DYNAMIC">;
	booleanProps: Set<string>;
	hasSpread: boolean;
	source?: string;
}

interface ImportBindings {
	components: Map<string, string>;
	namespaces: Map<string, string | null>;
	conservativeUsages: PropUsage[];
}

interface Safelists {
	classSafelist: Set<string>;
	attrSafelist: Set<string>;
	usedComponents: Set<string>;
	dynamicComponents: Set<string>;
}

type AstNode = Record<string, unknown>;

// ── AST walker ─────────────────────────────────────────────────────────────────

function walkAST(node: unknown, visitor: (node: AstNode) => void) {
	if (!isRecord(node)) return;
	visitor(node);
	for (const key of Object.keys(node)) {
		if (key === "span") continue;
		const val = node[key];
		if (Array.isArray(val)) {
			for (const item of val) walkAST(item, visitor);
		} else if (val && typeof val === "object") {
			walkAST(val, visitor);
		}
	}
}

function kebabToPascal(s: string): string {
	return s
		.split("-")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

function componentFromDeepImport(source: string): string | null {
	const match = source.match(/^@pathscale\/ui\/components\/([^/]+)/);
	if (!match) return null;
	return kebabToPascal(match[1]);
}

function isUiImport(source: string | undefined): source is string {
	return Boolean(source?.startsWith("@pathscale/ui"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const prop = value[key];
	return typeof prop === "string" ? prop : undefined;
}

function getBoolean(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false;
	return value[key] === true;
}

function getPathString(value: unknown, ...keys: string[]): string | undefined {
	let current = value;
	for (const key of keys) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return typeof current === "string" ? current : undefined;
}

function getArray(value: unknown, key: string): unknown[] {
	if (!isRecord(value)) return [];
	const prop = value[key];
	return Array.isArray(prop) ? prop : [];
}

function joinPath(base: string, rel: string): string {
	return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

function canonicalImportedName(spec: unknown, source: string): string | null {
	const type = getString(spec, "type");
	if (getBoolean(spec, "isTypeOnly")) return null;
	const deepComponent = componentFromDeepImport(source);
	if (deepComponent) return deepComponent;

	if (source === "@pathscale/ui" && type === "ImportSpecifier") {
		return (
			getPathString(spec, "imported", "value") ??
			getPathString(spec, "local", "value") ??
			null
		);
	}

	return null;
}

function conservativeUsage(component: string, source: string): PropUsage {
	return {
		component,
		props: new Map(),
		booleanProps: new Set(),
		hasSpread: true,
		source,
	};
}

/** Extract @pathscale/ui bindings from a parsed module. */
function extractUIBindings(ast: unknown): ImportBindings {
	const bindings: ImportBindings = {
		components: new Map(),
		namespaces: new Map(),
		conservativeUsages: [],
	};

	for (const node of getArray(ast, "body")) {
		const nodeType = getString(node, "type");
		if (nodeType === "ImportDeclaration") {
			const source = getPathString(node, "source", "value");
			if (!isUiImport(source)) continue;

			for (const spec of getArray(node, "specifiers")) {
				const specType = getString(spec, "type");
				if (specType === "ImportSpecifier") {
					const local = getPathString(spec, "local", "value");
					const canonical = canonicalImportedName(spec, source);
					if (local && canonical) bindings.components.set(local, canonical);
				} else if (specType === "ImportDefaultSpecifier") {
					const local = getPathString(spec, "local", "value");
					const canonical = componentFromDeepImport(source) ?? local;
					if (local && canonical) bindings.components.set(local, canonical);
				} else if (specType === "ImportNamespaceSpecifier") {
					const local = getPathString(spec, "local", "value");
					if (local)
						bindings.namespaces.set(local, componentFromDeepImport(source));
				}
			}
		}

		if (
			nodeType === "ExportNamedDeclaration" &&
			isUiImport(getPathString(node, "source", "value"))
		) {
			const source = getPathString(node, "source", "value");
			if (!source) continue;
			const deepComponent = componentFromDeepImport(source);
			for (const spec of getArray(node, "specifiers")) {
				const exported =
					getPathString(spec, "orig", "value") ??
					getPathString(spec, "local", "value") ??
					getPathString(spec, "exported", "value") ??
					deepComponent;
				const canonical = deepComponent ?? exported;
				if (canonical)
					bindings.conservativeUsages.push(
						conservativeUsage(canonical, source),
					);
			}
		}

		if (
			nodeType === "ExportAllDeclaration" &&
			isUiImport(getPathString(node, "source", "value"))
		) {
			const source = getPathString(node, "source", "value");
			if (!source) continue;
			const deepComponent = componentFromDeepImport(source);
			if (deepComponent) {
				bindings.conservativeUsages.push(
					conservativeUsage(deepComponent, source),
				);
			}
		}
	}

	return bindings;
}

/** Back-compatible import extraction API: local binding -> canonical component. */
function extractUIImports(ast: unknown): Map<string, string> {
	return extractUIBindings(ast).components;
}

function jsxNameParts(name: unknown): string[] {
	if (!name) return [];
	const type = getString(name, "type");
	const value = getString(name, "value");
	if ((type === "Identifier" || type === "JSXIdentifier") && value)
		return [value];
	if (type === "JSXMemberExpression") {
		return [
			...jsxNameParts(isRecord(name) ? name.object : undefined),
			...jsxNameParts(isRecord(name) ? name.property : undefined),
		];
	}
	return [];
}

function canonicalComponentFromJsx(
	parts: string[],
	bindings: ImportBindings,
): string | null {
	if (parts.length === 0) return null;
	const [root, ...members] = parts;

	const namespaceComponent = bindings.namespaces.get(root);
	if (bindings.namespaces.has(root)) {
		if (namespaceComponent) {
			return [namespaceComponent, ...members].join(".");
		}
		return members.join(".") || null;
	}

	const rootComponent = bindings.components.get(root);
	if (!rootComponent) return null;
	return [rootComponent, ...members].join(".");
}

/** Extract JSX usages of UI components. */
function extractJSXUsages(
	ast: unknown,
	uiComponents: Map<string, string>,
): PropUsage[] {
	const bindings: ImportBindings = {
		components: uiComponents,
		namespaces: extractUIBindings(ast).namespaces,
		conservativeUsages: [],
	};
	const usages: PropUsage[] = [];

	walkAST(ast, (node) => {
		if (getString(node, "type") !== "JSXOpeningElement") return;

		const component = canonicalComponentFromJsx(
			jsxNameParts(node.name),
			bindings,
		);
		if (!component) return;

		const usage: PropUsage = {
			component,
			props: new Map(),
			booleanProps: new Set(),
			hasSpread: false,
		};

		for (const attr of getArray(node, "attributes")) {
			const attrType = getString(attr, "type");
			if (attrType === "SpreadElement" || attrType === "JSXSpreadAttribute") {
				usage.hasSpread = true;
				continue;
			}
			if (attrType !== "JSXAttribute") continue;

			const propName = getPathString(attr, "name", "value");
			if (!propName) continue;

			const attrValue = isRecord(attr) ? attr.value : undefined;
			const attrValueType = getString(attrValue, "type");
			if (!attrValue) {
				usage.booleanProps.add(propName);
			} else if (attrValueType === "StringLiteral") {
				usage.props.set(propName, getString(attrValue, "value") ?? "");
			} else {
				usage.props.set(propName, "DYNAMIC");
			}
		}

		usages.push(usage);
	});

	return usages;
}

// ── Manifest compatibility ────────────────────────────────────────────────────

function manifestComponents(
	manifest: PurgeManifest,
): Record<string, LegacyComponentManifest> {
	if (isPurgeDatabaseV2(manifest)) {
		return manifest.components;
	}
	return manifest as Record<string, LegacyComponentManifest>;
}

function isPurgeDatabaseV2(
	manifest: PurgeManifest,
): manifest is PurgeDatabaseV2 {
	return (
		(manifest as PurgeDatabaseV2).version === 2 &&
		isRecord((manifest as PurgeDatabaseV2).components)
	);
}

// ── Safelist builder ───────────────────────────────────────────────────────────

function buildSafelists(
	allUsages: PropUsage[],
	manifest: PurgeManifest,
): Safelists {
	const classSafelist = new Set<string>();
	const attrSafelist = new Set<string>();
	const usedComponents = new Set<string>();
	const dynamicComponents = new Set<string>();
	const componentUsages = new Map<string, PropUsage[]>();
	const components = manifestComponents(manifest);

	for (const usage of expandDependencyUsages(allUsages, components)) {
		const existing = componentUsages.get(usage.component) ?? [];
		existing.push(usage);
		componentUsages.set(usage.component, existing);
		usedComponents.add(usage.component);
		if (usage.hasSpread || [...usage.props.values()].includes("DYNAMIC")) {
			dynamicComponents.add(usage.component);
		}
	}

	for (const [entryName, entry] of Object.entries(components)) {
		const matchingUsages = findMatchingUsages(entryName, componentUsages);
		if (matchingUsages.length === 0) continue;

		usedComponents.add(entryName);

		for (const cls of entry.classes.always) {
			classSafelist.add(cls);
		}

		for (const [propOrSlot, value] of Object.entries(entry.classes.byProp)) {
			if (Array.isArray(value)) {
				if (isPropUsed(propOrSlot, matchingUsages)) {
					for (const cls of value) classSafelist.add(cls);
				}
			} else {
				const usedValues = getUsedEnumValues(propOrSlot, matchingUsages);
				if (usedValues === "ALL") {
					for (const classes of Object.values(value)) {
						for (const cls of classes) classSafelist.add(cls);
					}
				} else {
					for (const val of usedValues) {
						if (value[val]) {
							for (const cls of value[val]) classSafelist.add(cls);
						}
					}
				}
			}
		}

		if (entry.attrs) {
			for (const [propName, attrMap] of Object.entries(entry.attrs)) {
				if (isPropUsed(propName, matchingUsages)) {
					for (const [attr, val] of Object.entries(attrMap)) {
						attrSafelist.add(`[${attr}="${val}"]`);
					}
				}
			}
		}
	}

	return { classSafelist, attrSafelist, usedComponents, dynamicComponents };
}

function expandDependencyUsages(
	allUsages: PropUsage[],
	manifest: Record<string, LegacyComponentManifest>,
): PropUsage[] {
	const result = [...allUsages];
	const queue = [...allUsages.map((usage) => rootComponent(usage.component))];
	const seen = new Set(queue);

	while (queue.length > 0) {
		const root = queue.pop();
		if (!root) continue;
		const deps = depsForRoot(root, manifest);
		for (const dep of deps) {
			if (seen.has(dep)) continue;
			seen.add(dep);
			queue.push(dep);
			result.push(conservativeUsage(dep, "manifest-dependency"));
		}
	}

	return result;
}

function depsForRoot(
	root: string,
	manifest: Record<string, LegacyComponentManifest>,
): string[] {
	const deps = new Set<string>();
	for (const [key, entry] of Object.entries(manifest)) {
		if (rootComponent(key) !== root) continue;
		for (const dep of entry.deps ?? []) deps.add(dep);
	}
	return [...deps];
}

function rootComponent(component: string): string {
	return component.split(".")[0];
}

function findMatchingUsages(
	entryName: string,
	usageMap: Map<string, PropUsage[]>,
): PropUsage[] {
	const direct = usageMap.get(entryName) ?? [];
	const results = [...direct];
	const entryRoot = rootComponent(entryName);

	for (const [usageName, usages] of usageMap) {
		if (usageName === entryName) continue;
		if (entryName.includes(".") && usageName === entryRoot) {
			results.push(...usages);
		}
	}

	return results;
}

function isPropUsed(propName: string, usages: PropUsage[]): boolean {
	for (const usage of usages) {
		if (usage.hasSpread) return true;
		if (usage.booleanProps.has(propName)) return true;
		if (usage.props.has(propName)) return true;
	}
	return false;
}

function getUsedEnumValues(
	slotName: string,
	usages: PropUsage[],
): Set<string> | "ALL" {
	const values = new Set<string>();
	for (const usage of usages) {
		if (usage.hasSpread) return "ALL";
		const val = usage.props.get(slotName);
		if (val === "DYNAMIC") return "ALL";
		if (val !== undefined) values.add(val);
		if (usage.booleanProps.has(slotName)) return "ALL";
	}
	return values;
}

// ── Consumer source scanning ───────────────────────────────────────────────────

async function scanConsumerSource(srcDir: string): Promise<PropUsage[]> {
	const allUsages: PropUsage[] = [];
	const glob = new Glob("**/*.{tsx,ts,jsx,js}");

	for await (const relPath of glob.scan({ cwd: srcDir })) {
		if (relPath.includes("node_modules")) continue;
		const fullPath = joinPath(srcDir, relPath);
		const code = await Bun.file(fullPath).text();
		if (!code.includes("@pathscale/ui")) continue;

		const isTsx = /\.[tj]sx$/.test(relPath);
		const ast = await swc.parse(code, { syntax: "typescript", tsx: isTsx });
		const bindings = extractUIBindings(ast);
		if (
			bindings.components.size === 0 &&
			bindings.namespaces.size === 0 &&
			bindings.conservativeUsages.length === 0
		) {
			continue;
		}

		allUsages.push(...bindings.conservativeUsages);
		const jsxUsages = extractJSXUsages(ast, bindings.components);
		allUsages.push(...jsxUsages);
		for (const component of bindings.components.values()) {
			if (
				jsxUsages.some(
					(usage) =>
						usage.component === component ||
						usage.component.startsWith(`${component}.`),
				)
			) {
				continue;
			}
			allUsages.push(conservativeUsage(component, "import-without-direct-jsx"));
		}
	}

	return allUsages;
}

// ── Main (standalone CLI) ─────────────────────────────────────────────────────

async function main() {
	const [srcDir, manifestPath] = process.argv.slice(2);
	if (!srcDir || !manifestPath) {
		console.error(
			"Usage: bun run src/scan-consumer.ts <consumer-src-dir> <purge-manifest.json>",
		);
		process.exit(1);
	}

	const manifest: PurgeManifest = JSON.parse(
		await Bun.file(manifestPath).text(),
	);
	const resolvedSrc = srcDir;
	const manifestSize = Object.keys(manifestComponents(manifest)).length;
	console.log(`Scanning ${resolvedSrc} for @pathscale/ui component usage...`);
	console.log(`Manifest: ${manifestSize} entries\n`);

	const usages = await scanConsumerSource(resolvedSrc);
	const { classSafelist, attrSafelist, usedComponents } = buildSafelists(
		usages,
		manifest,
	);

	console.log("=== Components Detected ===");
	for (const component of [...usedComponents].sort()) {
		console.log(`  ${component}`);
	}

	console.log("\n=== Class Safelist ===");
	for (const cls of [...classSafelist].sort()) {
		console.log(`  ${cls}`);
	}

	console.log("\n=== Attribute Safelist ===");
	for (const attr of [...attrSafelist].sort()) {
		console.log(`  ${attr}`);
	}

	console.log(
		`\nTotal: ${usedComponents.size} components, ${classSafelist.size} classes, ${attrSafelist.size} attribute selectors`,
	);
}

if (import.meta.main) {
	main();
}

export {
	buildSafelists,
	extractJSXUsages,
	extractUIImports,
	scanConsumerSource,
};
export type {
	LegacyComponentManifest as ComponentManifest,
	ComponentPurgeRecord,
	LegacyComponentManifest,
	PropUsage,
	PurgeDatabaseV2,
	PurgeManifest,
	Safelists,
};
