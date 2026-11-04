import { readFile, writeFile } from "node:fs/promises";

const storePath = new URL("../dist/store.json", import.meta.url);
const generated = JSON.parse(await readFile(storePath, "utf8"));

const store = {
	name: "Dizzoo TidaLuna Plugins",
	description: "Song Downloader Deluxe and Spotify CSV Importer for TidaLuna.",
	author: {
		name: "Dizzoo",
		url: "https://github.com/Dizzoo",
	},
	homepage: "https://github.com/Dizzoo/dizzoo-tidaluna-plugins",
	type: "module",
	plugins: generated.plugins,
};

await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
