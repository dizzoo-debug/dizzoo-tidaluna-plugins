import assert from "node:assert/strict";

import { checkTidalMatch, cleanTags, identifyOnTidal, pickTidalMatch, type TrackCandidate } from "./identify";

const wings: TrackCandidate[] = [
	{ id: 1, title: "Wings", duration: 252, artists: [{ name: "Birdy" }], album: { title: "Fire Within (Deluxe)" } },
	{ id: 2, title: "Wings", duration: 252, artists: [{ name: "Birdy" }], album: { title: "Wings" } },
	{ id: 3, title: "Wings", duration: 199, artists: [{ name: "Little Mix" }], album: { title: "DNA" } },
];
const file = { path: "Birdy/Birdy - Wings (2013)/01 - Birdy - Wings.flac", title: "Wings", artist: "Birdy", album: "Wings", durationSeconds: 251.6 };

// Same album wins over the deluxe album; another artist never matches.
assert.equal(pickTidalMatch(file, wings)?.id, 2);
// Duration more than 3 s off is a different recording.
assert.equal(pickTidalMatch({ ...file, durationSeconds: 300 }, wings), undefined);
// Album not given: the title and artist decide.
assert.equal(pickTidalMatch({ ...file, album: undefined }, wings.slice(0, 1))?.id, 1);
// A version in TIDAL's separate field still matches the file title that carries it.
assert.equal(
	pickTidalMatch(
		{ path: "x", title: "Zombie (Acoustic Version)", artist: "The Cranberries", album: "Something Else" },
		[{ id: 9, title: "Zombie", version: "Acoustic Version", artists: [{ name: "The Cranberries" }], album: { title: "Something Else" } }],
	)?.id,
	9,
);
// Different album is not guessed, and the reason says so.
assert.equal(pickTidalMatch({ ...file, album: "Some Compilation" }, wings.slice(1, 2)), undefined);
assert.match(checkTidalMatch({ ...file, album: "Some Compilation" }, wings.slice(1, 2)).reason ?? "", /other album: Wings/);
// A wide check accepts the same recording from another album, only within 1 s.
assert.deepEqual(checkTidalMatch({ ...file, album: "Some Compilation" }, wings.slice(1, 2), true), { match: wings[1], fromOtherAlbum: true });
assert.equal(checkTidalMatch({ ...file, album: "Some Compilation", durationSeconds: 254 }, wings.slice(1, 2), true).match, undefined);
assert.equal(checkTidalMatch({ ...file, album: "Some Compilation", durationSeconds: undefined }, wings.slice(1, 2), true).match, undefined);

(async () => {
	let calls = 0;
	const result = await identifyOnTidal([file, { ...file, path: "second" }], async () => {
		calls++;
		throw new Error("TidalApi 429 Too Many Requests");
	});
	// The first 429 stops the run: no second request.
	assert.equal(calls, 1);
	assert.equal(result.stoppedByRateLimit, true);
	assert.equal(result.notFound.length, 2);

	// No match on the first page: a second search that names the album finds the compilation track.
	const queries: string[] = [];
	const compilationTrack = { id: 7, title: "Wings", duration: 252, artists: [{ name: "Birdy" }], album: { title: "Wings" } };
	const second = await identifyOnTidal([file], async (query) => {
		queries.push(query);
		return queries.length === 1 ? wings.slice(0, 1) : [compilationTrack];
	});
	assert.deepEqual(queries, ["Birdy Wings", "Birdy Wings Wings"]);
	assert.equal(second.found[0]?.id, "7");

	// "Artist - Title" in both tags is split; the wide search drops a misspelt artist and matches on album and length.
	const baraka = { path: "b", title: "Michael Streans - Village Dance", artist: "Michael Streans - Village Dance", album: "Baraka", durationSeconds: 179 };
	assert.deepEqual(cleanTags(baraka), { ...baraka, artist: "Michael Streans", title: "Village Dance" });
	const village = { id: 11, title: "Village Dance", duration: 180, artists: [{ name: "Michael Stearns" }], album: { title: "Baraka (Original Motion Picture Soundtrack)" } };
	const wideQueries: string[] = [];
	const search = async (query: string) => (wideQueries.push(query), wideQueries.length === 3 ? [village] : []);
	assert.equal((await identifyOnTidal([baraka], search)).found.length, 0);
	wideQueries.length = 0;
	const wide = await identifyOnTidal([baraka], search, undefined, { broad: true });
	assert.deepEqual(wideQueries, ["Michael Streans Village Dance", "Michael Streans Village Dance Baraka", "Village Dance Baraka"]);
	assert.equal(wide.found[0]?.id, "11");
	// Not on the same album, a different artist still never matches.
	assert.equal(checkTidalMatch({ ...cleanTags(baraka), album: "Other" }, [village], true).match, undefined);
	console.log("identify tests passed");
})();
