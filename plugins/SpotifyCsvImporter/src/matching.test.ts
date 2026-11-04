import assert from "node:assert/strict";

import type { SpotifyTrackRow } from "./csv";
import { findDirectAlbumMatch, pickBestCandidate, type Candidate } from "./matching";

const source: SpotifyTrackRow = {
	rowNumber: 2,
	isrc: "GBBKS0700580",
	trackName: "Hometown Glory",
	artistNames: "Adele",
	albumName: "19",
	durationMs: 271000,
	releaseDate: "2008-01-28",
};

const version = (id: number, album: Candidate["album"], fromIsrc = true): Candidate => ({
	track: { id, title: "Hometown Glory", duration: 271, isrc: source.isrc, artists: [{ name: "Adele" }], album: { id: id * 10, title: album?.title } },
	album,
	fromIsrc,
});

const compilation = version(1, { title: "Now That's What I Call Music! 69", type: "COMPILATION", releaseDate: "2008-03-24", artist: { name: "Various Artists" } });
const variousAsAlbum = version(2, { title: "Chill Out Classics", type: "ALBUM", releaseDate: "2009-05-01", artist: { name: "Various Artists" } });
const original = version(3, { title: "19", type: "ALBUM", releaseDate: "2008-01-28", artist: { name: "Adele" } });
const deluxe = version(4, { title: "19 (Deluxe Edition)", type: "ALBUM", releaseDate: "2008-11-17", artist: { name: "Adele" } });

assert.equal(pickBestCandidate(source, [compilation, variousAsAlbum, deluxe, original])?.track.id, 3);
// Without the original, the artist's own deluxe edition beats compilations.
assert.equal(pickBestCandidate(source, [compilation, variousAsAlbum, deluxe])?.track.id, 4);

// A Spotify row that itself comes from a best-of keeps the best-of.
const bestOfSource = { ...source, albumName: "Greatest Hits", releaseDate: undefined };
const bestOf = version(5, { title: "Greatest Hits", type: "ALBUM", releaseDate: "2020-01-01", artist: { name: "Adele" } });
assert.equal(pickBestCandidate(bestOfSource, [original, bestOf])?.track.id, 5);

// Without album info, the earliest release wins a tie.
const noSpotifyAlbum = { ...source, albumName: undefined, releaseDate: undefined };
const late = version(6, { title: "Hometown Glory", type: "SINGLE", releaseDate: "2012-01-01", artist: { name: "Adele" } });
const early = version(7, { title: "Hometown Glory", type: "SINGLE", releaseDate: "2007-10-22", artist: { name: "Adele" } });
assert.equal(pickBestCandidate(noSpotifyAlbum, [late, early])?.track.id, 7);

// Text-search candidates still need a real title/artist match.
const wrongSong: Candidate = {
	track: { id: 8, title: "Someone Like You", duration: 285, artists: [{ name: "Adele" }], album: { id: 80, title: "19" } },
	album: { title: "19", type: "ALBUM", artist: { name: "Adele" } },
	fromIsrc: false,
};
assert.equal(pickBestCandidate({ ...source, isrc: undefined }, [wrongSong]), undefined);

// Disabling the preference falls back to pure track matching.
assert.ok(pickBestCandidate(source, [compilation], false));

// Starred.csv row 35: Spotify lists the single; TIDAL search returned an Italian compilation and Lungs.
const love: SpotifyTrackRow = {
	rowNumber: 35,
	isrc: "GBUM70900237",
	trackName: "You've Got The Love",
	artistNames: "Florence + The Machine",
	albumName: "You've Got The Love",
	durationMs: 168666,
	releaseDate: "2010-01-01",
};
const loveTrack = (id: number, album: Candidate["album"]): Candidate => ({
	track: { id, title: "You've Got The Love", duration: 169, isrc: love.isrc, artists: [{ name: "Florence + the Machine" }], album: { id, title: album?.title } },
	album,
	fromIsrc: true,
});
const grandiSuccessi = loveTrack(10, { title: "OO's Music Grandi Successi", type: "COMPILATION", releaseDate: "2010-06-01", artist: { name: "Various Artists" } });
const lungs = loveTrack(11, { title: "Lungs (International Version)", type: "ALBUM", releaseDate: "2009-07-03", artist: { name: "Florence + the Machine" } });
assert.equal(pickBestCandidate(love, [grandiSuccessi, lungs])?.track.id, 11);
// Even without TIDAL's album type, the title alone marks the compilation.
assert.equal(pickBestCandidate(love, [{ ...grandiSuccessi, album: { title: "OO's Music Grandi Successi" } }, lungs])?.track.id, 11);

// Singles are only a fallback: the artist's album wins even though Spotify listed the single...
const loveSingle = loveTrack(12, { title: "You've Got The Love", type: "SINGLE", releaseDate: "2010-01-01", artist: { name: "Florence + the Machine" } });
assert.equal(pickBestCandidate(love, [loveSingle, lungs, grandiSuccessi])?.track.id, 11);
// ...also when TIDAL gives no album type and the single is recognised by its name.
assert.equal(pickBestCandidate(love, [{ ...loveSingle, album: { title: "You've Got The Love" } }, lungs])?.track.id, 11);
// ...but with no album available, the single still beats a compilation.
assert.equal(pickBestCandidate(love, [grandiSuccessi, loveSingle])?.track.id, 12);

// Cheap path: the album title TIDAL embeds in a search result is enough when Spotify names a real album.
const searchHit = (id: number, albumTitle: string): Candidate => ({
	track: { id, title: "Hometown Glory", duration: 271, artists: [{ name: "Adele" }], album: { id: id * 10, title: albumTitle } },
	fromIsrc: false,
});
assert.equal(findDirectAlbumMatch(source, [searchHit(20, "Now 69"), searchHit(21, "19")])?.track.id, 21);
assert.equal(findDirectAlbumMatch(source, [searchHit(20, "Now 69")]), undefined);
// Not for singles or compilations named by Spotify: those still need the full lookup.
assert.equal(findDirectAlbumMatch(love, [loveTrack(13, undefined)]), undefined);
assert.equal(findDirectAlbumMatch({ ...source, albumName: "Greatest Hits" }, [searchHit(22, "Greatest Hits")]), undefined);

console.log("Spotify CSV matching tests passed");
