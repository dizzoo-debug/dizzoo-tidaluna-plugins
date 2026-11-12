import { MediaItem, TidalApi, type redux } from "@luna/lib";
import { showOpenDialog, showSaveDialog } from "@luna/lib.native";
import { settings } from "./Settings";

import {
	addEditionVariant,
	formatVariantSuffix,
	isVariousArtists,
	libraryRootFor,
	normalizeEdition,
	sanitizeLibraryComponent,
} from "./archiveLayout";
import { otherCompilationReason } from "./compilations";
import { formatTidalTitle, selectEmbeddedYear, selectTidalTags, type TagValues } from "./tidalTags";

export { formatTidalTitle, type TagValues };
export type ArchiveTagValues = TagValues & {
	/** Year written into the file; `year` stays the TIDAL year used for paths. */
	embeddedYear?: string;
	libraryRoot?: string;
	archiveAlbumArtist?: string;
	archiveAlbumTitle?: string;
	variantSuffix?: string;
};

/**
 * MusicBrainz enrichment is useful inside the audio file, but it must never
 * decide the archive path: its availability and title punctuation can change
 * between launches. Paths are built from the raw TIDAL item and album instead,
 * and the same TIDAL-first tags are what gets embedded (see selectTidalTags).
 */
export const getStablePathTags = async (
	mediaItem: MediaItem,
	enrichedTags: TagValues,
	tagOverrides?: Partial<TagValues>,
	/** The item whose flacTags() produced `enrichedTags`, when that is not `mediaItem` (RealMAX). */
	enrichedFrom: MediaItem = mediaItem,
): Promise<ArchiveTagValues> => {
	// TIDAL's in-app items can be partial (album pages list tracks without ISRC and albums without UPC);
	// Luna then filled those from MusicBrainz guesses. Ask TIDAL for the full item instead (memoized).
	if (!mediaItem.tidalItem.isrc) await mediaItem.fetchTidalMediaItem().catch(() => undefined);
	const item = mediaItem.tidalItem;
	const tidalAlbum = await mediaItem.album();
	// Without the TIDAL album the MusicBrainz album would decide folder, album and year, and that can be
	// another release entirely (Trophy by Bat For Lashes landed in a Windham Hill compilation). Callers retry later.
	if (tidalAlbum === undefined || (item.album?.id !== undefined && String(tidalAlbum.id) !== String(item.album.id))) {
		throw new Error(`TIDAL album ${item.album?.id ?? "?"} of track ${mediaItem.id} could not be loaded; not saving it with MusicBrainz album data.`);
	}
	let album = tidalAlbum.tidalAlbum;
	if (!album.upc) {
		const fullAlbum = await TidalApi.album(tidalAlbum.id).catch(() => undefined);
		if (fullAlbum?.upc) album = { ...album, upc: fullAlbum.upc };
	}
	const artists = item.artists?.map(({ name }) => name).filter(Boolean) ?? [];
	const featuredArtists = item.artists?.filter(({ type }) => type === "FEATURED").map(({ name }) => name).filter(Boolean) ?? [];
	const albumArtists = album?.artists?.map(({ name }) => name).filter(Boolean) ?? [];
	// flacTags() already resolved this lookup and brainzItem() is memoized: no extra MusicBrainz request.
	const brainzItem = await enrichedFrom.brainzItem().catch(() => undefined);
	const recordingIsrcs = brainzItem ? (brainzItem.recording?.isrcs ?? []) : null;
	// A RealMAX substitute with another ISRC was matched for a different track: its MusicBrainz data is not trusted.
	const brainzIsrcs = enrichedFrom.tidalItem.isrc === item.isrc ? recordingIsrcs : [];
	const evidence = { isrc: item.isrc, brainzIsrcs };
	const tags = selectTidalTags(enrichedTags, {
		title: item.title,
		version: item.version,
		trackNumber: item.trackNumber,
		volumeNumber: item.volumeNumber,
		artists,
		featuredArtists,
		isrc: item.isrc,
		brainzIsrcs,
		releaseDate: item.releaseDate,
		streamStartDate: item.streamStartDate,
		album: album && {
			title: album.title,
			version: album.version,
			artists: albumArtists,
			releaseDate: album.releaseDate,
			releaseYear: album.releaseYear,
			upc: album.upc,
		},
	});

	const mergedTags: ArchiveTagValues = { ...tags, ...tagOverrides };
	mergedTags.embeddedYear = selectEmbeddedYear(enrichedTags, mergedTags, evidence);
	const selectedAlbumTitle = String(mergedTags.album ?? album?.title ?? "Unknown Album");
	const selectedAlbumArtists = mergedTags.albumArtist ?? albumArtists ?? artists;
	const albumArtistNames = Array.isArray(selectedAlbumArtists) ? selectedAlbumArtists : [selectedAlbumArtists];
	const albumArtist = albumArtistNames.filter(Boolean)[0] ?? "Unknown Artist";
	const { archiveTitle, soundtrack } = normalizeEdition(album?.title ?? selectedAlbumTitle, album?.version, album?.genre);
	const compilation = !soundtrack && isVariousArtists(albumArtistNames.filter(Boolean));

	const otherReason = soundtrack || compilation ? undefined : await otherCompilationReason(tidalAlbum, settings.compilationList);
	mergedTags.libraryRoot = libraryRootFor({ soundtrack, variousArtists: compilation, otherCompilation: otherReason !== undefined, albumArtist });
	mergedTags.archiveAlbumArtist = compilation ? "Various Artists" : albumArtist;
	mergedTags.archiveAlbumTitle = archiveTitle;
	// Only technical markers go after the year (" [Atmos]", added later); editions are in the title.
	mergedTags.variantSuffix = formatVariantSuffix([]);
	return mergedTags;
};

export const applyTagFormat = (format: string, tags: ArchiveTagValues) =>
	format.replace(/\{([^{}]+)\}/g, (placeholder, tag: string) => {
		let tagValue = (tags as Record<string, string | string[] | undefined>)[tag];
		if (Array.isArray(tagValue)) tagValue = tagValue[0];
		if (tagValue === undefined) return placeholder;
		// " [Atmos]" or empty: keep the leading space and never turn an empty suffix into "Unknown".
		if (tag === "variantSuffix") return tagValue.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "");
		if (tag === "trackNumber") tagValue = tagValue.padStart(2, "0");
		// "!Compilations/Various Artists" is two folders: each part is sanitized on its own.
		if (tag === "libraryRoot") return tagValue.split("/").map(sanitizeLibraryComponent).join("/");
		return sanitizeLibraryComponent(tagValue);
	});

export const withAtmosVariant = (tags: ArchiveTagValues): ArchiveTagValues => ({
	...tags,
	variantSuffix: addEditionVariant(tags.variantSuffix, "Atmos"),
});

export const getEmbeddedTags = (tags: ArchiveTagValues): TagValues => {
	const embedded: Partial<TagValues> = {};
	const embeddedRecord = embedded as Record<string, string | string[] | undefined>;
	for (const tag of MediaItem.availableTags) {
		const value = tags[tag];
		if (value !== undefined) embeddedRecord[tag] = value;
	}
	if (tags.embeddedYear) embedded.year = tags.embeddedYear;
	return embedded as TagValues;
};

export const getDownloadFolder = async () => {
	const { canceled, filePaths } = await showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
	if (!canceled) return filePaths[0];
};
export const getDownloadPath = async (defaultPath: string) => {
	const { canceled, filePath } = await showSaveDialog({
		defaultPath,
		filters: [{ name: "", extensions: [defaultPath ?? "*"] }],
	});
	if (!canceled) return filePath;
};
export const getFileName = async (
	mediaItem: MediaItem,
	audioQuality?: redux.AudioQuality,
	tagOverrides?: Partial<TagValues>,
	multiDiscAlbum?: boolean,
	fileExtension?: string,
	preparedTags?: ArchiveTagValues,
) => {
	multiDiscAlbum ??= ((await mediaItem.album())?.tidalAlbum.numberOfVolumes ?? 1) > 1;
	const pathFormat = multiDiscAlbum ? settings.multiDiscPathFormat : settings.pathFormat;
	let fileName = `${pathFormat}.${fileExtension ?? (await mediaItem.fileExtension(audioQuality))}`;
	const { tags } = await mediaItem.flacTags();
	return applyTagFormat(fileName, preparedTags ?? (await getStablePathTags(mediaItem, tags, tagOverrides)));
};

/**
 * Keeps spatial downloads separate without changing their embedded album tag.
 * The last directory in the configured path is the album directory for the
 * default layout, so append the marker there instead of to every filename.
 */
export const addAtmosFolderSuffix = (fileName: string, multiDiscAlbum = false) => {
	const lastSeparatorIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
	if (lastSeparatorIndex < 0) return fileName;

	const albumSeparatorIndex = multiDiscAlbum
		? Math.max(fileName.lastIndexOf("/", lastSeparatorIndex - 1), fileName.lastIndexOf("\\", lastSeparatorIndex - 1))
		: lastSeparatorIndex;
	if (albumSeparatorIndex < 0) return fileName;
	const parentSeparatorIndex = Math.max(
		fileName.lastIndexOf("/", albumSeparatorIndex - 1),
		fileName.lastIndexOf("\\", albumSeparatorIndex - 1),
	);
	const albumFolder = fileName.slice(parentSeparatorIndex + 1, albumSeparatorIndex);
	if (!albumFolder || /\s\[Atmos\]$/i.test(albumFolder)) return fileName;
	return `${fileName.slice(0, albumSeparatorIndex)} [Atmos]${fileName.slice(albumSeparatorIndex)}`;
};

export const getCoverFileName = (tags: ArchiveTagValues) => {
	const formatted = applyTagFormat(settings.coverFileNameFormat, tags).trim();
	const fallback = [tags.archiveAlbumArtist, tags.archiveAlbumTitle, tags.year].filter(Boolean).join(" - ") || "cover";
	return `${sanitizeLibraryComponent(formatted || fallback)}.jpg`;
};

export const getCreditsFileName = (tags: ArchiveTagValues) => {
	const formatted = applyTagFormat(settings.creditsFileNameFormat, tags).trim();
	const fallback = [tags.archiveAlbumArtist, tags.archiveAlbumTitle, tags.year].filter(Boolean).join(" - ") || "album";
	return `${sanitizeLibraryComponent(formatted || `${fallback} - credits`)}.txt`;
};
