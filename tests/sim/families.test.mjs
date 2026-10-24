// The luck test's number of tries comes from lab_settings.families (counted nightly), and is never guessed.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { familiesFor } from "./lab.mjs";

const sb = createClient();
const daily = { rules: { daily: true } }, intra = { rules: {} };
db.lab_settings = [{ id: 1, families: null }];
await assert.rejects(familiesFor(sb, daily), /rule-family counts not available/);
db.lab_settings = [{ id: 1, families: { "*|DAILY": 5219, "*|INTRADAY": 8874, "GOLD|DAILY": 1133 } }];
assert.equal(await familiesFor(sb, daily), 5219);
assert.equal(await familiesFor(sb, intra), 8874);
console.log("ok   rule-family counts read from lab_settings; missing counts stop the verdict instead of using 10");
