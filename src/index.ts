export {
	cleanUnusedVars,
	cleanUnusedVarsWithReport,
	normalizePurgeDatabase,
	purgeCssWithDatabase,
} from "./postbuild-purge";
export type {
	ComponentManifest,
	ComponentPurgeRecord,
	PropUsage,
	PurgeDatabaseV2,
	PurgeManifest,
	Safelists,
} from "./scan-consumer";
export {
	buildSafelists,
	extractJSXUsages,
	extractUIImports,
	scanConsumerSource,
} from "./scan-consumer";
