import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { audioFileExists, fileExists, saveCoverArt } from "./files.native";

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
	} finally {
		await rm(testRoot, { recursive: true, force: true });
	}
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
