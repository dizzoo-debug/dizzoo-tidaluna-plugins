import type { SpotifyTrackRow } from "./csv";
import { MIN_TRACK_SCORE, trackScore, type CandidateTrack } from "./matching";

export type MergePlan = {
	/** Rows with no counterpart in the playlist, in CSV order. */
	append: string[];
	/** Existing entries (by playlist index) holding another version of the row's recording. */
	replacements: { index: number; id: string }[];
	/**
	 * Extra entries of a recording a row already has (e.g. the compilation copy next to the original left
	 * by an interrupted replace, or added by hand). Only filled when replacing versions.
	 */
	remove: number[];
	/** Rows whose chosen track, or a kept version of it, is already in the playlist. */
	alreadyPresent: number;
};

const upper = (value?: string | null) => value?.trim().toUpperCase() || undefined;

const sameRecording = (row: SpotifyTrackRow, chosen: CandidateTrack, existing: CandidateTrack) => {
	const isrc = upper(existing.isrc);
	if (isrc && (isrc === upper(row.isrc) || isrc === upper(chosen.isrc))) return true;
	return trackScore(row, existing) >= MIN_TRACK_SCORE;
};

/**
 * Plans re-importing a CSV into a playlist that already holds an earlier import of it. Each existing
 * entry is claimed by at most one row, so intentional duplicates in the CSV are preserved.
 */
export const planMerge = (
	rows: SpotifyTrackRow[],
	chosen: (CandidateTrack | undefined)[],
	existing: CandidateTrack[],
	replaceVersions: boolean,
): MergePlan => {
	const claimed = new Set<number>();
	const pending: number[] = [];
	const represented: number[] = [];
	let alreadyPresent = 0;

	// Exact track first, so a row that is already correct never steals another row's entry.
	rows.forEach((_, rowIndex) => {
		const track = chosen[rowIndex];
		if (track === undefined) return;
		const index = existing.findIndex((entry, entryIndex) => !claimed.has(entryIndex) && String(entry.id) === String(track.id));
		if (index === -1) return pending.push(rowIndex);
		claimed.add(index);
		represented.push(rowIndex);
		alreadyPresent++;
	});

	const append: string[] = [];
	const replacements: MergePlan["replacements"] = [];
	for (const rowIndex of pending) {
		const track = chosen[rowIndex]!;
		const index = existing.findIndex((entry, entryIndex) => !claimed.has(entryIndex) && sameRecording(rows[rowIndex], track, entry));
		if (index === -1) {
			append.push(String(track.id));
			continue;
		}
		claimed.add(index);
		represented.push(rowIndex);
		if (replaceVersions) replacements.push({ index, id: String(track.id) });
		else alreadyPresent++;
	}

	const remove: number[] = [];
	if (replaceVersions) {
		existing.forEach((entry, entryIndex) => {
			if (claimed.has(entryIndex)) return;
			if (represented.some((rowIndex) => sameRecording(rows[rowIndex], chosen[rowIndex]!, entry))) remove.push(entryIndex);
		});
	}
	return { append, replacements, remove, alreadyPresent };
};

/**
 * Where entries end up after inserting a track right after each of `insertedAfter` (processed from the
 * highest index down): every insertion before an entry shifts it by one.
 */
export const shiftedIndexes = (indexes: number[], insertedAfter: number[] = indexes) =>
	indexes.map((index) => index + insertedAfter.filter((other) => other < index).length);
