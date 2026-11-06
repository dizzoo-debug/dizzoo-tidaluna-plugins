import { MediaItem, type redux } from "@luna/lib";
import { showOpenDialog, showSaveDialog } from "@luna/lib.native";
import { settings } from "./Settings";

import {
	addEditionVariant,
	formatVariantSuffix,
	isVariousArtists,
	normalizeEdition,
	sanitizeLibraryComponent,
} from "./archiveLayout";

export type TagValues = Awaited<ReturnType<MediaItem["flacTags"]>>["tags"];
export type ArchiveTagValues = TagValues & {
	libraryRoot?: string;
	archiveAlbumArtist?: string;
	archiveAlbumTitle?: string;
	variantSuffix?: string;
};

export const formatTidalTitle = (title: string, version?: string | null) => {
	if (version && !title.toLowerCase().includes(version.toLowerCase())) return `${title} (${version})`;
	return title;
};

/**
 * MusicBrainz enrichment is useful inside the audio file, but it must never
 * decide the archive path: its availability and title punctuation can change
 * between launches. Paths are built from the raw TIDAL item and album instead.
 */
export const getStablePathTags = async (
	mediaItem: MediaItem,
	enrichedTags: TagValues,
	tagOverrides?: Partial<TagValues>,
): Promise<ArchiveTagValues> => {
	const item = mediaItem.tidalItem;
	const album = (await mediaItem.album())?.tidalAlbum;
	const tags: TagValues = { ...enrichedTags };
	const artists = item.artists?.map(({ name }) => name).filter(Boolean) ?? [];
	const albumArtists = album?.artists?.map(({ name }) => name).filter(Boolean) ?? [];
	const releaseDate = album?.releaseDate ?? item.releaseDate ?? item.streamStartDate;

	if (item.title) tags.title = formatTidalTitle(item.title, item.version);
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

	const mergedTags: ArchiveTagValues = { ...tags, ...tagOverrides };
	const selectedAlbumTitle = String(mergedTags.album ?? album?.title ?? "Unknown Album");
	const selectedAlbumArtists = mergedTags.albumArtist ?? albumArtists ?? artists;
	const albumArtistNames = Array.isArray(selectedAlbumArtists) ? selectedAlbumArtists : [selectedAlbumArtists];
	const albumArtist = albumArtistNames.filter(Boolean)[0] ?? "Unknown Artist";
	const { archiveTitle, soundtrack } = normalizeEdition(album?.title ?? selectedAlbumTitle, album?.version, album?.genre);
	const compilation = !soundtrack && isVariousArtists(albumArtistNames.filter(Boolean));

	mergedTags.libraryRoot = soundtrack ? "!OST" : compilation ? "Various Artists" : albumArtist;
	mergedTags.archiveAlbumArtist = compilation ? "Various Artists" : albumArtist;
	mergedTags.archiveAlbumTitle = archiveTitle;
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
