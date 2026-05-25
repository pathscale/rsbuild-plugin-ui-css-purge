# @pathscale/rsbuild-plugin-ui-css-purge

Database-first CSS purge for `@pathscale/ui` consumers. It scans consumer JSX with SWC, cross-references a versioned component purge database, and removes only selectors whose ownership and unused state are known.

Runs as a postbuild step under Bun.

## How It Works

The purge operates in two phases across two repositories.

**Lib side (`@pathscale/ui`):** Components ship `*.classes.ts` files that describe component-owned classes by slot and prop. The manifest generator also scans colocated component CSS for selectors, data/aria attributes, CSS variable references, keyframes, and component dependencies. It writes a versioned `purge-manifest.json` database:

```ts
interface PurgeDatabaseV2 {
	version: 2;
	components: Record<string, ComponentPurgeRecord>;
	shared: {
		selectors: { selector: string; components: string[] }[];
		cssVars: Record<string, { declaredBy: string[]; referencedBy: string[] }>;
		keyframes: Record<string, { declaredBy: string[]; referencedBy: string[] }>;
	};
}
```

**Consumer side:** After `rsbuild build`, the CLI scans source files for canonical `@pathscale/ui` usage, including aliases, deep imports, namespace imports, compound JSX such as `Modal.Root`, re-exports, spreads, and dynamic props. It builds usage facts and applies the database conservatively.

## Purge Rules

| Rule | Behavior |
| --- | --- |
| Unused known component | Selectors owned only by that component can be removed. |
| Used component, unused prop variant | Selectors requiring that known unused class can be removed. |
| Runtime data/aria state | Kept when the owning used component selector is kept. |
| Unknown ownership | Kept by default. |
| Theme, reset, app selectors | Kept unless they are fully known unused component selectors. |
| CSS vars and keyframes | Removed only after selector purge proves they are unreferenced. |

The selector walk uses PostCSS. Lightning CSS is used for final minification.

## Installation

```bash
bun add -d @pathscale/rsbuild-plugin-ui-css-purge
```

## Usage

### Consumer Project

Add the postbuild purge after `rsbuild build`:

```json
{
	"scripts": {
		"build": "rsbuild build && bunx rsbuild-plugin-ui-css-purge --dist dist --src src --manifest node_modules/@pathscale/ui/dist/purge-manifest.json"
	}
}
```

Options:

| Flag | Default | Description |
| --- | --- | --- |
| `--manifest` | required | Path to `purge-manifest.json`. |
| `--dist` | `./dist` | Directory containing built CSS files. |
| `--src` | `./src` | Consumer source directory to scan for JSX usage. |

### Lib-Side Manifest Generation

Run from `@pathscale/ui` as a build step:

```json
{
	"scripts": {
		"prebuild": "bunx generate-manifest src/components --out dist/purge-manifest.json"
	}
}
```

This scans all `*.classes.ts` files and colocated component CSS files.

## The `*.classes.ts` Convention

Every component should export a `CLASSES` object that names all component-owned classes. Tailwind utilities are filtered out so the manifest tracks ownership of durable component selectors, not generic utility classes.

```ts
// button.classes.ts
export const CLASSES = {
	base: "button inline-flex items-center",
	variant: {
		primary: "button--primary",
		secondary: "button--secondary",
	},
	size: {
		sm: "button--sm",
		md: "button--md",
	},
	flag: {
		disabled: "button--disabled",
	},
	attrs: {
		open: { "data-open": "true" },
	},
} as const;
```

Compound components use a nested shape:

```ts
export const CLASSES = {
	Root: { base: "modal" },
	Panel: { base: "modal__panel" },
} as const;
```

## Programmatic API

```ts
import {
	buildSafelists,
	purgeCssWithDatabase,
	scanConsumerSource,
} from "@pathscale/rsbuild-plugin-ui-css-purge";

const usages = await scanConsumerSource("/path/to/consumer/src");
const manifest = JSON.parse(await Bun.file("purge-manifest.json").text());
const safelists = buildSafelists(usages, manifest);
const result = purgeCssWithDatabase(css, manifest, safelists);

console.log(result.report);
```

## Development

```bash
bun install
bun run test
bun run build
bun run lint
bun run format
```

## License

MIT
