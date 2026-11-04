import { readFile, writeFile } from "node:fs/promises";

const storePath = new URL("../dist/store.json", import.meta.url);
const generated = JSON.parse(await readFile(storePath, "utf8"));

const store = {
	name: "Dizzoo TidaLuna Plugins",
	description: "Song Downloader Deluxe and Spotify CSV Importer for TidaLuna.",
	author: {
		name: "Dizzoo",
		url: "https://github.com/dizzoo-debug",
	},
	homepage: "https://github.com/dizzoo-debug/dizzoo-tidaluna-plugins",
	type: "module",
	plugins: generated.plugins,
};

await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

// Show the build hash on each plugin card so the installed version is visible in the Plugin Store.
for (const plugin of generated.plugins) {
	const metadataPath = new URL(`../dist/${plugin.replace(/\.mjs$/, ".json")}`, import.meta.url);
	const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
	const description = (metadata.description ?? "").replace(/\s*Build hash: \S+$/, "");
	metadata.description = `${description} Build hash: ${metadata.hash}`.trim();
	await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
	console.log(`${metadata.name}: ${metadata.hash}`);
}
