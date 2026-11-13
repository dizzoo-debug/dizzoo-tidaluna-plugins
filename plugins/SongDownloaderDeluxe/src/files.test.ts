import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { audioFileExists, fileExists, quarantineFolderFor, quarantineTrack, saveCoverArt } from "./files.native";

const main = async () => {
	const testRoot = await mkdtemp(join(tmpdir(), "song-downloader-custom-"));
	try {
		const audioPath = [testRoot, "Artist", "Album (2026)", "01 - Track.flac"];
		const resolvedAudioPath = join(...audioPath);
		await mkdir(dirname(resolvedAudioPath), { recursive: true });
		await writeFile(resolvedAudioPath, "audio-placeholder");

		assert.equal(await fileExists(audioPath), true);
		assert.equal(await audioFileExists(audioPath), true);
		assert.equal(await fileExists(join(testRoot, "missing.flac")), false);
		const emptyAudioPath = join(testRoot, "empty.flac");
		await writeFile(emptyAudioPath, "");
		assert.equal(await fileExists(emptyAudioPath), true);
		assert.equal(await audioFileExists(emptyAudioPath), false);

		const coverName = "Artist - Album (2026).jpg";
		const onePixelJpeg = "data:image/jpeg;base64,/9j/2Q==";
		assert.equal(await saveCoverArt(audioPath, coverName, onePixelJpeg), true);
		assert.equal(await saveCoverArt(audioPath, coverName, onePixelJpeg), false);
		assert.deepEqual(await readFile(join(dirname(resolvedAudioPath), coverName)), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

		// Unfavorited tracks: cover and credits stay while the album has audio; the last track takes everything along.
		const quarantine = join(testRoot, "Q");
		assert.equal(quarantineFolderFor(testRoot), join(testRoot, "_SongDownloader_Quarantine"));
		assert.equal(quarantineFolderFor(testRoot, quarantine), quarantine);
		const album = join(testRoot, "Band", "Band - Record (2020)");
		await mkdir(join(album, "CD1"), { recursive: true });
		await mkdir(join(album, "CD2"), { recursive: true });
		for (const file of ["CD1/01 - a.flac", "CD2/01 - b.flac", "CD1/cover.jpg", "CD2/cover.jpg", "CD1/x - credits.txt"]) await writeFile(join(album, file), "x");
		const first = await quarantineTrack(testRoot, quarantine, join(album, "CD1", "01 - a.flac"));
		assert.deepEqual(first, [join(quarantine, "Band", "Band - Record (2020)", "CD1", "01 - a.flac")]);
		assert.equal(await fileExists(join(album, "CD1", "cover.jpg")), true);
		const last = await quarantineTrack(testRoot, quarantine, [album, "CD2", "01 - b.flac"]);
		assert.equal(last.length, 4);
		assert.equal(await fileExists(album), false);
		assert.equal(await fileExists(join(testRoot, "Band")), true);
		assert.equal(await fileExists(join(quarantine, "Band", "Band - Record (2020)", "CD1", "x - credits.txt")), true);
		// A second copy under the same name gets a number instead of overwriting.
		await mkdir(album, { recursive: true });
		await writeFile(join(album, "01 - a.flac"), "y");
		await writeFile(join(album, "02 - c.flac"), "y");
		await mkdir(join(quarantine, "Band", "Band - Record (2020)"), { recursive: true });
		await writeFile(join(quarantine, "Band", "Band - Record (2020)", "01 - a.flac"), "old");
		assert.deepEqual(await quarantineTrack(testRoot, quarantine, join(album, "01 - a.flac")), [join(quarantine, "Band", "Band - Record (2020)", "01 - a (2).flac")]);
		// Outside the library root: refused, nothing moves.
		await assert.rejects(quarantineTrack(join(testRoot, "Band"), quarantine, join(testRoot, "Artist", "Album (2026)", "01 - Track.flac")));
		assert.equal(await fileExists(audioPath), true);
	} finally {
		await rm(testRoot, { recursive: true, force: true });
	}
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
