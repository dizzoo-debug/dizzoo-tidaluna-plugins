import type { MediaItem } from "@luna/lib";

export type TagValues = Awaited<ReturnType<MediaItem["flacTags"]>>["tags"];

/** The raw TIDAL fields the tags are built from, flattened so the selection can be tested without Luna. */
export type TidalTagSource = {
	title?: string;
	version?: string | null;
	trackNumber?: number;
	volumeNumber?: number;
	artists?: string[];
	isrc?: string | null;
	releaseDate?: string | null;
	streamStartDate?: string | null;
	album?: {
		title?: string;
		version?: string | null;
		artists?: string[];
		releaseDate?: string | null;
		releaseYear?: string | null;
		upc?: string | null;
	};
};

export const formatTidalTitle = (title: string, version?: string | null) => {
	if (version && !title.toLowerCase().includes(version.toLowerCase())) return `${title} (${version})`;
	return title;
};

const comparableTitle = (title: string, baseOnly = false) => {
	let value = title.normalize("NFKD").toLowerCase().replace(/\s&\s/g, " and ");
	// "Song (Remastered 2009)", "Song [Live]", "Song - 2011 Remaster", "Song (feat. X)"
	if (baseOnly) value = value.replace(/\([^)]*\)|\[[^\]]*\]|\s[-–—]\s.*$|\s(?:feat\.|ft\.|featuring\s).*$/g, "");
	return value.replace(/[^\p{L}\p{N}]+/gu, "");
};

// Words that make a different recording or edit of the same song; remaster or "album version" wording does not.
const recordingKinds = (title: string) =>
	[...new Set(title.toLowerCase().match(/\b(?:live|demo|acoustic|unplugged|remix|mix|instrumental|edit|single version|session|take|rehearsal)\b/g) ?? [])]
		.sort()
		.join(",");

/**
 * Luna's MusicBrainz lookup falls back to "track N of the first release found by barcode search"
 * whenever the ISRC lookup fails (MusicBrainz answers 503 under load). That release can be another
 * pressing with a different running order, or another album entirely, so the recording it returns
 * is only trusted when its title still names the TIDAL track.
 */
export const brainzTitleMatches = (brainzTitle: string | undefined, tidalTitle: string) => {
	if (!brainzTitle) return false;
	if (brainzTitle.trim().toLowerCase() === tidalTitle.trim().toLowerCase()) return true;
	const full = comparableTitle(brainzTitle);
	if (full !== "" && full === comparableTitle(tidalTitle)) return true;
	// "Song (Live)" is another recording than "Song": the base match needs the same kind of version.
	if (recordingKinds(brainzTitle) !== recordingKinds(tidalTitle)) return false;
	const base = comparableTitle(brainzTitle, true);
	return base !== "" && base === comparableTitle(tidalTitle, true);
};

/**
 * The year to embed: the original-release year from a MusicBrainz recording that is the same song,
 * otherwise the TIDAL year. Paths keep using the TIDAL year so the library layout does not move.
 */
export const selectEmbeddedYear = (enrichedTags: TagValues, selectedTags: TagValues) => {
	if (enrichedTags.year && selectedTags.title && brainzTitleMatches(enrichedTags.title, String(selectedTags.title))) return enrichedTags.year;
	return selectedTags.year;
};

/**
 * TIDAL decides everything it knows about the track; MusicBrainz only fills fields TIDAL lacks,
 * and its ids are dropped when the recording it matched is a different song.
 */
export const selectTidalTags = (enrichedTags: TagValues, item: TidalTagSource): TagValues => {
	const tags: TagValues = { ...enrichedTags };
	const album = item.album;
	const artists = item.artists?.filter(Boolean) ?? [];
	const albumArtists = album?.artists?.filter(Boolean) ?? [];
	const releaseDate = album?.releaseDate ?? item.releaseDate ?? item.streamStartDate;

	if (item.title) {
		const title = formatTidalTitle(item.title, item.version);
		if (!brainzTitleMatches(enrichedTags.title, title)) {
			delete tags.musicbrainz_trackid;
			delete tags.musicbrainz_albumid;
			// Without a TIDAL date these could only have come from the wrong recording.
			if (!releaseDate) {
				delete tags.year;
				delete tags.date;
			}
		}
		tags.title = title;
	}
	if (item.trackNumber !== undefined) tags.trackNumber = String(item.trackNumber);
	if (item.volumeNumber !== undefined) tags.discNumber = String(item.volumeNumber);
	if (artists.length > 0) tags.artist = artists;
	if (album?.title) tags.album = formatTidalTitle(album.title, album.version);
	if (albumArtists.length > 0) tags.albumArtist = albumArtists;
	else if (artists.length > 0) tags.albumArtist = artists;
	if (releaseDate) {
		tags.date = releaseDate.slice(0, 10);
		tags.year = album?.releaseYear ?? releaseDate.slice(0, 4);
	}
	if (item.isrc) tags.isrc = item.isrc;
	if (album?.upc) tags.upc = album.upc;
	return tags;
};
