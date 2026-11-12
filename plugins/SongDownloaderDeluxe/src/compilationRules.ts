/**
 * Which albums go to "!Compilations" although one artist is credited (the user's rule of 2026-11-11):
 * an artist's own official collection (Greatest Hits, The Platinum Collection) stays in the artist's
 * folder; a release that is unofficial, or whose tracks are mostly by other artists (DJ mixes such as
 * Hôtel Costes), goes to "!Compilations". Various Artists releases are decided elsewhere.
 * Pure functions here; the TIDAL lookups that feed them are in compilations.ts.
 */

// Recordings that are not the artist's own releases: re-recordings, tributes, karaoke and cover albums.
const unofficialWords =
	/\b(?:re-?recorded|re-?recording|tribute|karaoke|in the style of|originally performed by|made famous by|as made famous|cover versions?|covers? album|performed by the|instrumental versions? of)\b/i;

export const hasUnofficialWords = (...texts: (string | null | undefined)[]) => texts.some((text) => !!text && unofficialWords.test(text));

/** The user's own list: one entry per line, matched case-insensitively anywhere in "Artist - Album" or the ℗/© line. */
export const matchesManualList = (list: string | undefined, album: { artist?: string; title?: string; copyright?: string | null }) => {
	const haystack = `${album.artist ?? ""} - ${album.title ?? ""}\n${album.copyright ?? ""}`.toLowerCase();
	return (list ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim().toLowerCase())
		.some((line) => line !== "" && haystack.includes(line));
};

// Words every ℗/© line has, so they never make two labels "the same".
const labelNoise = new Set([
	"the", "a", "an", "and", "of", "under", "exclusive", "licence", "license", "licensed", "to", "by", "for", "from", "in", "on",
	"records", "record", "recordings", "recording", "music", "entertainment", "group", "ltd", "limited", "inc", "llc", "gmbh", "bv",
	"co", "company", "corp", "corporation", "uk", "us", "usa", "international", "worldwide", "rights", "reserved", "all", "this",
	"compilation", "marketed", "distributed", "a division", "division", "trading", "as", "label", "copyright", "p", "c",
]);

/** Distinctive words of a ℗/© line: "℗ 2000 Queen Productions Ltd under exclusive licence to EMI" → queen, productions, emi. */
export const labelWords = (copyright: string | null | undefined) =>
	new Set(
		String(copyright ?? "")
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[℗©]|\(p\)|\(c\)/g, " ")
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 1 && !/^\d+$/.test(word) && !labelNoise.has(word)),
	);

/**
 * True when the compilation's ℗/© line shares no distinctive word with any of the artist's own albums.
 * Unknown either way (no line, no albums to compare with) counts as the same label.
 */
export const labelDiffers = (compilationCopyright: string | null | undefined, artistAlbumCopyrights: (string | null | undefined)[]) => {
	const own = labelWords(compilationCopyright);
	const others = artistAlbumCopyrights.map(labelWords).filter((words) => words.size > 0);
	if (own.size === 0 || others.length === 0) return false;
	return !others.some((words) => [...own].some((word) => words.has(word)));
};

/** Share of an album's tracks that credit one of the album's artists (by name, case-insensitive). */
export const albumArtistShare = (albumArtists: string[], trackArtists: string[][]) => {
	if (trackArtists.length === 0) return 1;
	const names = new Set(albumArtists.map((name) => name.trim().toLowerCase()));
	const own = trackArtists.filter((artists) => artists.some((name) => names.has(name.trim().toLowerCase()))).length;
	return own / trackArtists.length;
};

/** Mostly other artists' tracks: a DJ mix or a curated series credited to one name. */
export const mostlyOtherArtists = (albumArtists: string[], trackArtists: string[][]) => albumArtistShare(albumArtists, trackArtists) < 0.5;
