#!/usr/bin/env node
/**
 * Bundle the extension and the CLI into dist/, which is what npm publishes.
 *
 * The published bin cannot be TypeScript. Node refuses to strip types for files under
 * node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and `pi install npm:...`
 * places packages there, so a .ts bin would be dead on arrival for every npm user. Pi
 * loads the extension through jiti and could cope with TypeScript, but shipping one form
 * for both entry points keeps them consistent and the packaging obvious.
 *
 * Bundling also makes `import.meta.url` resolve to dist/, so the packaged runtime finds its
 * own skills next to itself rather than needing a build-time path substitution.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
	entryPoints: [join(root, "index.ts"), join(root, "subagent.ts")],
	outdir,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// Pi supplies these when it loads the extension; bundling them would ship an 8 MB copy
	// of the host and risk two copies of its state.
	external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
	// Keeps the stack traces pointing at the original TypeScript.
	sourcesContent: true,
	logLevel: "warning",
});

// The runtime resolves skills relative to its own module, so the tree has to travel with it.
cpSync(join(root, "skills"), join(outdir, "skills"), { recursive: true });

// npm sets the exec bit on bin targets at install time, but the repository copy is also run
// directly during development.
chmodSync(join(outdir, "subagent.js"), 0o755);

const expected = ["index.js", "subagent.js", join("skills", "subagent", "SKILL.md")];
const missing = expected.filter((entry) => !existsSync(join(outdir, entry)));
if (missing.length > 0) {
	console.error(`build: missing output: ${missing.join(", ")}`);
	process.exit(1);
}
console.log(`built ${expected.length} entries into dist/`);
