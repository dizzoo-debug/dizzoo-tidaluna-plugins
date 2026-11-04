import assert from "node:assert/strict";

import { makeUnmatchedCsv, makeUnmatchedText, parseSpotifyCsv } from "./csv";

const sample = `\uFEFFTrack URI,ISRC,Track Name,Album Name,Artist Name(s),Duration (ms)\r\nspotify:track:1,AA111,"Song, One",Album,"Artist ""A""",123000\r\nspotify:track:2,,Second Song,Second Album,Second Artist,\r\n`;
const rows = parseSpotifyCsv(sample);
assert.equal(rows.length, 2);
assert.deepEqual(rows[0], {
	rowNumber: 2,
	isrc: "AA111",
	trackName: "Song, One",
	artistNames: 'Artist "A"',
	albumName: "Album",
	durationMs: 123000,
});
assert.equal(rows[1].durationMs, undefined);
const report = makeUnmatchedText([{ track: rows[0], reason: "Not found" }]);
assert.match(report, /Tracks not matched in TIDAL: 1/);
assert.match(report, /Artist "A" — Song, One/);
assert.match(report, /Reason: Not found/);
assert.match(makeUnmatchedCsv([{ track: rows[0], reason: "Not found" }]), /"Song, One"/);
const retryRows = parseSpotifyCsv(makeUnmatchedCsv([{ track: { ...rows[0], rowNumber: 42 }, reason: "Not found" }]));
assert.equal(retryRows[0].rowNumber, 42);

const localRows = parseSpotifyCsv(
	`Track URI,ISRC,Track Name,Album Name,Artist Name(s),Duration (ms)\nspotify:local:::Maxwell+-+Lifetime+%28Lazy+Dog+mix%29:552,,Maxwell - Lifetime (Lazy Dog mix),,,552000\nspotify:local::Ausrine:02+Su%C5%BEeistas+V%C4%97jas:226,,02 Sužeistas Vėjas,Ausrine,,226000\n`,
);
assert.equal(localRows[0].artistNames, "Maxwell");
assert.equal(localRows[0].trackName, "Lifetime (Lazy Dog mix)");
assert.equal(localRows[1].artistNames, "Ausrine");
assert.equal(localRows[1].trackName, "02 Sužeistas Vėjas");

console.log("Spotify CSV parser tests passed");
