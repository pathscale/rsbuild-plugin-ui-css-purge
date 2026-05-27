/**
 * Lib-side purge database generator.
 *
 * Reads all `*.classes.ts` files from @pathscale/ui's component tree and
 * produces a versioned `purge-manifest.json` database consumed by the postbuild
 * purge script.
 *
 * Usage:  bun run src/generate-manifest.ts <path-to-ui-src/components>
 * Output: purge-manifest.json in cwd (or pass --out <path>)
 */

import { Glob } from "bun";
import {
	type AnimationName,
	type AttrSelectorOperator,
	type Combinator,
	type Declaration,
	type Selector,
	type SelectorComponent,
	transform,
	type UnparsedProperty,
	type Visitor,
} from "lightningcss";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComponentPurgeRecord {
	key: string;
	component: string;
	part?: string;
	classes: {
		always: string[];
		byProp: Record<string, string[] | Record<string, string[]>>;
	};
	attrs?: Record<string, Record<string, string>>;
	attributeSelectors: string[];
	selectors: string[];
	cssVars: {
		declared: string[];
		referenced: string[];
	};
	keyframes: {
		declared: string[];
		referenced: string[];
	};
	deps?: string[];
}

interface PurgeDatabaseV2 {
	version: 2;
	components: Record<string, ComponentPurgeRecord>;
	shared: {
		selectors: { selector: string; components: string[] }[];
		cssVars: Record<string, { declaredBy: string[]; referencedBy: string[] }>;
		keyframes: Record<string, { declaredBy: string[]; referencedBy: string[] }>;
	};
}

interface ClassWalkResult {
	classes: ComponentPurgeRecord["classes"];
	attrs?: Record<string, Record<string, string>>;
}

interface CssFacts {
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

// ── Tailwind utility filter ───────────────────────────────────────────────────

/** Matches Tailwind utility class prefixes — these should NOT appear as owned component classes. */
const twPattern =
	/^(-?)(flex|grid|gap|items|justify|self|place|order|col|row|auto|basis|grow|shrink|space|overflow|relative|absolute|fixed|sticky|static|block|inline|hidden|visible|invisible|z|inset|top|right|bottom|left|float|clear|isolate|object|aspect|container|columns|break|box|display|table|caption|border|rounded|outline|ring|shadow|opacity|mix|bg|from|via|to|text|font|leading|tracking|indent|align|whitespace|word|hyphens|content|list|decoration|underline|overline|line|no-underline|uppercase|lowercase|capitalize|normal|italic|not-italic|antialiased|subpixel|truncate|w|h|min|max|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|size|scroll|snap|touch|select|resize|cursor|caret|pointer|will|appearance|accent|transition|duration|delay|ease|animate|scale|rotate|translate|skew|transform|origin|filter|blur|brightness|contrast|drop|grayscale|hue|invert|saturate|sepia|backdrop|sr|forced|print|motion|lg|md|sm|xl|2xl|dark|hover|focus|active|disabled|first|last|odd|even|group|peer)($|[-:[.])/;

function isTailwindUtility(cls: string): boolean {
	return twPattern.test(cls);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Flatten a class value into individual non-Tailwind component class names. */
function flattenClasses(val: unknown): string[] {
	let classes: string[];
	if (typeof val === "string") {
		classes = val.split(/\s+/).filter(Boolean);
	} else if (Array.isArray(val)) {
		classes = val.flatMap((s) => flattenClasses(s));
	} else if (val !== null && typeof val === "object") {
		classes = Object.values(val).flatMap((v) => flattenClasses(v));
	} else {
		return [];
	}
	return [...new Set(classes.filter((cls) => !isTailwindUtility(cls)))];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function kebabToPascal(s: string): string {
	return s
		.split("-")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

function joinPath(base: string, rel: string): string {
	return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

function dirname(filePath: string): string {
	const parts = filePath.split(/[\\/]/);
	parts.pop();
	return parts.length === 0 ? "." : parts.join("/");
}

function basename(filePath: string, suffix = ""): string {
	const name = filePath.split(/[\\/]/).pop() ?? filePath;
	return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function resolvePath(filePath: string): string {
	if (filePath.startsWith("/")) return filePath;
	return joinPath(process.cwd(), filePath);
}

function canonicalComponentFromRelPath(relPath: string): string {
	const stem = basename(relPath, ".classes.ts");
	const dir = dirname(relPath);
	const dirParts = dir === "." ? [] : dir.split(/[\\/]/).filter(Boolean);
	const source =
		stem === "classes" && dirParts.length > 0
			? (dirParts.at(-1) ?? stem)
			: stem;
	return kebabToPascal(source);
}

function walkClassesObject(obj: Record<string, unknown>): ClassWalkResult {
	const always: string[] = [];
	const byProp: Record<string, string[] | Record<string, string[]>> = {};
	let attrs: Record<string, Record<string, string>> | undefined;

	for (const [slot, value] of Object.entries(obj)) {
		if (slot === "base") {
			always.push(...flattenClasses(value));
		} else if (slot === "attrs") {
			if (isRecord(value)) {
				attrs = {};
				for (const [propName, attrMap] of Object.entries(value)) {
					if (isRecord(attrMap))
						attrs[propName] = attrMap as Record<string, string>;
				}
			}
		} else if (slot === "flag") {
			if (isRecord(value)) {
				for (const [propName, classVal] of Object.entries(value)) {
					byProp[propName] = flattenClasses(classVal);
				}
			}
		} else if (isRecord(value)) {
			const enumMap: Record<string, string[]> = {};
			for (const [enumKey, classVal] of Object.entries(value)) {
				enumMap[enumKey] = flattenClasses(classVal);
			}
			byProp[slot] = enumMap;
		}
	}

	return { classes: { always: [...new Set(always)], byProp }, attrs };
}

const KNOWN_SLOTS = new Set([
	"base",
	"variant",
	"size",
	"flag",
	"color",
	"tone",
	"attrs",
]);

function isCompound(obj: Record<string, unknown>): boolean {
	for (const key of Object.keys(obj)) {
		if (KNOWN_SLOTS.has(key)) return false;
	}
	return true;
}

function emptyCssFacts(): CssFacts {
	return {
		selectors: [],
		attributeSelectors: [],
		cssVars: { declared: [], referenced: [] },
		keyframes: { declared: [], referenced: [] },
	};
}

const AnimationNameKeywords = new Set(["none", "initial", "inherit", "unset"]);
async function scanCssFacts(componentDir: string): Promise<CssFacts> {
	const facts = emptyCssFacts();
	const glob = new Glob("**/*.css");
	const visitor: Visitor<never> = {
		Rule(rule) {
			if (rule.type === "keyframes") {
				const { name } = rule.value;
				facts.keyframes.declared.push(name.value);
			}
		},

		Declaration(decl) {
			// "animation" with var(), unparsed due to var() interfering with arg position detection
			const animationNamesUnparsed = (p: UnparsedProperty): AnimationName[] => {
				let valid = true;
				const names: AnimationName[] = [];
				if (p.propertyId.property !== "animation") return names;
				for (const { value: token } of p.value) {
					if (!(typeof token === "object" && "type" in token)) continue;
					if (token.type === "comma") valid = true; // name only appears after comma or at start
					if (token.type === "comma" || token.type === "white-space") continue;
					if (valid && (token.type === "ident" || token.type === "string")) {
						names.push(token);
					}
					valid = false;
				}
				return names;
			};

			const animationNames = (decl: Declaration): AnimationName[] => {
				switch (decl.property) {
					case "animation":
						return decl.value.map((item) => item.name);
					case "animation-name":
						return decl.value;
					case "unparsed":
						return animationNamesUnparsed(decl.value);
					default:
						return [];
				}
			};

			for (const name of animationNames(decl)) {
				if (name.type === "none") continue;
				if (AnimationNameKeywords.has(name.value)) continue;
				facts.keyframes.referenced.push(name.value);
			}

			// variable declarations
			(() => {
				if (decl.property !== "custom") return;
				if (!decl.value.name.startsWith("--")) return;
				facts.cssVars.declared.push(decl.value.name);
			})();
		},

		// var() statements
		Variable(variable) {
			facts.cssVars.referenced.push(variable.name.ident);
		},

		Selector(selector) {
			facts.selectors.push(stringifySelector(selector));
			const attrs = extractSelectorAttrs(selector).map(stringifySelectorAttr);
			facts.attributeSelectors.push(...attrs);
		},
	};

	for await (const relPath of glob.scan({ cwd: componentDir })) {
		const css = await Bun.file(joinPath(componentDir, relPath)).text();
		transform({
			filename: relPath,
			code: Buffer.from(css),
			minify: false,
			sourceMap: false,
			errorRecovery: true,
			visitor,
		});
	}

	return {
		selectors: [...new Set(facts.selectors)].sort(),
		attributeSelectors: [...new Set(facts.attributeSelectors)].sort(),
		cssVars: {
			declared: [...new Set(facts.cssVars.declared)].sort(),
			referenced: [...new Set(facts.cssVars.referenced)].sort(),
		},
		keyframes: {
			declared: [...new Set(facts.keyframes.declared)].sort(),
			referenced: [...new Set(facts.keyframes.referenced)].sort(),
		},
	};
}

type SelectorAttribute = Extract<SelectorComponent, { type: "attribute" }>;
function extractSelectorAttrs(selector: Selector): SelectorAttribute[] {
	const attrs: SelectorAttribute[] = [];
	const extract = (sel: Selector) => {
		const prefixes = ["data-", "aria-"];
		for (const comp of sel) {
			if (comp.type !== "attribute") continue;
			if (prefixes.every((p) => !comp.name.startsWith(p))) continue;
			attrs.push(comp);
		}
	};

	// From top level
	extract(selector);
	// From pseudo classes
	for (const c of selector) for (const s of extractSelectors(c)) extract(s);

	return attrs;
}

function extractSelectors(comp: SelectorComponent): Selector[] {
	if ("kind" in comp && comp.kind === "host")
		return comp.selectors ? [comp.selectors] : [];
	if ("selectors" in comp) return comp.selectors;
	if ("selector" in comp) return [comp.selector];
	return [];
}

const OperatorMap: Record<AttrSelectorOperator, string> = {
	equal: "=",
	includes: "~=",
	"dash-match": "|=",
	prefix: "^=",
	suffix: "$=",
	substring: "*=",
} as const;

const CombinatorMap: Record<Combinator, string> = {
	child: " > ",
	descendant: " ",
	"next-sibling": " + ",
	"later-sibling": " ~ ",
	deep: " /deep/ ",
	"deep-descendant": " >>> ",
	"pseudo-element": "::",
	part: "::part",
	"slot-assignment": "::slotted",
} as const;

// TODO: use ToCSS from napi-rs module or use transform with dummy rule or use pure Rust
const ShortPseudo = new Set(["before", "after", "first-letter", "first-line"]);
function stringifySelector(selector: Selector): string {
	return selector
		.map((comp) => {
			switch (comp.type) {
				case "universal":
					return "*";
				case "nesting":
					return "&";
				case "type":
					return comp.name;
				case "id":
					return `#${comp.name}`;
				case "class":
					return `.${comp.name}`;
				case "combinator":
					return CombinatorMap[comp.value];
				case "attribute":
					return stringifySelectorAttr(comp);
				case "namespace":
					if (comp.kind === "named") return `${comp.prefix}|`;
					if (comp.kind === "any") return "*|";
					return "|";
				case "pseudo-class": {
					if ("a" in comp && "b" in comp) return stringifyNth(comp);
					const s = extractSelectors(comp).map(stringifySelector);
					if (comp.kind === "custom") s.push(comp.name);
					if ("direction" in comp) s.push(comp.direction);
					if (s.length === 0) return `:${comp.kind}`;
					return `:${comp.kind}(${s.join(", ")})`;
				}
				case "pseudo-element": {
					const p = ShortPseudo.has(comp.kind) ? ":" : "::";
					if (comp.kind === "custom") return `${p}${comp.name}`;
					if (/^(webkit|moz|ms|o)-/.test(comp.kind)) return `${p}-${comp.kind}`;
					return `${p}${comp.kind}`;
				}
				default:
					return "";
			}
		})
		.join("");
}

function stringifySelectorAttr(attr: SelectorAttribute): string {
	const { name, operation } = attr;
	if (!operation) return `[${name}]`;
	const { operator, value } = operation;
	return `[${name}${OperatorMap[operator]}"${value}"]`;
}

type Nth = Extract<SelectorComponent, { a: number; b: number }>;
function stringifyNth(nth: Nth): string {
	const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
	const anb = (a: number, b: number): string => {
		if (a === 0 && b === 0) return "0";
		if (a === 1 && b === 0) return "n";
		if (a === -1 && b === 0) return "-n";
		if (b === 0) return `${a}n`;
		if (a === 2 && b === 1) return "odd";
		if (a === 0) return b.toString();
		if (a === 1) return `n${signed(b)}`;
		if (a === -1) return `-n${signed(b)}`;
		return `${a}n${signed(b)}`;
	};
	let rule = anb(nth.a, nth.b);
	const s = (("of" in nth && nth.of) || []).map(stringifySelector);
	if (s.length > 0) rule += ` of ${s.join(", ")}`;
	return `:${nth.kind}(${rule})`;
}

function createRecord(
	key: string,
	component: string,
	part: string | undefined,
	classFacts: ClassWalkResult,
	cssFacts: CssFacts,
): ComponentPurgeRecord {
	const record: ComponentPurgeRecord = {
		key,
		component,
		part,
		classes: classFacts.classes,
		attributeSelectors: cssFacts.attributeSelectors,
		selectors: cssFacts.selectors,
		cssVars: cssFacts.cssVars,
		keyframes: cssFacts.keyframes,
	};
	if (classFacts.attrs && Object.keys(classFacts.attrs).length > 0) {
		record.attrs = classFacts.attrs;
	}
	return record;
}

function updateShared(db: PurgeDatabaseV2) {
	const selectorOwners = new Map<string, Set<string>>();

	for (const [key, record] of Object.entries(db.components)) {
		for (const selector of record.selectors) {
			const owners = selectorOwners.get(selector) ?? new Set<string>();
			owners.add(key);
			selectorOwners.set(selector, owners);
		}

		for (const varName of record.cssVars.declared) {
			const entry = db.shared.cssVars[varName] ?? {
				declaredBy: [],
				referencedBy: [],
			};
			entry.declaredBy.push(key);
			db.shared.cssVars[varName] = entry;
		}
		for (const varName of record.cssVars.referenced) {
			const entry = db.shared.cssVars[varName] ?? {
				declaredBy: [],
				referencedBy: [],
			};
			entry.referencedBy.push(key);
			db.shared.cssVars[varName] = entry;
		}

		for (const name of record.keyframes.declared) {
			const entry = db.shared.keyframes[name] ?? {
				declaredBy: [],
				referencedBy: [],
			};
			entry.declaredBy.push(key);
			db.shared.keyframes[name] = entry;
		}
		for (const name of record.keyframes.referenced) {
			const entry = db.shared.keyframes[name] ?? {
				declaredBy: [],
				referencedBy: [],
			};
			entry.referencedBy.push(key);
			db.shared.keyframes[name] = entry;
		}
	}

	db.shared.selectors = [...selectorOwners.entries()]
		.map(([selector, owners]) => ({ selector, components: [...owners].sort() }))
		.sort((a, b) => a.selector.localeCompare(b.selector));

	for (const entry of Object.values(db.shared.cssVars)) {
		entry.declaredBy = [...new Set(entry.declaredBy)].sort();
		entry.referencedBy = [...new Set(entry.referencedBy)].sort();
	}
	for (const entry of Object.values(db.shared.keyframes)) {
		entry.declaredBy = [...new Set(entry.declaredBy)].sort();
		entry.referencedBy = [...new Set(entry.referencedBy)].sort();
	}
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	let componentsDir = args[0];
	let outPath = "purge-manifest.json";

	const outIdx = args.indexOf("--out");
	if (outIdx !== -1 && args[outIdx + 1]) {
		outPath = args[outIdx + 1];
	}

	if (!componentsDir) {
		console.error(
			"Usage: bun run src/generate-manifest.ts <path-to-components-dir> [--out <path>]",
		);
		process.exit(1);
	}

	componentsDir = resolvePath(componentsDir);
	console.log(`Scanning ${componentsDir} for *.classes.ts files...`);

	const db: PurgeDatabaseV2 = {
		version: 2,
		components: {},
		shared: {
			selectors: [],
			cssVars: {},
			keyframes: {},
		},
	};
	const glob = new Glob("**/*.classes.ts");

	for await (const relPath of glob.scan({ cwd: componentsDir })) {
		const fullPath = joinPath(componentsDir, relPath);
		const mod = await import(fullPath);
		const classesExport = mod.CLASSES;

		if (!classesExport || typeof classesExport !== "object") {
			console.warn(`  SKIP ${relPath} - no CLASSES export found`);
			continue;
		}

		const component = canonicalComponentFromRelPath(relPath);
		const componentDir = dirname(fullPath);
		const cssFacts = await scanCssFacts(componentDir);

		if (isCompound(classesExport as Record<string, unknown>)) {
			for (const [partName, partObj] of Object.entries(
				classesExport as Record<string, unknown>,
			)) {
				if (isRecord(partObj)) {
					const key = `${component}.${partName}`;
					db.components[key] = createRecord(
						key,
						component,
						partName,
						walkClassesObject(partObj),
						cssFacts,
					);
					console.log(`  ok ${key}`);
				}
			}
		} else {
			db.components[component] = createRecord(
				component,
				component,
				undefined,
				walkClassesObject(classesExport as Record<string, unknown>),
				cssFacts,
			);
			console.log(`  ok ${component}`);
		}
	}

	await attachDependencies(componentsDir, db);
	updateShared(db);

	const json = JSON.stringify(db, null, 2);
	await Bun.write(outPath, json);
	console.log(
		`\nWrote ${outPath} (${Object.keys(db.components).length} records, ${json.length} bytes)`,
	);
}

async function attachDependencies(componentsDir: string, db: PurgeDatabaseV2) {
	const dirs = new Set<string>();
	const classesGlob = new Glob("*/*.classes.ts");
	for await (const relPath of classesGlob.scan({ cwd: componentsDir })) {
		dirs.add(relPath.split(/[\\/]/)[0]);
	}
	const dirToPascal = new Map(
		[...dirs].map((dir) => [dir, kebabToPascal(dir)]),
	);
	const importRegex = /from\s+["']\.\.\/([^/"']+)/g;
	const depGlob = new Glob("**/*.{tsx,ts,js,mjs}");

	for (const dir of dirs) {
		const component = dirToPascal.get(dir);
		if (!component) continue;
		const componentDeps = new Set<string>();
		const scanDir = joinPath(componentsDir, dir);

		for await (const relFile of depGlob.scan({ cwd: scanDir })) {
			const code = await Bun.file(joinPath(scanDir, relFile)).text();
			for (const match of code.matchAll(importRegex)) {
				const depDir = match[1];
				if (depDir === "types" || depDir === "utils" || depDir === "..")
					continue;
				const dep = dirToPascal.get(depDir);
				if (dep && dep !== component) componentDeps.add(dep);
			}
		}

		if (componentDeps.size > 0) {
			const deps = [...componentDeps].sort();
			for (const record of Object.values(db.components)) {
				if (record.component === component) record.deps = deps;
			}
			console.log(`  deps ${component}: ${deps.join(", ")}`);
		}
	}
}

if (import.meta.main) {
	main();
}
