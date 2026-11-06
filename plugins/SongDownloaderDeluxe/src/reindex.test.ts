import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFlacTidalId, reindexLibrary, tidalIdFromVorbisComment } from "./reindex.native";

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
	const result = await reindexLibrary(root);
	assert.equal(result.entries["42"], kept);
	assert.equal(result.scanned, 5);
	assert.equal(result.withoutId, 3);
	assert.deepEqual(result.sameAudioAsIdentified.map((d) => d.id), ["43"]);
	assert.equal(result.unidentified.length, 2);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("reindex tests passed");
})();
