#!/usr/bin/env node
// ─── Only main ships ─────────────────────────────────────────────────────────────────────
//
// `npm run deploy` and `npm run cf:deploy` run this BEFORE the build, and it refuses unless
// what is about to go live is exactly what is on main on GitHub:
//
//   1. origin is the BuildBridge repository on GitHub,
//   2. HEAD is the commit main points at on GitHub RIGHT NOW, and
//   3. the working tree is clean: nothing modified, staged, deleted or untracked.
//
// Exit 0 = go. Exit 1 = refused, with every problem listed at once so one pass fixes them all.
//
// WHY. From about 2026-09-06 to 2026-10-01 production ran a July feature branch
// (feature/idearoom-integration) instead of main. Same Worker name, same route, so the deploy
// simply replaced main, and verify:deploy passed because the page loaded fine. That branch's
// access check skipped every location: for three and a half weeks every IdeaRoom lead was
// marked processed with nothing sent, and the other locations ran July's code too. Nothing in
// the deploy asked which commit it was shipping, and who ran it is not recorded anywhere.
//
// WHY EACH CHECK.
// * Main on GitHub, not refs/remotes/origin/main. That ref is only as fresh as this clone's
//   last fetch. A checkout that last fetched a week ago would pass a local compare and quietly
//   roll production back past everything merged since. So the guard asks GitHub
//   (`git ls-remote`), which also means it fails closed: no answer from GitHub, no deploy.
// * origin is GitHub. A clone of another clone has origin pointing at that folder, whose main
//   can be anything. "HEAD == origin/main" means nothing until origin is the real repo.
// * Clean tree. wrangler bundles the files on disk, not the commit. An edited or untracked file
//   ships even when HEAD is right, and then nothing in git says what is live. Ignored files
//   (node_modules, frontend/dist, .env) are not counted: the deploy rebuilds dist, the
//   lockfile pins node_modules, and .env never ships.
//
// WHAT IT CANNOT COVER. It lives in package.json, so it guards the checkouts that contain it.
// A branch cut before it existed (feature/idearoom-integration is one) carries its own
// package.json without it, and a bare `npx wrangler deploy` skips npm scripts entirely.
//
// No bypass flag, on purpose. To ship a change, land it on main first. To put an earlier
// version back live, use `npx wrangler rollback`: it re-activates a previous upload without
// building anything. Never deploy an old commit to roll back.
//
// Read-only. `git status` runs with --no-optional-locks so it never rewrites the index under a
// session sharing this checkout, and ls-remote only asks where main is: no fetch, no ref
// written, nothing downloaded.

import { checkDeploySource, DEPLOY_BRANCH } from './deploy-source.mjs';

// No `if (this is the main module)` test here: see deploy-source.mjs for why. If anything below
// throws, node exits non-zero and the deploy stops, which is the direction to fail in.
const { ok, problems, facts } = await checkDeploySource();
if (ok) {
  console.log(
    `predeploy: ok — deploying ${facts.head.slice(0, 7)}, which is ${DEPLOY_BRANCH} on GitHub, from a clean tree.`,
  );
} else {
  console.error(`\npredeploy: refused — only ${DEPLOY_BRANCH} on GitHub, from a clean tree, goes to production.\n`);
  for (const p of problems) console.error(`  * ${p}\n`);
  process.exitCode = 1;
}
