export type SpotifyTrackRow = {
	rowNumber: number;
	isrc?: string;
	trackName: string;
	artistNames: string;
	albumName?: string;
	durationMs?: number;
	releaseDate?: string;
};

const decodeSpotifyPart = (value: string) => {
	try {
		return decodeURIComponent(value.replaceAll("+", " "));
	} catch {
		return value.replaceAll("+", " ");
	}
};

const parseLocalTrackUri = (uri?: string) => {
	if (!uri?.startsWith("spotify:local:")) return {};
	const parts = uri.split(":");
	if (parts.length < 6) return {};
	return {
		artist: decodeSpotifyPart(parts[2] ?? "").trim() || undefined,
		album: decodeSpotifyPart(parts[3] ?? "").trim() || undefined,
		title: decodeSpotifyPart(parts.slice(4, -1).join(":"))?.trim() || undefined,
	};
};

const normalizeHeader = (value: string) => value.replace(/^\uFEFF/, "").trim().toLowerCase();

export const parseCsv = (contents: string): string[][] => {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	for (let index = 0; index < contents.length; index++) {
		const character = contents[index];
		if (quoted) {
			if (character === '"') {
				if (contents[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				field += character;
			}
			continue;
		}

		if (character === '"' && field.length === 0) {
			quoted = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n") {
			row.push(field.replace(/\r$/, ""));
			if (row.some((value) => value.length > 0)) rows.push(row);
			row = [];
			field = "";
		} else {
			field += character;
		}
	}

	if (quoted) throw new Error("CSV contains an unterminated quoted field");
	row.push(field.replace(/\r$/, ""));
	if (row.some((value) => value.length > 0)) rows.push(row);
	return rows;
};

export const parseSpotifyCsv = (contents: string): SpotifyTrackRow[] => {
	const rows = parseCsv(contents);
	if (rows.length === 0) throw new Error("CSV file is empty");

	const headerIndexes = new Map(rows[0].map((header, index) => [normalizeHeader(header), index]));
	const indexOf = (...names: string[]) => names.map((name) => headerIndexes.get(name)).find((index) => index !== undefined);
	const trackIndex = indexOf("track name", "track");
	const artistIndex = indexOf("artist name(s)", "artist names", "artist name", "artist");
	if (trackIndex === undefined || artistIndex === undefined) {
		throw new Error('CSV must contain "Track Name" and "Artist Name(s)" columns');
	}

	const isrcIndex = indexOf("isrc");
	const sourceRowIndex = indexOf("csv row", "source csv row");
	const uriIndex = indexOf("track uri", "uri");
	const albumIndex = indexOf("album name", "album");
	const durationIndex = indexOf("duration (ms)", "duration ms", "duration");
	const releaseDateIndex = indexOf("release date", "album release date");
	const parsed: SpotifyTrackRow[] = [];

	for (let index = 1; index < rows.length; index++) {
		const values = rows[index];
		let trackName = values[trackIndex]?.trim();
		let artistNames = values[artistIndex]?.trim();
		const local = parseLocalTrackUri(uriIndex === undefined ? undefined : values[uriIndex]?.trim());
		trackName ||= local.title;
		artistNames ||= local.artist;
		if (!artistNames && trackName?.includes(" - ")) {
			const separator = trackName.indexOf(" - ");
			artistNames = trackName.slice(0, separator).trim();
			trackName = trackName.slice(separator + 3).trim();
		}
		artistNames ||= local.album;
		if (!trackName) continue;
		const durationValue = durationIndex === undefined ? undefined : Number(values[durationIndex]);
		const sourceRow = sourceRowIndex === undefined ? undefined : Number(values[sourceRowIndex]);
		const releaseDate = releaseDateIndex === undefined ? undefined : values[releaseDateIndex]?.trim() || undefined;
		parsed.push({
			rowNumber: Number.isInteger(sourceRow) && sourceRow! > 0 ? sourceRow! : index + 1,
			isrc: isrcIndex === undefined ? undefined : values[isrcIndex]?.trim() || undefined,
			trackName,
			artistNames: artistNames ?? "",
			albumName: (albumIndex === undefined ? undefined : values[albumIndex]?.trim()) || local.album || undefined,
			durationMs: Number.isFinite(durationValue) && durationValue! > 0 ? durationValue : undefined,
			...(releaseDate ? { releaseDate } : {}),
		});
	}

	if (parsed.length === 0) throw new Error("CSV contains no usable track rows");
	return parsed;
};

const cleanReportText = (value?: string) => value?.replace(/\s+/g, " ").trim() || "—";

const escapeCsvField = (value: string | number | undefined) => {
	const text = value === undefined ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const makeUnmatchedCsv = (rows: { track: SpotifyTrackRow; reason: string }[]) => {
	const header = ["CSV Row", "ISRC", "Track Name", "Artist Name(s)", "Album Name", "Reason"];
	const lines = rows.map(({ track, reason }) =>
		[track.rowNumber, track.isrc, track.trackName, track.artistNames, track.albumName, reason]
			.map(escapeCsvField)
			.join(","),
	);
	return `\uFEFF${[header.join(","), ...lines].join("\r\n")}\r\n`;
};

export const makeUnmatchedText = (rows: { track: SpotifyTrackRow; reason: string }[]) => {
	const entries = rows.map(({ track, reason }, index) => {
		const artists = cleanReportText(track.artistNames).replaceAll(";", ", ");
		return [
			`${index + 1}. ${artists} — ${cleanReportText(track.trackName)}`,
			`   Album: ${cleanReportText(track.albumName)}`,
			`   ISRC: ${cleanReportText(track.isrc)}`,
			`   Source CSV row: ${track.rowNumber}`,
			`   Reason: ${cleanReportText(reason)}`,
		].join("\r\n");
	});
	return `\uFEFFSpotify CSV Importer\r\nTracks not matched in TIDAL: ${rows.length}\r\n\r\n${entries.join("\r\n\r\n")}\r\n`;
};
