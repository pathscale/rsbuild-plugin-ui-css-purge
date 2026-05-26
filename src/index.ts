export {
	cleanUnusedVars,
	cleanUnusedVarsWithReport,
	normalizePurgeDatabase,
	purgeCssWithDatabase,
} from "./postbuild-purge";
export {
	buildSafelists,
	extractJSXUsages,
	extractUIImports,
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
