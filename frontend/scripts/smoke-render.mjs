// ─── Does every page actually RENDER? ────────────────────────────────────────────────────
//
// The gap this closes, in one sentence: `vite build` resolves the import graph but never
// evaluates a component, so a page that crashed on 100% of loads shipped through a green
// pre-push gate and sat broken for a day.
//
// That was 2026-08-04. `QuickBooks.jsx` read `s.qboSyncDirection` on line 649 while
// `const s = settings ?? {…}` was declared on line 802 — both in the render body, so every
// single render threw `ReferenceError: Cannot access 's' before initialization` before it
// reached the loading gate. The build was perfectly happy: every import resolved. Nothing
// else in the repo looks at the frontend, so there was no second chance.
//
// WHY react-dom/server. SSR executes the render body and skips effects, which is exactly the
// half where this class of bug lives and exactly the half that needs no backend, no browser
// and no fixtures. A component that throws while rendering throws here too. The one thing it
// deliberately cannot see is anything that only happens after mount — effects, event handlers,
// data-dependent re-renders — so this is a floor, not a substitute for testing behaviour.
//
// WHY ssrLoadModule rather than a build. Vite transforms and loads each module on demand, so
// there is no output directory to place, clean up, or accidentally point at the real dist/.
//
// Pages are DISCOVERED, not listed. A hand-written list is what made the error-classifier
// guard useless (it named 6 of 23 kinds and was green for weeks); a new page under src/pages/
// is covered here the moment it exists.

import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_DIR = path.join(ROOT, 'src', 'pages');

// Rendering a page outside its providers would fail on useAuth/useToast/useSearchParams for
// reasons that say nothing about the page, so each one is mounted in the same shell App.jsx
// gives it. MemoryRouter (not BrowserRouter) because there is no history in Node.
const HARNESS = `
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '/src/context/AuthProvider.jsx';
import { ToastProvider } from '/src/components/ui/toast.jsx';
import { createElement as h } from 'react';

export function render(Page, route) {
  return renderToString(
    h(MemoryRouter, { initialEntries: [route] },
      h(AuthProvider, null,
        h(ToastProvider, null, h(Page, null)))),
  );
}
`;

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { middlewareMode: true },
  logLevel: 'error',
  appType: 'custom',
});

// The harness has to live under root for its bare imports to resolve like any other module.
// Written next to the pages rather than into src/, and always removed again.
const harnessPath = path.join(PAGES_DIR, '__smoke_harness.jsx');
fs.writeFileSync(harnessPath, HARNESS);

let failures = 0;
let rendered = 0;

try {
  const { render } = await server.ssrLoadModule('/src/pages/__smoke_harness.jsx');

  const pages = fs.readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.jsx') && !f.startsWith('__'))
    .sort();

  if (pages.length === 0) {
    console.error('smoke-render: found no pages under src/pages — the check would be vacuous.');
    process.exit(1);
  }

  for (const file of pages) {
    const name = file.replace(/\.jsx$/, '');
    // Home is mounted at the index route; the rest at /buildbridge/<lowercased name>. Only
    // useSearchParams reads this, so an approximate route is fine — what matters is that a
    // Router is present.
    const route = name === 'Home' ? '/buildbridge' : `/buildbridge/${name.toLowerCase()}`;
    try {
      const mod = await server.ssrLoadModule(`/src/pages/${file}`);
      const Page = mod.default;
      if (typeof Page !== 'function') {
        console.error(`  ✗ ${name}: no default-exported component`);
        failures++;
        continue;
      }
      render(Page, route);
      rendered++;
    } catch (err) {
      // The message is the whole point — "Cannot access 's' before initialization" names the
      // binding, and the stack names the file.
      console.error(`  ✗ ${name} threw while rendering: ${err?.name}: ${err?.message}`);
      if (err?.stack) console.error(String(err.stack).split('\n').slice(1, 4).join('\n'));
      failures++;
    }
  }
} finally {
  fs.rmSync(harnessPath, { force: true });
  await server.close();
}

if (failures) {
  console.error(`\nsmoke-render: ${failures} page(s) cannot render. This is the check that the`);
  console.error('production build cannot do — a build resolves imports, it does not run components.');
  process.exit(1);
}
console.log(`smoke-render: ${rendered} page(s) render without throwing.`);
