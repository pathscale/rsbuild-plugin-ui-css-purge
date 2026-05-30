import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import swc from "@swc/core";
import { cleanUnusedVars, purgeCssWithDatabase } from "../src/postbuild-purge";
import {
	buildSafelists,
	extractJSXUsages,
	extractUIImports,
	type PropUsage,
	type PurgeManifest,
	scanConsumerSource,
} from "../src/scan-consumer";

const manifest: PurgeManifest = {
	Button: {
		classes: {
			always: ["button"],
			byProp: {
				variant: {
					primary: ["button--primary"],
					secondary: ["button--secondary"],
				},
				disabled: ["button--disabled"],
			},
		},
		attrs: {
			open: { "data-open": "true" },
		},
	},
	Drawer: {
		classes: {
			always: ["drawer", "drawer__dialog"],
			byProp: {
				placement: {
					bottom: ["drawer__dialog--bottom"],
					right: ["drawer__dialog--right"],
				},
			},
		},
	},
	"Tabs.Tab": {
		classes: {
			always: ["tabs__tab"],
			byProp: {},
		},
	},
};

function usage(
	component: string,
	props: Record<string, string | "DYNAMIC"> = {},
	options: { booleans?: string[]; spread?: boolean } = {},
): PropUsage {
	return {
		component,
		props: new Map(Object.entries(props)),
		booleanProps: new Set(options.booleans ?? []),
		hasSpread: options.spread ?? false,
	};
}

test("attribute selectors are preserved for known used state props", () => {
	const safelists = buildSafelists(
		[usage("Button", {}, { booleans: ["open"] })],
		manifest,
	);
	const result = purgeCssWithDatabase(
		'.button[data-open="true"]{display:block}.drawer__dialog{display:block}',
		manifest,
		safelists,
	);

	expect(result.css).toContain('.button[data-open="true"]');
	expect(result.css).not.toContain(".drawer__dialog");
});

test("runtime data state selectors from used components are preserved", () => {
	const safelists = buildSafelists([usage("Tabs.Tab")], manifest);
	const result = purgeCssWithDatabase(
		'.tabs__tab[data-selected="true"]{font-weight:600}.drawer__dialog[data-placement="bottom"]{display:block}',
		manifest,
		safelists,
	);

	expect(result.css).toContain('.tabs__tab[data-selected="true"]');
	expect(result.css).not.toContain(".drawer__dialog");
});

test("unused component BEM selectors are removed while used variants are retained", () => {
	const safelists = buildSafelists(
		[usage("Button", { variant: "primary" })],
		manifest,
	);
	const result = purgeCssWithDatabase(
		".button{display:inline-flex}.button.button--primary{color:red}.button.button--secondary{color:blue}.drawer__dialog{display:block}",
		manifest,
		safelists,
	);

	expect(result.css).toContain(".button");
	expect(result.css).toContain(".button--primary");
	expect(result.css).not.toContain(".button--secondary");
	expect(result.css).not.toContain(".drawer__dialog");
});

test("import aliases resolve to canonical component names", async () => {
	const ast = await swc.parse(
		'import { Button as PrimaryButton } from "@pathscale/ui"; export function App(){ return <PrimaryButton variant="primary" /> }',
		{ syntax: "typescript", tsx: true },
	);
	const imports = extractUIImports(ast);
	const usages = extractJSXUsages(ast, imports);
	const safelists = buildSafelists(usages, manifest);

	expect(usages[0]?.component).toBe("Button");
	expect(safelists.classSafelist.has("button--primary")).toBe(true);
	expect(safelists.classSafelist.has("button--secondary")).toBe(false);
});

test("deep default aliases resolve from the component path", async () => {
	const ast = await swc.parse(
		'import ButtonBase, { type ButtonVariant, Button as ButtonNamed } from "@pathscale/ui/components/button"; export function App(){ return <ButtonBase variant="secondary" /> }',
		{ syntax: "typescript", tsx: true },
	);
	const imports = extractUIImports(ast);
	const usages = extractJSXUsages(ast, imports);
	const safelists = buildSafelists(usages, manifest);

	expect(imports.get("ButtonBase")).toBe("Button");
	expect(imports.get("ButtonVariant")).toBeUndefined();
	expect(imports.get("ButtonNamed")).toBe("Button");
	expect(usages[0]?.component).toBe("Button");
	expect(safelists.classSafelist.has("button--secondary")).toBe(true);
});

test("spread props keep all variants for that component", () => {
	const safelists = buildSafelists(
		[usage("Button", {}, { spread: true })],
		manifest,
	);

	expect(safelists.classSafelist.has("button--primary")).toBe(true);
	expect(safelists.classSafelist.has("button--secondary")).toBe(true);
	expect(safelists.classSafelist.has("button--disabled")).toBe(true);
});

test("imported wrappers without direct JSX keep all variants conservatively", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "ui-css-purge-wrapper-"));
	try {
		const src = join(tmp, "src");
		await mkdir(src, { recursive: true });
		await Bun.write(
			join(src, "wrapper.tsx"),
			'import { Button as ButtonBase } from "@pathscale/ui"; export const MyButton = ButtonBase;',
		);
		const usages = await scanConsumerSource(src);
		const safelists = buildSafelists(usages, manifest);

		expect(usages[0]?.component).toBe("Button");
		expect(safelists.classSafelist.has("button--primary")).toBe(true);
		expect(safelists.classSafelist.has("button--secondary")).toBe(true);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("unknown selectors are kept", () => {
	const safelists = buildSafelists([usage("Button")], manifest);
	const result = purgeCssWithDatabase(
		".app-shell{display:grid}.button{display:inline-flex}",
		manifest,
		safelists,
	);

	expect(result.css).toContain(".app-shell");
	expect(result.report.selectorsKeptUnknown).toBe(1);
});

test("CSS vars are removed only after selector purge proves them unreferenced", () => {
	const safelists = buildSafelists([usage("Button")], manifest);
	const purged = purgeCssWithDatabase(
		":root{--used:red;--unused:blue}.button{color:var(--used)}.drawer__dialog{color:var(--unused)}",
		manifest,
		safelists,
	);
	const cleaned = cleanUnusedVars(purged.css, new Set());

	expect(cleaned).toContain("--used");
	expect(cleaned).not.toContain("--unused");
});

test("postbuild CLI runs under Bun", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "ui-css-purge-"));
	try {
		const src = join(tmp, "src");
		const dist = join(tmp, "dist");
		await mkdir(src, { recursive: true });
		await mkdir(dist, { recursive: true });
		await Bun.write(
			join(src, "app.tsx"),
			'import { Button } from "@pathscale/ui"; export function App(){ return <Button variant="primary" /> }',
		);
		await Bun.write(
			join(dist, "app.css"),
			".button{display:block}.drawer__dialog{display:block}",
		);
		await Bun.write(join(tmp, "purge-manifest.json"), JSON.stringify(manifest));

		const proc = Bun.spawn(
			[
				"bun",
				"src/postbuild-purge.ts",
				"--src",
				src,
				"--dist",
				dist,
				"--manifest",
				join(tmp, "purge-manifest.json"),
			],
			{
				cwd: join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, output, error] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const css = await Bun.file(join(dist, "app.css")).text();

		expect(error).toBe("");
		expect(output).toContain("[css-purge] Database loaded");
		expect(exitCode).toBe(0);
		expect(css).toContain(".button");
		expect(css).not.toContain("drawer__dialog");
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
