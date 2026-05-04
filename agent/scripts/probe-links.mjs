import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const target = process.env.TARGET_URL || "http://blog/";
const stagehand = new Stagehand({
  env: "LOCAL",
  model: {
    modelName: "openai/gemma4:e4b",
    apiKey: process.env.LLM_API_KEY || "ollama",
    baseURL: process.env.LLM_BASE_URL || "http://host.docker.internal:11434/v1",
  },
  localBrowserLaunchOptions: {
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  },
  verbose: 0,
  selfHeal: true,
});
await stagehand.init();
const page = stagehand.context.pages()[0];

console.log("[probe] goto", target);
await page.goto(target, { timeoutMs: 30000 });

// Reproduce the agent waitForSettled call:
console.log("[probe] running waitForSettled-style evaluate");
try {
  await page.evaluate(`
    new Promise(resolve => {
      const undefinedEls = document.querySelectorAll(':not(:defined)');
      const promises = [...undefinedEls].map(el => customElements.whenDefined(el.localName));
      Promise.all(promises).then(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          Promise.resolve().then(resolve);
        }));
      });
      setTimeout(resolve, 3000);
    })
  `);
  console.log("[probe] waitForSettled ok");
} catch (e) {
  console.log("[probe] waitForSettled threw:", String(e));
}

// Reproduce extractLinks raw eval:
console.log("[probe] running extractLinks-style evaluate");
try {
  const links = await page.evaluate(`
    (function() {
      const hrefs = new Set();
      const urlRe = /https?:\\/\\/[^\\s"'<>)\\]]+/g;
      function walkLinks(root) {
        for (const a of root.querySelectorAll('a[href]')) {
          if (a.href && a.href.startsWith('http')) hrefs.add(a.href);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walkLinks(el.shadowRoot);
        }
      }
      function walkText(root) {
        for (const node of root.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const matches = node.textContent.match(urlRe);
            if (matches) matches.forEach(u => hrefs.add(u));
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
            if (node.shadowRoot) walkText(node.shadowRoot);
            walkText(node);
          }
        }
      }
      walkLinks(document);
      walkText(document.body);
      return [...hrefs];
    })()
  `);
  console.log("[probe] extractLinks raw eval result:", JSON.stringify(links));
} catch (e) {
  console.log("[probe] extractLinks raw eval threw:", String(e));
}

// Stagehand-extract route:
console.log("[probe] running stagehand.extract");
try {
  const out = await stagehand.extract(
    "Return every same-origin href visible on the page (including in nav/menus).",
    z.object({
      links: z.array(z.string()).describe("absolute http(s) URLs"),
    }),
  );
  console.log("[probe] stagehand.extract:", JSON.stringify(out));
} catch (e) {
  console.log("[probe] stagehand.extract threw:", String(e));
}

await stagehand.close();
