import type { redux } from "@luna/lib";

import { appendDownloadLog } from "./files.native";

export const DOWNLOAD_LOG_FILE = "SongDownloader log.csv";

export type DownloadLogEntry = {
	status: "downloaded" | "retry later" | "failed" | "album skipped";
	/** collection = startup Collection scan, favorite = newly favorited track/album, manual = context menu. */
	source: "collection" | "favorite" | "manual";
	artist?: string;
	album?: string;
	title?: string;
	trackId?: redux.ItemId;
	requested?: redux.AudioQuality;
	/** What TIDAL actually delivered, from the playback info used for the download. */
	delivered?: { audioQuality?: redux.AudioQuality; audioMode?: string; bitDepth?: number | null; sampleRate?: number | null };
	file?: string | string[];
	details?: string;
};

const LOSSLESS = new Set<string>(["LOSSLESS", "HI_RES", "HI_RES_LOSSLESS"]);
const QUALITY_NAMES: Record<string, string> = {
	HI_RES_LOSSLESS: "Hi-Res Lossless",
	HI_RES: "Hi-Res",
	LOSSLESS: "Lossless",
	HIGH: "High (AAC)",
	LOW: "Low (AAC)",
};

const HEADER = ["Time", "Status", "Lossless", "Quality", "Requested", "Source", "Artist", "Album", "Track", "TIDAL ID", "File", "Details"];

const csvField = (value: string | number | undefined) => {
	const text = value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const describeDelivered = (delivered: NonNullable<DownloadLogEntry["delivered"]>) => {
	if (delivered.audioMode === "DOLBY_ATMOS") return { lossless: "no (Dolby Atmos)", quality: "Dolby Atmos" };
	const quality = delivered.audioQuality;
	const format = delivered.bitDepth && delivered.sampleRate ? ` ${delivered.bitDepth}-bit/${delivered.sampleRate / 1000}kHz` : "";
	return {
		lossless: quality === undefined ? "" : LOSSLESS.has(quality) ? "yes" : "NO",
		quality: `${quality === undefined ? "?" : (QUALITY_NAMES[quality] ?? quality)}${format}`,
	};
};

export const formatDownloadLogLine = (entry: DownloadLogEntry, now = new Date()) => {
	const { lossless, quality } = entry.delivered ? describeDelivered(entry.delivered) : { lossless: "", quality: "" };
	const file = Array.isArray(entry.file) ? entry.file.join("\\") : entry.file;
	const time = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
	return [
		time,
		entry.status,
		lossless,
		quality,
		entry.requested ? (QUALITY_NAMES[entry.requested] ?? entry.requested) : "",
		entry.source,
		entry.artist,
		entry.album,
		entry.title,
		entry.trackId === undefined ? undefined : String(entry.trackId),
		file,
		entry.details,
	]
		.map(csvField)
		.join(",");
};

/** Appends one row to "<save root>/SongDownloader log.csv". Never throws: the log must not break downloads. */
export const logDownload = async (rootPath: string | undefined, entry: DownloadLogEntry) => {
	if (rootPath === undefined) return;
	try {
		await appendDownloadLog(rootPath, DOWNLOAD_LOG_FILE, HEADER.join(","), formatDownloadLogLine(entry));
	} catch (error) {
		console.warn("[SongDownloader] Could not write download log", error);
	}
};
