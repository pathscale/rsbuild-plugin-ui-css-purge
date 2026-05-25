export {
	cleanUnusedVars,
	cleanUnusedVarsWithReport,
	normalizePurgeDatabase,
	purgeCssWithDatabase,
} from "./postbuild-purge";
export {
	extractUIImports,
	extractJSXUsages,
	buildSafelists,
	scanConsumerSource,
} from "./scan-consumer";
export type {
	ComponentManifest,
	ComponentPurgeRecord,
	PropUsage,
	PurgeDatabaseV2,
	PurgeManifest,
	Safelists,
} from "./scan-consumer";
