import type { UnidentifiedFile } from "./reindex.native";

/** The part of a TIDAL search result the match needs. */
export type TrackCandidate = {
	id: number | string;
	title: string;
	version?: string | null;
	duration?: number;
	artists?: { name: string }[];
	artist?: { name: string };
	album?: { title?: string };
};

const normalize = (value: string | undefined | null) =>
	String(value ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");

// "Song (Remastered 2009)" and "Song" + version "Remastered 2009" are the same title.
const titleVariants = (title: string, version?: string | null) => {
	const plain = normalize(title);
	return new Set([plain, normalize(`${title} ${version ?? ""}`), normalize(title.replace(/\s*[([][^)\]]*[)\]]\s*/g, " "))]);
};

export type MatchCheck = { match?: TrackCandidate; fromOtherAlbum?: boolean; reason?: string };

/**
 * The candidate that is this file: same title, an artist in common and, when both are known, the same
 * album and a duration within 3 seconds. A broad check also accepts the same recording from another
 * album, but only with a known duration within 1 second. Without a match, `reason` says why the
 * closest candidates were turned down.
 */
export const checkTidalMatch = (file: UnidentifiedFile, candidates: TrackCandidate[], broad = false): MatchCheck => {
	if (!file.title) return { reason: "the file has no title" };
	if (candidates.length === 0) return { reason: "TIDAL returned no results" };
	const fileTitles = titleVariants(file.title);
	const fileArtist = normalize(file.artist);
	const fileAlbum = normalize(file.album);
	const rejected: string[] = [];
	const accepted: { candidate: TrackCandidate; score: number; fromOtherAlbum: boolean }[] = [];
	for (const candidate of candidates) {
		const candidateTitles = titleVariants(candidate.title, candidate.version);
		if (![...fileTitles].some((t) => t && candidateTitles.has(t))) continue;
		const names = [...(candidate.artists ?? []), ...(candidate.artist ? [candidate.artist] : [])].map((a) => normalize(a.name));
		if (fileArtist && !names.some((name) => name && (fileArtist.includes(name) || name.includes(fileArtist)))) continue;
		const durationGap =
			file.durationSeconds !== undefined && candidate.duration !== undefined ? Math.abs(file.durationSeconds - candidate.duration) : undefined;
		const album = normalize(candidate.album?.title);
		const albumMatches = !fileAlbum || !album || album === fileAlbum || album.startsWith(fileAlbum) || fileAlbum.startsWith(album);
		if (durationGap !== undefined && durationGap > 3) {
			rejected.push(`length differs by ${Math.round(durationGap)} s (${candidate.album?.title ?? "?"})`);
			continue;
		}
		if (!albumMatches) {
			if (broad && durationGap !== undefined && durationGap <= 1) {
				accepted.push({ candidate, score: 0, fromOtherAlbum: true });
			} else {
				rejected.push(`other album: ${candidate.album?.title ?? "?"}${durationGap === undefined ? "" : `, length ±${durationGap.toFixed(1)} s`}`);
			}
			continue;
		}
		accepted.push({ candidate, score: 10 + (album === fileAlbum ? 2 : 0) + (durationGap !== undefined ? 1 : 0), fromOtherAlbum: false });
	}
	accepted.sort((a, b) => b.score - a.score);
	if (accepted[0]) return { match: accepted[0].candidate, fromOtherAlbum: accepted[0].fromOtherAlbum };
	if (rejected.length === 0) return { reason: "no result with the same title and artist" };
	return { reason: [...new Set(rejected)].slice(0, 3).join("; ") };
};

export const pickTidalMatch = (file: UnidentifiedFile, candidates: TrackCandidate[], broad = false) => checkTidalMatch(file, candidates, broad).match;

export type IdentifyResult = {
	found: { path: string; audioMd5?: string; id: string; title: string; album?: string; fromOtherAlbum?: boolean }[];
	notFound: (UnidentifiedFile & { reason?: string })[];
	stoppedByRateLimit: boolean;
};

export type IdentifyPhase = "by title" | "with album";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A search by artist and title, then (if nothing matched) one that names the album, one file at a
 * time with a pause between requests; a 429 stops the run instead of retrying.
 */
export const identifyOnTidal = async (
	files: UnidentifiedFile[],
	search: (query: string) => Promise<TrackCandidate[]>,
	onProgress?: (done: number, total: number, phase: IdentifyPhase) => void,
	options: { broad?: boolean } = {},
): Promise<IdentifyResult> => {
	const result: IdentifyResult = { found: [], notFound: [], stoppedByRateLimit: false };
	for (const [index, file] of files.entries()) {
		if (result.stoppedByRateLimit) {
			result.notFound.push({ ...file, reason: "not searched: TIDAL answered 429" });
			continue;
		}
		try {
			const artist = file.artist?.split(/[,&]/)[0];
			const query = [artist, file.title].filter(Boolean).join(" ");
			if (!query) {
				result.notFound.push({ ...file, reason: "the file has no title or artist" });
				continue;
			}
			onProgress?.(index, files.length, "by title");
			let check = checkTidalMatch(file, await search(query), options.broad);
			// Tracks on compilations often fall outside the first page; a second search names the album.
			if (!check.match && file.album) {
				await sleep(600);
				onProgress?.(index, files.length, "with album");
				const second = checkTidalMatch(file, await search([artist, file.title, file.album.replace(/[:/]/g, " ")].filter(Boolean).join(" ")), options.broad);
				check = second.match ? second : { reason: [check.reason, second.reason].filter(Boolean).join("; ") };
			}
			if (check.match)
				result.found.push({ path: file.path, audioMd5: file.audioMd5, id: String(check.match.id), title: check.match.title, album: check.match.album?.title, fromOtherAlbum: check.fromOtherAlbum });
			else result.notFound.push({ ...file, reason: check.reason });
		} catch (error) {
			if (/\b429\b|too many requests/i.test(String(error))) result.stoppedByRateLimit = true;
			result.notFound.push({ ...file, reason: String(error) });
		}
		await sleep(600);
	}
	onProgress?.(files.length, files.length, "with album");
	return result;
};
