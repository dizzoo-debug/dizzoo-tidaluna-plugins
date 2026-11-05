import { open, readdir } from "fs/promises";
import { join } from "path";

const QUARANTINE = "_SongDownloader_Quarantine";
const tidalTrackUrl = /tidal\.com\/(?:browse\/)?track\/(\d+)/i;

/** The TIDAL track id from a Vorbis comment block (COMMENT / DESCRIPTION holding the track URL). */
export const tidalIdFromVorbisComment = (block: Buffer) => {
	let offset = 0;
	const vendorLength = block.readUInt32LE(offset);
	offset += 4 + vendorLength;
	const count = block.readUInt32LE(offset);
	offset += 4;
	for (let i = 0; i < count && offset + 4 <= block.length; i++) {
		const length = block.readUInt32LE(offset);
		offset += 4;
		const entry = block.toString("utf8", offset, offset + length);
		offset += length;
		if (/^(?:comment|description)=/i.test(entry)) {
			const match = entry.match(tidalTrackUrl);
			if (match) return match[1];
		}
	}
	return undefined;
};

/**
 * Reads only the FLAC metadata block headers and the Vorbis comment block; pictures and audio are
 * skipped by seeking, so a large library is indexed quickly.
 */
export const readFlacTidalId = async (path: string) => {
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(4);
		await file.read(header, 0, 4, 0);
		if (header.toString("latin1") !== "fLaC") return undefined;
		let position = 4;
		for (;;) {
			const { bytesRead } = await file.read(header, 0, 4, position);
			if (bytesRead < 4) return undefined;
			const last = (header[0] & 0x80) !== 0;
			const type = header[0] & 0x7f;
			const length = header.readUIntBE(1, 3);
			position += 4;
			if (type === 4) {
				const block = Buffer.alloc(length);
				await file.read(block, 0, length, position);
				return tidalIdFromVorbisComment(block);
			}
			if (last) return undefined;
			position += length;
		}
	} finally {
		await file.close();
	}
};

export type ReindexResult = { entries: Record<string, string>; scanned: number; withoutId: number; failed: number };

/**
 * Maps TIDAL track ids to the FLAC files under the library root, whatever their folder and file
 * names are now. Nothing is written to disk and TIDAL is never contacted. The quarantine folder is
 * left out, so a quarantined copy never stands in for a missing library file.
 */
export const reindexLibrary = async (root: string): Promise<ReindexResult> => {
	const result: ReindexResult = { entries: {}, scanned: 0, withoutId: 0, failed: 0 };
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			result.failed++;
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== QUARANTINE && !entry.name.endsWith(".merge-tmp")) await walk(path);
				continue;
			}
			if (!/\.flac$/i.test(entry.name)) continue;
			result.scanned++;
			try {
				const id = await readFlacTidalId(path);
				if (id === undefined) result.withoutId++;
				else result.entries[id] ??= path;
			} catch {
				result.failed++;
			}
		}
	};
	await walk(root);
	return result;
};
