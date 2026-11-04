import assert from "node:assert/strict";

import { formatDownloadLogLine } from "./downloadLog";

const at = new Date(2026, 10, 5, 0, 30, 0);
const base = { source: "collection" as const, artist: "Kings Of Leon", album: "Aha Shake Heartbreak", title: "Milk", trackId: 119476578 };

const hiRes = formatDownloadLogLine(
	{ ...base, status: "downloaded", requested: "HI_RES_LOSSLESS", delivered: { audioQuality: "HI_RES_LOSSLESS", audioMode: "STEREO", bitDepth: 24, sampleRate: 96000 }, file: ["D:\\!Music", "Kings Of Leon\\05 - Milk.flac"] },
	at,
);
assert.equal(
	hiRes,
	"2026-11-05 00:30:00,downloaded,yes,Hi-Res Lossless 24-bit/96kHz,Hi-Res Lossless,collection,Kings Of Leon,Aha Shake Heartbreak,Milk,119476578,D:\\!Music\\Kings Of Leon\\05 - Milk.flac,",
);

// Lossy delivery is flagged so it can be filtered on.
assert.match(formatDownloadLogLine({ ...base, status: "downloaded", delivered: { audioQuality: "HIGH", audioMode: "STEREO" } }, at), /,downloaded,NO,High \(AAC\),/);
assert.match(formatDownloadLogLine({ ...base, status: "downloaded", delivered: { audioQuality: "LOW", audioMode: "DOLBY_ATMOS" } }, at), /,no \(Dolby Atmos\),Dolby Atmos,/);

// Failures keep their reason, quoted when it contains commas.
assert.match(formatDownloadLogLine({ ...base, status: "failed", details: "Error: 403, Forbidden" }, at), /,failed,,,.*,"Error: 403, Forbidden"$/);

console.log("Song Downloader log tests passed");
