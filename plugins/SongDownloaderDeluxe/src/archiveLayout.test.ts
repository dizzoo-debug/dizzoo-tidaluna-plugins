import assert from "node:assert/strict";

import {
	addEditionVariant,
	formatVariantSuffix,
	isSoundtrackRelease,
	isVariousArtists,
	normalizeEdition,
	sanitizeLibraryComponent,
} from "./archiveLayout";

assert.deepEqual(normalizeEdition("Nevermind (Super Deluxe Edition)", null), {
	archiveTitle: "Nevermind",
	variants: ["Super Deluxe"],
});
assert.deepEqual(normalizeEdition("Album - 2011 Remaster", null), {
	archiveTitle: "Album",
	variants: ["Remastered"],
});
assert.equal(formatVariantSuffix(["Deluxe", "Deluxe"]), " [Deluxe]");
assert.equal(addEditionVariant(" [Deluxe]", "Atmos"), " [Deluxe] [Atmos]");
assert.equal(isSoundtrackRelease("Music from the Motion Picture", null, null), true);
assert.equal(isSoundtrackRelease("Ordinary Album", null, "Soundtrack"), true);
assert.equal(isVariousArtists(["Various Artists"]), true);
assert.equal(isVariousArtists(["Artist One", "Artist Two"]), false);
assert.equal(sanitizeLibraryComponent('AC/DC: Live?'), "AC -DC - Live");

console.log("archiveLayout tests passed");
