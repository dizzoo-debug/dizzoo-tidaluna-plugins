import { open, readdir } from "fs/promises";
import { basename, dirname, join } from "path";

const QUARANTINE = "_SongDownloader_Quarantine";
const tidalTrackUrl = /tidal\.com\/(?:browse\/)?track\/(\d+)/i;

/** Vorbis comment fields, keys upper-cased; the first value wins. */
export const readVorbisComment = (block: Buffer) => {
	const fields: Record<string, string> = {};
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
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		const key = entry.slice(0, separator).toUpperCase();
		fields[key] ??= entry.slice(separator + 1);
	}
	return fields;
};

/** The TIDAL track id from a Vorbis comment block (COMMENT / DESCRIPTION holding the track URL). */
export const tidalIdFromVorbisComment = (block: Buffer) => {
	const fields = readVorbisComment(block);
	for (const key of ["COMMENT", "DESCRIPTION"]) {
		const match = fields[key]?.match(tidalTrackUrl);
		if (match) return match[1];
	}
	return undefined;
};

export type FlacInfo = { tidalId?: string; tags: Record<string, string>; durationSeconds?: number; audioMd5?: string };

/**
 * Reads only the FLAC metadata block headers, STREAMINFO and the Vorbis comment block; pictures and
 * audio are skipped by seeking, so a large library is indexed quickly.
 */
export const readFlacInfo = async (path: string): Promise<FlacInfo | undefined> => {
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(4);
		await file.read(header, 0, 4, 0);
		if (header.toString("latin1") !== "fLaC") return undefined;
		const info: FlacInfo = { tags: {} };
		let position = 4;
		for (;;) {
			const { bytesRead } = await file.read(header, 0, 4, position);
			if (bytesRead < 4) return info;
			const last = (header[0] & 0x80) !== 0;
			const type = header[0] & 0x7f;
			const length = header.readUIntBE(1, 3);
			position += 4;
			if (type === 0 && length >= 18) {
				// STREAMINFO: 20-bit sample rate at byte 10, 36-bit total samples ending at byte 17,
				// then the MD5 of the decoded audio (bytes 18-33), the same for copies that only differ in tags.
				const block = Buffer.alloc(34);
				await file.read(block, 0, Math.min(34, length), position);
				const md5 = block.subarray(18, 34).toString("hex");
				if (length >= 34 && !/^0+$/.test(md5)) info.audioMd5 = md5;
				const sampleRate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4);
				const totalSamples = (block[13] & 0x0f) * 2 ** 32 + block.readUInt32BE(14);
				if (sampleRate > 0 && totalSamples > 0) info.durationSeconds = totalSamples / sampleRate;
			} else if (type === 4) {
				const block = Buffer.alloc(length);
				await file.read(block, 0, length, position);
				info.tags = readVorbisComment(block);
				info.tidalId = tidalIdFromVorbisComment(block);
				return info;
			}
			if (last) return info;
			position += length;
		}
	} finally {
		await file.close();
	}
};

export const readFlacTidalId = async (path: string) => (await readFlacInfo(path))?.tidalId;

/** What a FLAC without a TIDAL id says about itself, for looking it up on TIDAL. */
export type UnidentifiedFile = { path: string; title?: string; artist?: string; album?: string; durationSeconds?: number };

/**
 * Tags first; a file without tags falls back to the library layout,
 * "Artist/Artist - Album (year)/01 - Artist - Title.flac".
 */
export const describeUnidentified = (path: string, info: FlacInfo): UnidentifiedFile => {
	const fileMatch = basename(path)
		.replace(/\.flac$/i, "")
		.match(/^\d+\s*-\s*(.+?)\s+-\s+(.+)$/);
	const folder = basename(dirname(path)).replace(/^CD\d+$/i, () => basename(dirname(dirname(path))));
	const folderMatch = folder.match(/^(.+?) - (.+?)(?: \(\d{4}\))?(?: \[[^\]]+\])*$/);
	return {
		path,
		title: info.tags.TITLE ?? fileMatch?.[2],
		artist: info.tags.ARTIST ?? info.tags.ALBUMARTIST ?? fileMatch?.[1] ?? folderMatch?.[1],
		album: info.tags.ALBUM ?? folderMatch?.[2],
		durationSeconds: info.durationSeconds,
	};
};

export type ReindexResult = {
	entries: Record<string, string>;
	scanned: number;
	withoutId: number;
	failed: number;
	unidentified: UnidentifiedFile[];
	/** Files without an id whose audio is identical to a file that has one: duplicates, nothing to look up. */
	sameAudioAsIdentified: { path: string; id: string; identifiedPath: string }[];
};

/**
 * Maps TIDAL track ids to the FLAC files under the library root, whatever their folder and file
 * names are now. Nothing is written to disk and TIDAL is never contacted. The quarantine folder is
 * left out, so a quarantined copy never stands in for a missing library file.
 */
export const reindexLibrary = async (root: string): Promise<ReindexResult> => {
	const result: ReindexResult = { entries: {}, scanned: 0, withoutId: 0, failed: 0, unidentified: [], sameAudioAsIdentified: [] };
	const idByAudio = new Map<string, { id: string; path: string }>();
	const unidentifiedAudio = new Map<string, string>();
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
				const info = await readFlacInfo(path);
				if (info?.tidalId !== undefined) {
					result.entries[info.tidalId] ??= path;
					if (info.audioMd5) idByAudio.set(info.audioMd5, { id: info.tidalId, path });
					continue;
				}
				result.withoutId++;
				result.unidentified.push(describeUnidentified(path, info ?? { tags: {} }));
				if (info?.audioMd5) unidentifiedAudio.set(path, info.audioMd5);
			} catch {
				result.failed++;
			}
		}
	};
	await walk(root);
	result.unidentified = result.unidentified.filter((file) => {
		const twin = idByAudio.get(unidentifiedAudio.get(file.path) ?? "");
		if (twin === undefined) return true;
		result.sameAudioAsIdentified.push({ path: file.path, id: twin.id, identifiedPath: twin.path });
		return false;
	});
	return result;
};
