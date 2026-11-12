import assert from "node:assert/strict";

import {
	addEditionVariant,
	addFolderVariants,
	formatTitleDates,
	technicalVariants,
	formatVariantSuffix,
	isSoundtrackRelease,
	isVariousArtists,
	libraryRootFor,
	normalizeEdition,
	sanitizeLibraryComponent,
} from "./archiveLayout";

const title = (value: string, version?: string | null, genre?: string | null) => normalizeEdition(value, version, genre).archiveTitle;

// Editions stay in the title, in parentheses, with one wording.
assert.equal(title("Frank (Deluxe Edition)"), "Frank (Deluxe Edition)");
assert.equal(title("Frank (Deluxe Version)"), "Frank (Deluxe Edition)");
assert.equal(title("Frank", "Deluxe"), "Frank (Deluxe Edition)");
assert.equal(title("Nevermind (Super Deluxe Edition)"), "Nevermind (Super Deluxe Edition)");
assert.equal(title("Album - 2011 Remaster"), "Album (2011 Remaster)");
assert.equal(title("Abbey Road (Remastered 2009)"), "Abbey Road (Remastered 2009)");
assert.equal(title("Ziggy Stardust (2012 Remaster)"), "Ziggy Stardust (2012 Remaster)");
assert.equal(title("Presence (Remaster)"), "Presence (Remastered)");
assert.equal(title("Album [Deluxe Edition] (Remastered)"), "Album (Deluxe Edition) (Remastered)");
assert.equal(title("The Remasters"), "The Remasters");
assert.equal(title("The Age of Reason (10th Anniversary Deluxe Edition)"), "The Age of Reason (10th Anniversary Deluxe Edition)");
assert.equal(title("Odelay (20th Anniversary Super Deluxe Edition)"), "Odelay (20th Anniversary Super Deluxe Edition)");
assert.equal(title("Lazarus (Adult Swim Original Series Soundtrack)"), "Lazarus [Soundtrack]");
// Soundtracks: "[Soundtrack]" before the year, the long wording dropped.
assert.equal(title("Baraka", null, "Soundtrack"), "Baraka [Soundtrack]");
assert.equal(title("Baraka (Original Motion Picture Soundtrack)"), "Baraka [Soundtrack]");
assert.equal(title("Interstellar: Original Motion Picture Soundtrack"), "Interstellar [Soundtrack]");
assert.equal(title("Pulp Fiction (Music From The Motion Picture)"), "Pulp Fiction [Soundtrack]");
assert.equal(title("Soundtrack"), "Soundtrack [Soundtrack]");
// Long dashes and dates.
assert.equal(title("Stars: The Best of 1992–2002"), "Stars: The Best of 1992-2002");
// Only slash dates change; the other forms are valid in file names and stay as they are.
assert.equal(formatTitleDates("Live 16/03/1961"), "Live 16.03.1961");
assert.equal(formatTitleDates("Live 7/16/1977"), "Live 7.16.1977");
assert.equal(title("Live 16/03/1961"), "Live 16.03.1961");
assert.equal(formatTitleDates("Live 1961-03-16"), "Live 1961-03-16");
assert.equal(formatTitleDates("Live 16-03-1961"), "Live 16-03-1961");
assert.equal(formatTitleDates("Live at Carnegie Hall, March 16, 1961"), "Live at Carnegie Hall, March 16, 1961");
assert.equal(formatTitleDates("AC/DC"), "AC/DC");
// Technical markers after the year, in one order.
assert.deepEqual(technicalVariants({ atmos: false, lossy: false, bitDepth: 24, realMax: true }), ["Hi-Res", "RealMAX"]);
assert.deepEqual(technicalVariants({ atmos: false, lossy: false, bitDepth: 16, realMax: false }), []);
assert.deepEqual(technicalVariants({ atmos: false, lossy: true, bitDepth: 16, realMax: false }), ["AAC"]);
assert.deepEqual(technicalVariants({ atmos: true, lossy: true, bitDepth: 24, realMax: false }), ["Atmos"]);
assert.equal(formatVariantSuffix(["RealMAX", "Hi-Res"]), " [Hi-Res] [RealMAX]");
assert.equal(addFolderVariants("A/A - X (2003) [Hi-Res]/01 - t.flac", ["Hi-Res", "RealMAX"]), "A/A - X (2003) [Hi-Res] [RealMAX]/01 - t.flac");
assert.equal(addFolderVariants("A/A - X (2003)/CD1/01 - t.flac", ["AAC"], true), "A/A - X (2003) [AAC]/CD1/01 - t.flac");

assert.equal(formatVariantSuffix([]), "");
const root = { soundtrack: false, variousArtists: false, albumArtist: "Aretha Franklin" };
assert.equal(libraryRootFor(root), "Aretha Franklin");
// One artist's own collections stay in the artist's folder; only Various Artists go to !Compilations.
assert.equal(libraryRootFor({ ...root, variousArtists: true }), "!Compilations/Various Artists");
assert.equal(libraryRootFor({ ...root, otherCompilation: true }), "!Compilations");
assert.equal(libraryRootFor({ ...root, variousArtists: true, otherCompilation: true }), "!Compilations/Various Artists");
assert.equal(libraryRootFor({ ...root, variousArtists: true, soundtrack: true }), "!OST");
assert.equal(formatVariantSuffix(["Atmos", "Atmos"]), " [Atmos]");
assert.equal(addEditionVariant("", "Atmos"), " [Atmos]");
assert.equal(addEditionVariant(" [Atmos]", "Atmos"), " [Atmos]");
assert.equal(isSoundtrackRelease("Music from the Motion Picture", null, null), true);
assert.equal(isSoundtrackRelease("Ordinary Album", null, "Soundtrack"), true);
assert.equal(isVariousArtists(["Various Artists"]), true);
assert.equal(isVariousArtists(["Artist One", "Artist Two"]), false);
assert.equal(sanitizeLibraryComponent("AC/DC: Live?"), "AC -DC - Live");
assert.equal(sanitizeLibraryComponent("1992–2002 — Best"), "1992-2002 - Best");

console.log("archiveLayout tests passed");
