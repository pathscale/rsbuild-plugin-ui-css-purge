await Bun.build({
	entrypoints: ["src/index.ts", "src/postbuild-purge.ts"],
	outdir: "dist",
	target: "bun",
	format: "esm",
	external: ["postcss", "@swc/core"],
	sourcemap: "inline",
});

// Generate type declarations
const proc = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly"], {
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await proc.exited;
if (exitCode !== 0) {
	console.error("tsc declaration generation failed");
	process.exit(exitCode);
}

console.log(
	"Build complete: dist/index.js + dist/postbuild-purge.js + type declarations",
);

export {};
