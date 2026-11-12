import assert from "node:assert/strict";

import { hasUnofficialWords, labelDiffers, matchesManualList, mostlyOtherArtists } from "./compilationRules";

assert.equal(hasUnofficialWords("The Animals - All-Time Greatest Hits", "Rerecorded Version"), true);
assert.equal(hasUnofficialWords("A Tribute to Queen"), true);
assert.equal(hasUnofficialWords("The Next Episode (Originally Performed By Dr. Dre)"), true);
assert.equal(hasUnofficialWords("The Platinum Collection"), false);
assert.equal(hasUnofficialWords("Greatest Hits (Deluxe Edition)"), false);

assert.equal(matchesManualList("hotel costes\n\n", { artist: "Hôtel Costes", title: "Hôtel Costes 4" }), false);
assert.equal(matchesManualList("Hôtel Costes\n", { artist: "Hôtel Costes", title: "Hôtel Costes 4" }), true);
assert.equal(matchesManualList("Digital Gramophone", { artist: "X", title: "Y", copyright: "℗ 2012 Digital Gramophone" }), true);
assert.equal(matchesManualList("", { artist: "X", title: "Y" }), false);

// Queen: the collection and the studio albums share "queen" / "productions".
const queenOwn = ["℗ 1975 Queen Productions Ltd, under exclusive licence to Universal International Music BV"];
assert.equal(labelDiffers("℗ 2000 Queen Productions Ltd under exclusive licence to EMI", queenOwn), false);
// A budget label with nothing in common.
assert.equal(labelDiffers("℗ 2009 Digital Gramophone", ["℗ 1964 ABKCO Music & Records, Inc."]), true);
// Unknown: nothing to compare.
assert.equal(labelDiffers(undefined, queenOwn), false);
assert.equal(labelDiffers("℗ 2009 Digital Gramophone", []), false);

// Hôtel Costes: a mix of other artists' tracks; Moloko's Catalogue is Moloko's own.
assert.equal(mostlyOtherArtists(["Hôtel Costes"], [["Pink Martini"], ["Bebel Gilberto"], ["Hôtel Costes", "X"]]), true);
assert.equal(mostlyOtherArtists(["Moloko"], [["Moloko"], ["Moloko"], ["Róisín Murphy"]]), false);
assert.equal(mostlyOtherArtists(["Queen"], [["Queen", "David Bowie"], ["Queen"]]), false);

console.log("compilationRules tests passed");
