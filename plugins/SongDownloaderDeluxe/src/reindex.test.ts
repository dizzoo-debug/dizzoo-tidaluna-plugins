import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeUnidentified, readFlacTidalId, reindexLibrary, tidalIdFromVorbisComment } from "./reindex.native";

// A file without tags and without the artist in its name: title from the name, artist from the folder.
const bare = describeUnidentified("D:/M/The Chemical Brothers/The Chemical Brothers - Surrender (1999)/02 - Under The Influence.flac", { tags: {} });
assert.equal(bare.title, "Under The Influence");
assert.equal(bare.artist, "The Chemical Brothers");
assert.equal(bare.album, "Surrender");
assert.equal(describeUnidentified("D:/M/A/A - B (2000)/01 - Michael Stearns - Finale.flac", { tags: {} }).artist, "Michael Stearns");

const vorbisComment = (entries: string[]) => {
	const parts = [Buffer.from([4, 0, 0, 0]), Buffer.from("test")];
	const count = Buffer.alloc(4);
	count.writeUInt32LE(entries.length);
	parts.push(count);
	for (const entry of entries) {
		const text = Buffer.from(entry, "utf8");
		const length = Buffer.alloc(4);
		length.writeUInt32LE(text.length);
		parts.push(length, text);
	}
	return Buffer.concat(parts);
};
const blockHeader = (type: number, length: number, last: boolean) =>
	Buffer.from([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
// STREAMINFO, a picture block that must be skipped, then the Vorbis comment.
const flac = (entries: string[], audioMd5 = 0) => {
	const comment = vorbisComment(entries);
	const streamInfo = Buffer.alloc(34);
	streamInfo.fill(audioMd5, 18);
	return Buffer.concat([
		Buffer.from("fLaC", "latin1"),
		blockHeader(0, 34, false),
		streamInfo,
		blockHeader(6, 500, false),
		Buffer.alloc(500, 7),
		blockHeader(4, comment.length, true),
		comment,
		Buffer.alloc(64),
	]);
};

assert.equal(tidalIdFromVorbisComment(vorbisComment(["TITLE=X", "COMMENT=http://www.tidal.com/track/174391171"])), "174391171");
assert.equal(tidalIdFromVorbisComment(vorbisComment(["comment=https://tidal.com/browse/track/119476574"])), "119476574");
assert.equal(tidalIdFromVorbisComment(vorbisComment(["COMMENT=bought on CD"])), undefined);

(async () => {
const root = await mkdtemp(join(tmpdir(), "reindex-"));
try {
	await mkdir(join(root, "Artist", "Artist - Album (2020)"), { recursive: true });
	await mkdir(join(root, "_SongDownloader_Quarantine", "Artist"), { recursive: true });
	const kept = join(root, "Artist", "Artist - Album (2020)", "01 - Artist - Song.flac");
	await writeFile(kept, flac(["COMMENT=http://www.tidal.com/track/42"]));
	await writeFile(join(root, "_SongDownloader_Quarantine", "Artist", "01 - Artist - Song.flac"), flac(["COMMENT=http://www.tidal.com/track/42"]));
	await writeFile(join(root, "Artist", "Artist - Album (2020)", "02 - no id.flac"), flac(["TITLE=Y"]));
	// Same audio as a file that has an id, in another folder: a duplicate, not something to look up.
	await mkdir(join(root, "Artist", "Album (2020)"), { recursive: true });
	await writeFile(join(root, "Artist", "Artist - Album (2020)", "03 - Artist - Twin.flac"), flac(["COMMENT=http://www.tidal.com/track/43"], 9));
	await writeFile(join(root, "Artist", "Album (2020)", "03 - Artist - Twin.flac"), flac(["TITLE=Twin"], 9));
	await writeFile(join(root, "Artist", "Artist - Album (2020)", "cover.jpg"), "x");
	await writeFile(join(root, "Artist", "broken.flac"), "not a flac");

	assert.equal(await readFlacTidalId(kept), "42");
	// An ID3v2 tag in front of the FLAC stream (10-byte header, 5-byte body) is skipped.
	const withId3 = join(root, "id3.flac");
	await writeFile(withId3, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5]), Buffer.alloc(5), flac(["COMMENT=http://www.tidal.com/track/77"])]));
	assert.equal(await readFlacTidalId(withId3), "77");
	await rm(withId3);
	const result = await reindexLibrary(root);
	assert.equal(result.entries["42"], kept);
	assert.equal(result.scanned, 5);
	assert.equal(result.withoutId, 3);
	assert.deepEqual(result.sameAudioAsIdentified.map((d) => d.id), ["43"]);
	assert.equal(result.unidentified.length, 2);
	// A quarantine folder chosen in settings, inside the library under another name, is skipped too.
	await mkdir(join(root, "Holding", "Artist"), { recursive: true });
	await writeFile(join(root, "Holding", "Artist", "01 - Artist - Gone.flac"), flac(["COMMENT=http://www.tidal.com/track/88"]));
	assert.equal((await reindexLibrary(root)).entries["88"] !== undefined, true);
	assert.equal((await reindexLibrary(root, join(root, "holding"))).entries["88"], undefined);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("reindex tests passed");
})();
