import type { SpotifyTrackRow } from "./csv";

// Structural subsets of the TIDAL track/album objects, so the scoring stays testable without @luna/lib.
export type CandidateTrack = {
	id: string | number;
	title: string;
	version?: string | null;
	duration?: number;
	isrc?: string | null;
	streamReady?: boolean;
	allowStreaming?: boolean;
	releaseDate?: string | null;
	audioModes?: string[];
	artists?: { name: string }[];
	album?: { id: string | number; title?: string } | null;
};

export type CandidateAlbum = {
	title?: string;
	type?: string;
	releaseDate?: string | null;
	artist?: { name: string } | null;
	artists?: { name: string }[];
};

export type Candidate = {
	track: CandidateTrack;
	album?: CandidateAlbum;
	fromIsrc: boolean;
};

export const MIN_TRACK_SCORE = 70;

export const normalize = (value?: string | null) =>
	(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\b(?:remaster(?:ed)?|radio edit|single version|album version)\b(?:\s*\d{4})?/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

// Edition suffixes that still describe the artist's own release.
const normalizeAlbum = (value?: string | null) =>
	normalize(value)
		.replace(/\b(?:\d+(?:st|nd|rd|th)?\s+)?(?:year\s+)?anniversary\b/g, " ")
		.replace(/\b(?:deluxe|expanded|special|super|bonus track|collector s|legacy|definitive)\b/g, " ")
		.replace(/\b(?:edition|version)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export const tokenSimilarity = (left: string, right: string) => {
	const leftTokens = new Set(normalize(left).split(" ").filter(Boolean));
	const rightTokens = new Set(normalize(right).split(" ").filter(Boolean));
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
	return intersection / new Set([...leftTokens, ...rightTokens]).size;
};

const splitArtists = (value: string) =>
	value
		.split(/\s*(?:;|,|&|\bfeat\.?|\bft\.?|\bwith\b|\bx\b)\s*/i)
		.map(normalize)
		.filter(Boolean);

const VARIOUS_ARTISTS = new Set([
	"various artists",
	"various",
	"va",
	"verschiedene interpreten",
	"varios artistas",
	"artistes divers",
	"artisti vari",
	"multi interpreti",
	"diverse artiesten",
	"ivairus atlikejai",
]);

const COMPILATION_TITLE =
	/\b(?:greatest hits|best of|the best|very best|hits|collection|essentials?|anthology|gold|platinum|ultimate|retrospective|compilation|mixtape|mix tape|anthems|successi|exitos|tubes|now that s|now \d+|top \d+|love songs|ballads|classics|singles|playlist|soundtrack|ost|party|chill|workout|summer|christmas|xmas|\d0s|vol \d+|volume \d+)\b/;

const yearOf = (date?: string | null) => {
	const year = Number(date?.slice(0, 4));
	return Number.isInteger(year) && year > 0 ? year : undefined;
};

/** How well the candidate is the same recording as the Spotify row (title, artist, duration). */
export const trackScore = (source: SpotifyTrackRow, candidate: CandidateTrack) => {
	const sourceTitle = normalize(source.trackName);
	const candidateTitle = normalize(candidate.title);
	const candidateFullTitle = normalize(candidate.version ? `${candidate.title} ${candidate.version}` : candidate.title);
	let score =
		sourceTitle === candidateTitle || sourceTitle === candidateFullTitle
			? 80
			: Math.max(tokenSimilarity(source.trackName, candidate.title), tokenSimilarity(source.trackName, candidateFullTitle)) * 55;
	if (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle)) score += 15;

	const sourceArtists = normalize(source.artistNames);
	const candidateArtists = candidate.artists?.map((artist) => normalize(artist.name)) ?? [];
	if (candidateArtists.some((artist) => artist === sourceArtists || sourceArtists.includes(artist))) score += 35;
	else score += Math.max(0, ...candidateArtists.map((artist) => tokenSimilarity(source.artistNames, artist) * 25));

	if (source.durationMs && candidate.duration) {
		const difference = Math.abs(source.durationMs / 1000 - candidate.duration);
		if (difference <= 2) score += 20;
		else if (difference <= 5) score += 10;
		else if (difference > 20) score -= 20;
	}
	return score;
};

/** How likely the candidate's release is the artist's original album rather than a compilation. */
export const releaseScore = (source: SpotifyTrackRow, candidate: CandidateTrack, album?: CandidateAlbum) => {
	let score = 0;
	if (candidate.streamReady === false || candidate.allowStreaming === false) score -= 100;
	if (candidate.audioModes && candidate.audioModes.length > 0 && !candidate.audioModes.includes("STEREO")) score -= 10;

	const albumTitle = album?.title ?? candidate.album?.title;
	const sourceAlbum = normalizeAlbum(source.albumName);
	const candidateAlbum = normalizeAlbum(albumTitle);
	// Spotify names a single after its track. Singles are only a fallback, so such a source album must not
	// pull the choice towards the single when the artist also has the track on an album.
	const sourceIsSingle = sourceAlbum !== "" && sourceAlbum === normalizeAlbum(source.trackName);
	if (sourceAlbum && candidateAlbum && !sourceIsSingle) {
		if (sourceAlbum === candidateAlbum) score += normalize(source.albumName) === normalize(albumTitle) ? 45 : 40;
		else if (tokenSimilarity(sourceAlbum, candidateAlbum) >= 0.6) score += 20;
	}

	const candidateIsSingle = album?.type === "SINGLE" || (album?.type === undefined && candidateAlbum !== "" && candidateAlbum === normalizeAlbum(candidate.title));
	if (album?.type === "COMPILATION") score -= 40;
	else if (candidateIsSingle) score -= 20;
	else if (album?.type === "ALBUM" || album?.type === "EP") score += 5;

	const albumArtist = normalize(album?.artist?.name ?? album?.artists?.[0]?.name);
	if (albumArtist) {
		const sourceArtists = splitArtists(source.artistNames);
		if (VARIOUS_ARTISTS.has(albumArtist)) score -= 40;
		else if (sourceArtists.some((artist) => artist === albumArtist || artist.includes(albumArtist) || albumArtist.includes(artist))) score += 15;
		else score -= 25;
	}

	// Only penalise "Greatest Hits"-style titles when the Spotify album is not one itself.
	if (candidateAlbum && COMPILATION_TITLE.test(candidateAlbum) && !COMPILATION_TITLE.test(sourceAlbum)) score -= 15;

	const sourceYear = yearOf(source.releaseDate);
	const candidateYear = yearOf(album?.releaseDate ?? candidate.releaseDate);
	// A single's date says nothing about the album the track later appeared on.
	if (sourceYear && candidateYear && !sourceIsSingle) {
		if (sourceYear === candidateYear) score += 15;
		else if (candidateYear > sourceYear + 1) score -= 10;
	}
	return score;
};

/**
 * The cheap path: a candidate already sitting on the album Spotify names, judged from the album title
 * TIDAL embeds in search and track results, so no album request is needed. Only for real albums: when
 * Spotify points at a single or a compilation, the original still has to be looked for.
 */
export const findDirectAlbumMatch = (source: SpotifyTrackRow, candidates: Candidate[]) => {
	const sourceAlbum = normalizeAlbum(source.albumName);
	if (!sourceAlbum || sourceAlbum === normalizeAlbum(source.trackName) || COMPILATION_TITLE.test(sourceAlbum)) return undefined;
	return candidates
		.filter((candidate) => normalizeAlbum(candidate.track.album?.title) === sourceAlbum)
		.map((candidate) => ({ candidate, match: trackScore(source, candidate.track) }))
		.filter(({ candidate, match }) => match >= MIN_TRACK_SCORE && candidate.track.streamReady !== false && candidate.track.allowStreaming !== false)
		.sort((a, b) => b.match - a.match)[0]?.candidate;
};

/**
 * Picks the best TIDAL candidate. ISRC candidates are already the same recording, so they skip the
 * text-match threshold; among equal scores the earliest release date wins, as originals predate compilations.
 */
export const pickBestCandidate = (source: SpotifyTrackRow, candidates: Candidate[], preferOriginalAlbums = true) => {
	const ranked = candidates
		.map((candidate) => {
			const match = trackScore(source, candidate.track);
			const release = preferOriginalAlbums ? releaseScore(source, candidate.track, candidate.album) : 0;
			return { candidate, match, total: match + release };
		})
		.filter(({ candidate, match }) => candidate.fromIsrc || match >= MIN_TRACK_SCORE)
		.sort((a, b) => {
			if (b.total !== a.total) return b.total - a.total;
			const dateA = a.candidate.album?.releaseDate ?? a.candidate.track.releaseDate ?? "9999";
			const dateB = b.candidate.album?.releaseDate ?? b.candidate.track.releaseDate ?? "9999";
			return dateA.localeCompare(dateB);
		});
	return ranked[0]?.candidate;
};
