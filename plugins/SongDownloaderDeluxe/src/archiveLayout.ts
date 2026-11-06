/** Technical markers written in square brackets after the year: "Album (2003) [Hi-Res] [RealMAX]". */
export type EditionVariant = "Atmos" | "Hi-Res" | "AAC" | "RealMAX";
const variantOrder: EditionVariant[] = ["Atmos", "Hi-Res", "AAC", "RealMAX"];

/**
 * The markers for what was actually delivered: Atmos for a Dolby Atmos stream, AAC for a lossy
 * stream, Hi-Res for a 24-bit FLAC, and RealMAX when RealMAX swapped in another release's track.
 */
export const technicalVariants = (stream: { atmos: boolean; lossy: boolean; bitDepth?: number | null; realMax: boolean }) => {
	const variants: EditionVariant[] = [];
	if (stream.atmos) variants.push("Atmos");
	else if (stream.lossy) variants.push("AAC");
	else if ((stream.bitDepth ?? 0) >= 24) variants.push("Hi-Res");
	if (stream.realMax) variants.push("RealMAX");
	return variants;
};

/** Editions stay in the album title as "(Deluxe Edition)", "(Super Deluxe Edition)" or "(Remastered)". */
const editionPatterns: Array<{ edition: string; pattern: RegExp }> = [
	{ edition: "Super Deluxe Edition", pattern: /\bsuper\s+deluxe(?:\s+(?:edition|version))?\b/gi },
	{ edition: "Deluxe Edition", pattern: /\bdeluxe(?:\s+(?:edition|version))?\b/gi },
	{ edition: "Remastered", pattern: /\b(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+(?:edition|version))?\b/gi },
];

const soundtrackPattern =
	/\b(?:soundtrack|original\s+(?:motion\s+picture|film|television|tv|game)\s+(?:soundtrack|score)|music\s+from\s+(?:the\s+)?(?:motion\s+picture|film|television|tv|game)|film\s+score)\b/i;

// "(Original Motion Picture Soundtrack)", ": Music from the Motion Picture", "- OST" and the like.
const soundtrackPhrase = String.raw`(?:the\s+)?(?:original\s+)?(?:(?:motion\s+picture|film|movie|television|tv|series|game|video\s+game)\s+)?(?:soundtrack|score)(?:\s+album)?|music\s+from\s+(?:and\s+inspired\s+by\s+)?(?:the\s+)?(?:original\s+)?(?:motion\s+picture|film|movie|television(?:\s+series)?|tv(?:\s+series)?|series|video\s+game|game)(?:\s+soundtrack)?|o\.?s\.?t\.?`;
// Any bracket group naming the soundtrack or score goes too: "(Adult Swim Original Series Soundtrack)".
const soundtrackSuffixPattern = new RegExp(
	String.raw`\s*(?:[([][^()[\]]*\b(?:soundtrack|score|ost)\b[^()[\]]*[)\]]|[([]\s*(?:${soundtrackPhrase})\s*[)\]]|(?:\s-|:)\s*(?:${soundtrackPhrase})\s*$)`,
	"gi",
);

const dashes = /[‐-―]/g;

const tidyEditionTitle = (value: string) =>
	value
		.replace(/([([])\s+/g, "$1")
		.replace(/\s+([)\]])/g, "$1")
		.replace(/\(\s*\)/g, "")
		.replace(/\[\s*\]/g, "")
		.replace(/\s+(?:-|:)\s*$/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

/**
 * A slash cannot be in a file name, so "16/03/1961" becomes "16.03.1961" as written. Every other
 * date form is left alone. Only archive paths use this; embedded tags keep the TIDAL title.
 */
export const formatTitleDates = (value: string) => value.replace(/\b(\d{1,4})\/(\d{1,2})\/(\d{1,4})\b/g, "$1.$2.$3");

export const isSoundtrackRelease = (title: string, version?: string | null, genre?: string | null) =>
	soundtrackPattern.test(`${title} ${version ?? ""} ${genre ?? ""}`);

/**
 * The album title used in archive paths: "Frank (Deluxe Edition)", "Baraka [Soundtrack]",
 * "Live 16.03.1961". Edition wording is normalized, dates use dots and long dashes become "-".
 */
export const normalizeEdition = (title: string, version?: string | null, genre?: string | null) => {
	const editions: string[] = [];
	const plainTitle = title.trim().replace(dashes, "-");
	let archiveTitle = plainTitle;
	const editionText = `${title} ${version ?? ""}`;

	for (const { edition, pattern } of editionPatterns) {
		pattern.lastIndex = 0;
		if (!pattern.test(editionText)) continue;
		// "(10th Anniversary Deluxe Edition)" already names the edition in parentheses: keep it whole.
		const ownGroup = [...archiveTitle.matchAll(/\(([^()]*)\)/g)].find((group) => {
			pattern.lastIndex = 0;
			return pattern.test(group[1]) && group[1].replace(pattern, "").trim() !== "";
		});
		if (ownGroup) continue;
		pattern.lastIndex = 0;
		const written = editionText.match(pattern)?.[0].replace(/\s+/g, " ").trim();
		pattern.lastIndex = 0;
		archiveTitle = archiveTitle.replace(pattern, "");
		if (edition === "Deluxe Edition" && editions.includes("Super Deluxe Edition")) continue;
		// A remaster with a known year keeps its wording: "(Remastered 2009)", "(2012 Remaster)".
		editions.push(edition === "Remastered" && written && /\d{4}/.test(written) ? written : edition);
	}

	const soundtrack = isSoundtrackRelease(title, version, genre);
	if (soundtrack) archiveTitle = archiveTitle.replace(soundtrackSuffixPattern, "");
	archiveTitle = tidyEditionTitle(formatTitleDates(archiveTitle)) || plainTitle;
	archiveTitle += editions.map((edition) => ` (${edition})`).join("");
	if (soundtrack) archiveTitle += " [Soundtrack]";
	return { archiveTitle, editions, soundtrack };
};

export const isVariousArtists = (artists: string[]) =>
	artists.some((artist) => /^(?:various\s+artists|v\.\s*a\.)$/i.test(artist.trim()));

export const formatVariantSuffix = (variants: EditionVariant[]) =>
	variantOrder
		.filter((variant) => variants.includes(variant))
		.map((variant) => ` [${variant}]`)
		.join("");

/**
 * Appends the markers the album folder does not already carry, for path formats without
 * {variantSuffix}. The album folder is the last directory, or the one above CD1 for multi-disc.
 */
export const addFolderVariants = (fileName: string, variants: EditionVariant[], multiDiscAlbum = false) => {
	const lastSeparatorIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
	if (lastSeparatorIndex < 0 || variants.length === 0) return fileName;
	const albumSeparatorIndex = multiDiscAlbum
		? Math.max(fileName.lastIndexOf("/", lastSeparatorIndex - 1), fileName.lastIndexOf("\\", lastSeparatorIndex - 1))
		: lastSeparatorIndex;
	if (albumSeparatorIndex < 0) return fileName;
	const parentSeparatorIndex = Math.max(fileName.lastIndexOf("/", albumSeparatorIndex - 1), fileName.lastIndexOf("\\", albumSeparatorIndex - 1));
	const albumFolder = fileName.slice(parentSeparatorIndex + 1, albumSeparatorIndex).toLowerCase();
	if (!albumFolder) return fileName;
	const missing = formatVariantSuffix(variants.filter((variant) => !albumFolder.includes(`[${variant.toLowerCase()}]`)));
	return `${fileName.slice(0, albumSeparatorIndex)}${missing}${fileName.slice(albumSeparatorIndex)}`;
};

export const addEditionVariant = (suffix: string | undefined, variant: EditionVariant) => {
	const marker = `[${variant}]`;
	if (suffix?.toLowerCase().includes(marker.toLowerCase())) return suffix;
	return `${suffix ?? ""} ${marker}`;
};

export const sanitizeLibraryComponent = (value: string) => {
	const replacedSeparators = value.replace(dashes, "-").replace(/[:/\\]/g, " -");
	const withoutInvalid = replacedSeparators.replace(/[<>"|?*\u0000-\u001f]/g, "");
	const normalized = withoutInvalid.replace(/\s{2,}/g, " ").replace(/[. ]+$/g, "").trim();
	return normalized || "Unknown";
};
