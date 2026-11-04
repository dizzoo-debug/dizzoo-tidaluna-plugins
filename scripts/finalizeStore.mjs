import { readFile, rename, writeFile } from "node:fs/promises";

const storePath = new URL("../dist/store.json", import.meta.url);
const generated = JSON.parse(await readFile(storePath, "utf8"));

// Show the build hash on each plugin card so the installed version is visible in the Plugin Store.
for (const plugin of generated.plugins) {
	const metadataPath = new URL(`../dist/${plugin.replace(/\.mjs$/, ".json")}`, import.meta.url);
	const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
	const description = (metadata.description ?? "").replace(/\s*Build hash: \S+$/, "");
	metadata.description = `${description} Build hash: ${metadata.hash}`.trim();
	await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
	console.log(`${metadata.name}: ${metadata.hash}`);
}

// GitHub release assets turn every space into a dot, but Luna's store only replaces the first space
// when building plugin URLs, so "Song Downloader Deluxe" would be requested as "Song.Downloader Deluxe"
// and 404. For releases, name the files and store entries with dots up front. Local builds keep the
// spaces: the DEV store (127.0.0.1:3000) uses names verbatim and installed DEV plugins point at them.
let plugins = generated.plugins;
if (process.env.GITHUB_ACTIONS === "true") {
	plugins = [];
	for (const plugin of generated.plugins) {
		const base = plugin.replace(/\.mjs$/, "");
		const dotted = base.replaceAll(" ", ".");
		if (dotted !== base) {
			for (const extension of [".mjs", ".mjs.map", ".json"]) {
				await rename(new URL(`../dist/${base}${extension}`, import.meta.url), new URL(`../dist/${dotted}${extension}`, import.meta.url));
			}
		}
		plugins.push(`${dotted}.mjs`);
	}
}

const store = {
	name: "Dizzoo TidaLuna Plugins",
	description: "Song Downloader Deluxe and Spotify CSV Importer for TidaLuna.",
	author: {
		name: "Dizzoo",
		url: "https://github.com/dizzoo-debug",
	},
	homepage: "https://github.com/dizzoo-debug/dizzoo-tidaluna-plugins",
	type: "module",
	plugins,
};

await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
