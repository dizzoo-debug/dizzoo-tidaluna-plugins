import type { MediaItem } from "@luna/lib";

export type TagValues = Awaited<ReturnType<MediaItem["flacTags"]>>["tags"];

/** The raw TIDAL fields the tags are built from, flattened so the selection can be tested without Luna. */
export type TidalTagSource = {
	title?: string;
	version?: string | null;
	trackNumber?: number;
	volumeNumber?: number;
	artists?: string[];
	/** Artists TIDAL marks as FEATURED; written into the title as "(feat. X)" when TIDAL left them out. */
	featuredArtists?: string[];
	isrc?: string | null;
	/**
	 * ISRCs of the MusicBrainz recording behind the enriched tags (`brainzItem().recording.isrcs`);
	 * null when MusicBrainz matched nothing. Left undefined, the title comparison decides instead.
	 */
	brainzIsrcs?: readonly string[] | null;
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

const featuringPattern = /(?:^|[\s([])(?:feat\.?|ft\.|featuring)\s/i;

/** "B", "B & C", "B, C & D" */
const joinArtistNames = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`);

/**
 * "Song (feat. B & C) (Radio Edit)": TIDAL often lists featured artists without naming them in the title.
 * The credit goes before the trailing version groups, as TIDAL writes it when it does. A title that
 * already credits a featuring, or already names the artist, is left alone.
 */
export const addFeaturedArtists = (title: string, featuredArtists: readonly string[] = []) => {
	if (featuringPattern.test(title)) return title;
	const lowerTitle = title.toLowerCase();
	const names = [...new Set(featuredArtists.map((name) => name.trim()).filter((name) => name && !lowerTitle.includes(name.toLowerCase())))];
	if (names.length === 0) return title;
	const credit = ` (feat. ${joinArtistNames(names)})`;
	const versions = title.match(/(?:\s[([][^()[\]]*[)\]])+$/)?.[0] ?? "";
	return `${title.slice(0, title.length - versions.length)}${credit}${versions}`;
};

const comparableTitle =(title: string, baseOnly = false) => {
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
 * pressing with a different running order, or another album entirely. When the recording's ISRCs
 * are not available, it is only trusted when its title still names the TIDAL track.
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

/** The MusicBrainz recording lists the TIDAL track's ISRC, so it is that very recording, not a guess. */
export const brainzIsrcMatches = (brainzIsrcs: readonly string[] | null | undefined, tidalIsrc: string | null | undefined) =>
	!!tidalIsrc && !!brainzIsrcs?.some((isrc) => isrc.trim().toUpperCase() === tidalIsrc.trim().toUpperCase());

type BrainzEvidence = Pick<TidalTagSource, "isrc" | "brainzIsrcs">;

/**
 * Whether the MusicBrainz ids and original year in the enriched tags may be kept. When the recording's
 * ISRCs are known only an ISRC match counts, so Luna's album-position fallback never supplies them.
 */
export const isBrainzTrusted = (enrichedTags: TagValues, tidalTitle: string, evidence: BrainzEvidence = {}) =>
	evidence.brainzIsrcs !== undefined ? brainzIsrcMatches(evidence.brainzIsrcs, evidence.isrc) : brainzTitleMatches(enrichedTags.title, tidalTitle);

/**
 * The year to embed: the original-release year from a MusicBrainz recording that is the same song,
 * otherwise the TIDAL year. Paths keep using the TIDAL year so the library layout does not move.
 */
export const selectEmbeddedYear = (enrichedTags: TagValues, selectedTags: TagValues, evidence: BrainzEvidence = {}) => {
	if (enrichedTags.year && selectedTags.title && isBrainzTrusted(enrichedTags, String(selectedTags.title), evidence)) return enrichedTags.year;
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
		if (!isBrainzTrusted(enrichedTags, title, item)) {
			delete tags.musicbrainz_trackid;
			delete tags.musicbrainz_albumid;
			// Without a TIDAL date these could only have come from the wrong recording.
			if (!releaseDate) {
				delete tags.year;
				delete tags.date;
			}
		}
		// After the MusicBrainz check, which compares TIDAL's own title.
		tags.title = addFeaturedArtists(title, item.featuredArtists);
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
	// Never MusicBrainz's: its ISRC and barcode can belong to another song or release (Live 8 ISRCs three tracks off).
	if (item.isrc) tags.isrc = item.isrc;
	else delete tags.isrc;
	if (album?.upc) tags.upc = album.upc;
	else delete tags.upc;
	return tags;
};
