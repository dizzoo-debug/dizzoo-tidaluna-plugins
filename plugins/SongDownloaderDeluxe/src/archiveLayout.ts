export type EditionVariant = "Deluxe" | "Super Deluxe" | "Remastered" | "Atmos";

const variantPatterns: Array<{ variant: Exclude<EditionVariant, "Atmos">; pattern: RegExp }> = [
	{ variant: "Super Deluxe", pattern: /\bsuper\s+deluxe(?:\s+edition)?\b/gi },
	{ variant: "Deluxe", pattern: /\bdeluxe(?:\s+edition)?\b/gi },
	{ variant: "Remastered", pattern: /\b(?:remaster(?:ed)?|\d{4}\s+remaster)\b/gi },
];

const soundtrackPattern =
	/\b(?:soundtrack|original\s+(?:motion\s+picture|film|television|tv|game)\s+(?:soundtrack|score)|music\s+from\s+(?:the\s+)?(?:motion\s+picture|film|television|tv|game)|film\s+score)\b/i;

const tidyEditionTitle = (value: string) =>
	value
		.replace(/\(\s*\)/g, "")
		.replace(/\[\s*\]/g, "")
		.replace(/\s+(?:-|–|—|:)\s*$/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

export const normalizeEdition = (title: string, version?: string | null) => {
	const variants: EditionVariant[] = [];
	let archiveTitle = title.trim();
	const editionText = `${title} ${version ?? ""}`;

	for (const { variant, pattern } of variantPatterns) {
		pattern.lastIndex = 0;
		if (!pattern.test(editionText)) continue;
		if (variant === "Deluxe" && variants.includes("Super Deluxe")) {
			pattern.lastIndex = 0;
			archiveTitle = archiveTitle.replace(pattern, "");
			continue;
		}
		variants.push(variant);
		pattern.lastIndex = 0;
		archiveTitle = archiveTitle.replace(pattern, "");
	}

	archiveTitle = tidyEditionTitle(archiveTitle);
	return { archiveTitle: archiveTitle || title.trim(), variants };
};

export const isSoundtrackRelease = (title: string, version?: string | null, genre?: string | null) =>
	soundtrackPattern.test(`${title} ${version ?? ""} ${genre ?? ""}`);

export const isVariousArtists = (artists: string[]) =>
	artists.some((artist) => /^(?:various\s+artists|v\.\s*a\.)$/i.test(artist.trim()));

export const formatVariantSuffix = (variants: EditionVariant[]) =>
	[...new Set(variants)].map((variant) => ` [${variant}]`).join("");

export const addEditionVariant = (suffix: string | undefined, variant: EditionVariant) => {
	const marker = `[${variant}]`;
	if (suffix?.toLowerCase().includes(marker.toLowerCase())) return suffix;
	return `${suffix ?? ""} ${marker}`;
};

export const sanitizeLibraryComponent = (value: string) => {
	const replacedSeparators = value.replace(/[:/\\]/g, " -");
	const withoutInvalid = replacedSeparators.replace(/[<>"|?*\u0000-\u001f]/g, "");
	const normalized = withoutInvalid.replace(/\s{2,}/g, " ").replace(/[. ]+$/g, "").trim();
	return normalized || "Unknown";
};

