import assert from "node:assert/strict";

import { brainzIsrcMatches, brainzTitleMatches, selectEmbeddedYear, selectTidalTags, type TagValues, type TidalTagSource } from "./tidalTags";

const letItRoll: TidalTagSource["album"] = {
	title: "Let It Roll - Songs Of George Harrison",
	artists: ["George Harrison"],
	releaseDate: "2009-06-16",
	releaseYear: null,
	upc: "00602435008790",
};

// Track 4 matched by album position on the wrong MusicBrainz release, as written to disk on 2026-11-05.
const wrongRecording: TagValues = {
	title: "Brandy (You're a Fine Girl) (Remastered 2009)",
	trackNumber: "4",
	discNumber: "1",
	year: "1972",
	date: "2009-06-16",
	comment: "http://www.tidal.com/track/174391171",
	artist: ["George Harrison"],
	musicbrainz_trackid: "accad857-6d36-410a-8859-3e456a08b1ac",
	musicbrainz_albumid: "00000000-0000-0000-0000-000000000000",
	isrc: "GBAYE0901205",
	album: "Let It Roll - Songs Of George Harrison",
	albumArtist: ["George Harrison"],
	totalTracks: "20",
	lyrics: "My sweet Lord",
};
const mySweetLord: TidalTagSource = {
	title: "My Sweet Lord",
	version: "Remastered 2009",
	trackNumber: 4,
	volumeNumber: 1,
	artists: ["George Harrison"],
	isrc: "GBAYE0901205",
	album: letItRoll,
};

const fixed = selectTidalTags(wrongRecording, mySweetLord);
assert.equal(fixed.title, "My Sweet Lord (Remastered 2009)");
assert.equal(fixed.year, "2009");
assert.equal(fixed.date, "2009-06-16");
assert.equal(fixed.trackNumber, "4");
assert.equal(fixed.musicbrainz_trackid, undefined);
assert.equal(fixed.musicbrainz_albumid, undefined);
// Fields TIDAL does not provide still come from the enriched tags.
assert.equal(fixed.comment, "http://www.tidal.com/track/174391171");
assert.equal(fixed.totalTracks, "20");
assert.equal(fixed.lyrics, "My sweet Lord");
// The caller's object is left alone.
assert.equal(wrongRecording.musicbrainz_trackid, "accad857-6d36-410a-8859-3e456a08b1ac");

// The same track when MusicBrainz found the right recording keeps its ids.
const correct = selectTidalTags(
	{ ...wrongRecording, title: "My Sweet Lord (Remastered 2009)", year: "1970", musicbrainz_trackid: "7571a56b-994e-4829-ae8b-71abb84809be" },
	mySweetLord,
);
assert.equal(correct.title, "My Sweet Lord (Remastered 2009)");
assert.equal(correct.year, "2009");
assert.equal(correct.musicbrainz_trackid, "7571a56b-994e-4829-ae8b-71abb84809be");
assert.equal(correct.musicbrainz_albumid, "00000000-0000-0000-0000-000000000000");

// The file keeps the original-release year of a correct match; a wrong match gets the TIDAL year.
assert.equal(selectEmbeddedYear({ ...wrongRecording, title: "My Sweet Lord (Remastered 2009)", year: "1970" }, correct), "1970");
assert.equal(selectEmbeddedYear(wrongRecording, fixed), "2009");

// Release with another running order: TIDAL track 2 "Golden Cage" got MusicBrainz track 2 "Above You".
const shifted = selectTidalTags(
	{ title: "Above You", trackNumber: "2", year: "2006", musicbrainz_trackid: "6e661aa4-1d12-4e0a-8261-5b483e65ee79" },
	{ title: "Golden Cage", trackNumber: 2, volumeNumber: 1, artists: ["The Whitest Boy Alive"], album: { title: "Dreams", releaseDate: "2006-01-01" } },
);
assert.equal(shifted.title, "Golden Cage");
assert.equal(shifted.trackNumber, "2");
assert.equal(shifted.musicbrainz_trackid, undefined);

// No TIDAL date: a year that came from the wrong recording is not kept either.
const undated = selectTidalTags({ title: "All We Want", year: "1998", date: "1998-03-02", musicbrainz_trackid: "x" }, { title: "Swamp Song" });
assert.equal(undated.title, "Swamp Song");
assert.equal(undated.year, undefined);
assert.equal(undated.date, undefined);
// ...but a matching recording may still supply them.
const undatedMatch = selectTidalTags({ title: "Swamp Song", year: "1999", musicbrainz_trackid: "x" }, { title: "Swamp Song" });
assert.equal(undatedMatch.year, "1999");
assert.equal(undatedMatch.musicbrainz_trackid, "x");

// Spelling differences between TIDAL and MusicBrainz are not a different song.
assert.equal(brainzTitleMatches("Don't Give Up", "Don’t Give Up"), true);
assert.equal(brainzTitleMatches("Rainy Day Women #12 & 35", "Rainy Day Women # 12 & 35"), true);
assert.equal(brainzTitleMatches("Hey Ya!", "Hey Ya! (feat. Someone)"), true);
assert.equal(brainzTitleMatches("Autumn", "Autumn - 2011 Remaster"), true);
assert.equal(brainzTitleMatches("Heart & Mind", "Heart and Mind"), true);
assert.equal(brainzTitleMatches("Go", "Golden Cage"), false);
assert.equal(brainzTitleMatches(undefined, "Golden Cage"), false);

// A live, demo or remix recording is not the studio song, so it gets neither its year nor its ids.
assert.equal(brainzTitleMatches("In Bloom", "In Bloom (Live)"), false);
assert.equal(brainzTitleMatches("Radio", "Radio (MTV Unplugged Version)"), false);
assert.equal(brainzTitleMatches("Zombie (Acoustic)", "Zombie (Acoustic Version)"), true);
assert.equal(brainzTitleMatches("All My Life", "All My Life (album version)"), true);
assert.equal(selectEmbeddedYear({ title: "In Bloom", year: "1991" }, { title: "In Bloom (Live)", year: "2021" }), "2021");

// With the recording's ISRCs known, only an ISRC match keeps MusicBrainz ids and the original year.
const rightRecording = { ...wrongRecording, title: "My Sweet Lord (Remastered 2009)", year: "1970", musicbrainz_trackid: "7571a56b-994e-4829-ae8b-71abb84809be" };
const byIsrc = selectTidalTags(rightRecording, { ...mySweetLord, brainzIsrcs: ["gbaye0901205", "GBAYE0100001"] });
assert.equal(byIsrc.musicbrainz_trackid, "7571a56b-994e-4829-ae8b-71abb84809be");
assert.equal(selectEmbeddedYear(rightRecording, byIsrc, { isrc: "GBAYE0901205", brainzIsrcs: ["GBAYE0901205"] }), "1970");
// Same title, but an album-position guess whose recording lists other ISRCs: dropped.
const positionGuess = selectTidalTags(rightRecording, { ...mySweetLord, brainzIsrcs: ["USAT20000001"] });
assert.equal(positionGuess.musicbrainz_trackid, undefined);
assert.equal(positionGuess.musicbrainz_albumid, undefined);
assert.equal(selectEmbeddedYear(rightRecording, positionGuess, { isrc: "GBAYE0901205", brainzIsrcs: ["USAT20000001"] }), "2009");
// A recording without ISRCs, or no MusicBrainz match at all, is not trusted either.
assert.equal(selectTidalTags(rightRecording, { ...mySweetLord, brainzIsrcs: [] }).musicbrainz_trackid, undefined);
assert.equal(selectEmbeddedYear(rightRecording, byIsrc, { isrc: "GBAYE0901205", brainzIsrcs: null }), "2009");
// No TIDAL ISRC means nothing to match.
assert.equal(brainzIsrcMatches(["GBAYE0901205"], undefined), false);
assert.equal(brainzIsrcMatches(["GBAYE0901205"], " gbaye0901205 "), true);

console.log("tidalTags tests passed");
