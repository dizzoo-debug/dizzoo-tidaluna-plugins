import type { PlaybackInfo } from "@luna/lib";

// TIDAL serves Dolby Atmos only to some of its apps, not to the desktop app. This public build has no
// Atmos sign-in; a local build may replace this file with one.
export const atmosAvailable = false;
export const hasAtmosLogin = () => false;
export const signOutAtmos = async () => {};
export const signInAtmos = async (_onLink: (link: { verificationUri: string; userCode: string }) => void): Promise<void> => {
	throw new Error("Dolby Atmos sign-in is not part of this build");
};
export const getAtmosPlaybackInfo = async (_trackId: string | number): Promise<PlaybackInfo | undefined> => undefined;
