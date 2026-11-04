import assert from "node:assert/strict";

import type { SpotifyTrackRow } from "./csv";
import type { CandidateTrack } from "./matching";
import { planMerge, shiftedIndexes } from "./merge";

const row = (rowNumber: number, trackName: string, artistNames: string, isrc?: string): SpotifyTrackRow => ({ rowNumber, trackName, artistNames, isrc });
const track = (id: number, title: string, artist: string, isrc?: string): CandidateTrack => ({ id, title, isrc, artists: [{ name: artist }] });

const rows = [
	row(2, "Sex on Fire", "Kings Of Leon", "USRC10800300"),
	row(3, "Lonely Boy", "The Black Keys", "USNO11100313"),
	row(4, "Extreme Ways", "Moby"),
	row(5, "Woman", "Wolfmother"),
];
const chosen = [
	track(100, "Sex on Fire", "Kings Of Leon", "USRC10800300"), // original album version
	track(200, "Lonely Boy", "The Black Keys", "USNO11100313"),
	track(300, "Extreme Ways", "Moby"),
	track(400, "Woman", "Wolfmother"),
];
const existing = [
	track(1, "Sex on Fire", "Kings Of Leon", "USRC10800300"), // from "00s Party Mixtape"
	track(2, "Lonely Boy", "The Black Keys", "USNO11100313"), // from "100 Greatest 10s"
	track(300, "Extreme Ways", "Moby"), // already the right one
	track(999, "Something Else", "Someone"), // added by hand, must stay
];

const plan = planMerge(rows, chosen, existing, true);
assert.deepEqual(plan.replacements, [
	{ index: 0, id: "100" },
	{ index: 1, id: "200" },
]);
assert.deepEqual(plan.append, ["400"]);
assert.equal(plan.alreadyPresent, 1);

// Without replacing, other versions count as present and nothing is duplicated.
const keep = planMerge(rows, chosen, existing, false);
assert.deepEqual(keep.replacements, []);
assert.deepEqual(keep.append, ["400"]);
assert.equal(keep.alreadyPresent, 3);

// Duplicate CSV rows claim separate entries.
const dupes = planMerge([rows[2], rows[2]], [chosen[2], chosen[2]], [existing[2]], true);
assert.deepEqual(dupes.append, ["300"]);
assert.equal(dupes.alreadyPresent, 1);

assert.deepEqual(plan.remove, []);

// An interrupted replace left the compilation copy (0) next to the original (1): the copy is removed,
// the hand-added track (2) stays, and nothing is added again.
const leftover = planMerge([rows[0]], [chosen[0]], [existing[0], chosen[0], existing[3]], true);
assert.deepEqual(leftover, { append: [], replacements: [], remove: [0], alreadyPresent: 1 });
assert.deepEqual(planMerge([rows[0]], [chosen[0]], [existing[0], chosen[0]], false).remove, []);

// Old entries at 0 and 1 (each followed by its replacement) end up at 0 and 2; an entry at 5 moves to 7.
assert.deepEqual(shiftedIndexes([1, 0, 5]), [2, 0, 7]);
// A removed entry at 3, after replacements inserted behind 0 and 1, sits at 5.
assert.deepEqual(shiftedIndexes([3], [1, 0]), [5]);

console.log("Spotify CSV merge tests passed");
