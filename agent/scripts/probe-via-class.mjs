import { Browser } from "/repo/agent/dist/browser/stagehand.js";

const target = process.env.TARGET_URL || "http://blog/";
const browser = new Browser();
console.log("[probe] launch");
const launch = await browser.launch({ headless: true });
console.log("[probe] launch result:", launch.ok ? "ok" : `err=${launch.error.message}`);

console.log("[probe] navigate");
const nav = await browser.navigate(target);
console.log("[probe] navigate result:", JSON.stringify(nav));

console.log("[probe] extractLinks");
const links = await browser.extractLinks();
console.log("[probe] extractLinks result:", JSON.stringify(links));

await browser.close();
