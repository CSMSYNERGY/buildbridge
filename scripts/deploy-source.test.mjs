// The predeploy guard: only main on GitHub, from a clean tree, goes to production.
//
// Three layers. The pure verdict (evaluateDeploySource and its two parsers) is tested on facts
// alone. Then the real thing against real git: a bare repository stands in for GitHub, each test
// clones it the way a deployer would, and `url.<bare>.insteadOf` sends the GitHub URL to that
// bare repo, so the clone's configured origin is the real GitHub URL while every byte stays on
// this disk. Last, package.json is read to prove `npm run deploy` actually runs the guard first.
//
// Hermetic: no network, no global or system git config (a developer's signing key, hooks path or
// insteadOf rules cannot leak in), and every inherited GIT_* variable is dropped. That last one is
// load-bearing: the pre-push hook runs these tests, git exports GIT_DIR to hooks, and without the
// scrub the fixture commands below would run against THIS repository instead of the sandbox.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeRepoUrl,
  parseLsRemote,
  evaluateDeploySource,
  inspectDeploySource,
  checkDeploySource,
  redactUrlCredentials,
  DEPLOY_REPO,
} from './deploy-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const GUARD = path.join(HERE, 'predeploy-guard.mjs');
const GITHUB_URL = 'https://github.com/CSMSYNERGY/buildbridge.git';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const good = (over = {}) => ({
  isRepo: true,
  head: SHA_A,
  branch: 'main',
  status: [],
  originUrl: GITHUB_URL,
  remoteMain: { sha: SHA_A },
  relation: null,
  ...over,
});

describe('normalizeRepoUrl', () => {
  it('reads every spelling of the BuildBridge repo as the same repo', () => {
    for (const url of [
      'https://github.com/CSMSYNERGY/buildbridge.git',
      'https://github.com/CSMSYNERGY/buildbridge',
      'https://github.com/csmsynergy/buildbridge/',
      'https://someone@github.com/CSMSYNERGY/buildbridge.git',
      'git@github.com:CSMSYNERGY/buildbridge.git',
      'ssh://git@github.com/CSMSYNERGY/buildbridge.git',
      'ssh://git@github.com:22/CSMSYNERGY/buildbridge',
      '  https://github.com/CSMSYNERGY/buildbridge.git\n',
    ]) {
      expect(normalizeRepoUrl(url), url).toBe(DEPLOY_REPO);
    }
  });

  it('does not mistake a fork, a look-alike or a sub-path for it', () => {
    expect(normalizeRepoUrl('https://github.com/someone/buildbridge.git')).not.toBe(DEPLOY_REPO);
    expect(normalizeRepoUrl('https://github.com/CSMSYNERGY/buildbridge-old.git')).not.toBe(DEPLOY_REPO);
    expect(normalizeRepoUrl('https://github.com/CSMSYNERGY/buildbridge/extra')).not.toBe(DEPLOY_REPO);
    expect(normalizeRepoUrl('https://gitlab.com/CSMSYNERGY/buildbridge.git')).not.toBe(DEPLOY_REPO);
  });

  it('returns null for local folders, which is what a clone of a clone points at', () => {
    for (const url of [
      'C:/work/buildbridge',
      'C:\\work\\buildbridge',
      '/home/someone/buildbridge.git',
      '../buildbridge',
      'file:///C:/work/buildbridge.git',
      '',
      null,
      undefined,
    ]) {
      expect(normalizeRepoUrl(url), String(url)).toBeNull();
    }
  });
});

describe('parseLsRemote', () => {
  it('takes the sha printed for refs/heads/main', () => {
    expect(parseLsRemote(`${SHA_A}\trefs/heads/main\n`)).toBe(SHA_A);
    expect(parseLsRemote(`${SHA_A.toUpperCase()}\trefs/heads/main\r\n`)).toBe(SHA_A);
  });

  it('ignores branches whose names merely contain main', () => {
    const out = [`${SHA_B}\trefs/heads/main-old`, `${SHA_B}\trefs/heads/feature/main`, `${SHA_A}\trefs/heads/main`].join('\n');
    expect(parseLsRemote(out)).toBe(SHA_A);
    expect(parseLsRemote(`${SHA_B}\trefs/heads/main-old\n`)).toBeNull();
  });

  it('returns null for empty or garbled output', () => {
    expect(parseLsRemote('')).toBeNull();
    expect(parseLsRemote(undefined)).toBeNull();
    expect(parseLsRemote('not-a-sha\trefs/heads/main')).toBeNull();
  });
});

describe('evaluateDeploySource', () => {
  it('passes a clean checkout whose HEAD is main on GitHub', () => {
    expect(evaluateDeploySource(good())).toEqual({ ok: true, problems: [] });
  });

  it('passes a detached HEAD at the same commit, and compares shas case-blind', () => {
    expect(evaluateDeploySource(good({ branch: null })).ok).toBe(true);
    expect(evaluateDeploySource(good({ head: SHA_A.toUpperCase() })).ok).toBe(true);
  });

  it('refuses outside a git checkout', () => {
    const v = evaluateDeploySource({ isRepo: false });
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/not a git checkout/);
  });

  it('refuses a dirty tree and names the files', () => {
    const v = evaluateDeploySource(good({ status: [' M src/worker.js', '?? scratch.js'] }));
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/2 uncommitted changes/);
    expect(v.problems[0]).toContain('src/worker.js');
    expect(v.problems[0]).toContain('scratch.js');
  });

  it('lists the first ten dirty paths and counts the rest', () => {
    const status = Array.from({ length: 13 }, (_, i) => `?? file-${i}.js`);
    const [p] = evaluateDeploySource(good({ status })).problems;
    expect(p).toContain('file-9.js');
    expect(p).not.toContain('file-10.js');
    expect(p).toContain('…and 3 more');
  });

  it('refuses a HEAD behind main and says it would roll production back', () => {
    const v = evaluateDeploySource(good({ head: SHA_B, relation: { kind: 'behind', count: 3 } }));
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/3 commits ahead of it/);
    expect(v.problems[0]).toMatch(/roll production back/);
    expect(v.problems[0]).toContain('wrangler rollback');
  });

  it('refuses work that is not on main yet', () => {
    const v = evaluateDeploySource(good({ head: SHA_B, branch: 'feature/x', relation: { kind: 'ahead', count: 1 } }));
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain('branch feature/x');
    expect(v.problems[0]).toMatch(/1 commit that is not on main/);
  });

  it('refuses when main on GitHub is a commit this checkout has never fetched', () => {
    const v = evaluateDeploySource(good({ head: SHA_B, relation: { kind: 'unfetched' } }));
    expect(v.problems[0]).toMatch(/has not even fetched/);
  });

  it('refuses a diverged HEAD, and a mismatch with no relation worked out', () => {
    expect(evaluateDeploySource(good({ head: SHA_B, relation: { kind: 'diverged' } })).problems[0]).toMatch(/separate ways/);
    expect(evaluateDeploySource(good({ head: SHA_B, relation: null })).ok).toBe(false);
  });

  it('fails closed when GitHub cannot be asked', () => {
    const v = evaluateDeploySource(good({ remoteMain: { error: 'git ls-remote failed: could not resolve host' } }));
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/Could not ask GitHub/);
    expect(v.problems[0]).toContain('could not resolve host');
  });

  it('refuses an origin that is not the BuildBridge repo, without piling a commit complaint on top', () => {
    const v = evaluateDeploySource(good({ originUrl: 'C:/work/buildbridge', remoteMain: { error: 'not asked' } }));
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain('C:/work/buildbridge');
    expect(v.problems[0]).toContain(DEPLOY_REPO);
  });

  it('never prints the credentials in an origin URL, while still naming the repo', () => {
    // A clone made with a token in its URL keeps that token in remote.origin.url, and this
    // refusal goes to the terminal and any deploy log. Fake token, fake owner.
    const token = 'ghp_FAKEFAKEFAKE123';
    const v = evaluateDeploySource(good({
      originUrl: `https://someone:${token}@github.com/someone/buildbridge.git`,
      remoteMain: { error: 'not asked' },
    }));
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).not.toContain(token);
    expect(v.problems.join('\n')).not.toContain('someone:');
    expect(v.problems[0]).toContain('https://***@github.com/someone/buildbridge.git');

    // A token as the whole userinfo, and a git error that quotes the URL, are hidden the same way.
    const err = evaluateDeploySource(good({
      originUrl: `https://${token}@github.com/CSMSYNERGY/buildbridge.git`,
      remoteMain: { error: `git ls-remote failed: unable to access 'https://${token}@github.com/CSMSYNERGY/buildbridge.git/'` },
    }));
    expect(err.ok).toBe(false);
    expect(err.problems.join('\n')).not.toContain(token);
    expect(err.problems[0]).toMatch(/Could not ask GitHub/);
  });

  it('redacts only the credentials: scp-style remotes and plain text pass through', () => {
    expect(redactUrlCredentials('git@github.com:CSMSYNERGY/buildbridge.git')).toBe('git@github.com:CSMSYNERGY/buildbridge.git');
    expect(redactUrlCredentials('ssh://git@github.com/x/y')).toBe('ssh://***@github.com/x/y');
    expect(redactUrlCredentials('could not resolve host')).toBe('could not resolve host');
    expect(redactUrlCredentials(null)).toBe('');
  });

  it('refuses a checkout with no origin at all', () => {
    const v = evaluateDeploySource(good({ originUrl: null, remoteMain: { error: 'not asked' } }));
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/no "origin" remote/);
  });

  it('refuses a HEAD with no commit', () => {
    expect(evaluateDeploySource(good({ head: null })).problems[0]).toMatch(/does not point at a commit/);
  });

  it('reports every problem in one pass', () => {
    const v = evaluateDeploySource(
      good({ head: SHA_B, relation: { kind: 'behind', count: 1 }, status: [' M package.json'] }),
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(2);
  });
});

// ─── Real git ────────────────────────────────────────────────────────────────────────────
//
// Every test gets its OWN "GitHub" (a bare clone of one template), so they can run side by
// side without one test's push moving main under another. Concurrency is the point: on Windows
// each git call costs ~60 ms and these tests make well over a hundred of them, so run one after
// another they would add about twenty seconds to every push.

describe.concurrent('against real git repositories', { timeout: 30_000 }, () => {
  let tmp;
  let template;
  let env;
  let n = 0;

  const run = (file, args, cwd) =>
    new Promise((resolve) => {
      execFile(file, args, { cwd, env, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) =>
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      );
    });
  const git = async (cwd, ...args) => {
    const r = await run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (dir, rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const slash = (p) => p.replace(/\\/g, '/');

  // A fresh "GitHub" for one test: a bare copy of the template, main at the first commit.
  async function newGithub() {
    const gh = path.join(tmp, `github-${++n}.git`);
    await git(tmp, 'clone', '--quiet', '--bare', template, gh);
    return gh;
  }

  // A deployer's clone of GitHub. The clone records origin as the real GitHub URL, and the
  // insteadOf rule it carries sends that URL to this test's bare repo.
  // `github: false` clones the folder directly, the way a clone of another checkout looks.
  async function cloneAsDeployer(gh, { github = true } = {}) {
    const dir = path.join(tmp, `work-${++n}`);
    if (github) {
      const rule = `url.${slash(gh)}.insteadOf=${GITHUB_URL}`;
      await git(tmp, '-c', rule, 'clone', '--quiet', '--config', rule, GITHUB_URL, dir);
    } else {
      await git(tmp, 'clone', '--quiet', gh, dir);
    }
    return dir;
  }

  // Someone else lands a commit on main on GitHub after the deployer's clone last fetched.
  async function landOnMainElsewhere(gh, name) {
    const sha = await git(gh, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', name);
    await git(gh, 'update-ref', 'refs/heads/main', sha);
    return sha;
  }

  const commitLocally = (dir, name) => git(dir, 'commit', '--quiet', '--allow-empty', '-m', name);
  const check = (dir) => checkDeploySource({ cwd: dir, env });
  const runGuard = (dir) => run(process.execPath, [GUARD], dir);

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-predeploy-')));
    const emptyConfig = path.join(tmp, 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');

    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: tmp,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'predeploy test',
      GIT_AUTHOR_EMAIL: 'predeploy-test@example.invalid',
      GIT_COMMITTER_NAME: 'predeploy test',
      GIT_COMMITTER_EMAIL: 'predeploy-test@example.invalid',
    });

    template = path.join(tmp, 'template.git');
    await git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', template);
    const seed = path.join(tmp, 'seed');
    await git(tmp, 'init', '--quiet', '--initial-branch=main', seed);
    write(seed, '.gitignore', 'node_modules/\nfrontend/dist/\n');
    write(seed, 'src/worker.js', 'export default {};\n');
    write(seed, 'src/a.js', 'export const a = 1;\n');
    write(seed, 'src/b.js', 'export const b = 2;\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '--quiet', '-m', 'first');
    await git(seed, 'push', '--quiet', template, 'main');
  }, 60_000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('passes a fresh clone of main, and a detached HEAD at main; the command exits 0', async () => {
    const dir = await cloneAsDeployer(await newGithub());
    const v = await check(dir);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.facts.originUrl).toBe(GITHUB_URL);
    expect(v.facts.branch).toBe('main');
    expect(v.facts.remoteMain.sha).toBe(await git(dir, 'rev-parse', 'HEAD'));

    const r = await runGuard(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/predeploy: ok/);

    await git(dir, 'switch', '--quiet', '--detach', 'origin/main');
    const d = await check(dir);
    expect(d.facts.branch).toBeNull();
    expect(d.ok).toBe(true);
  });

  it('refuses when main moved on GitHub though the local origin/main still matches HEAD, and never fetches', async () => {
    const gh = await newGithub();
    const dir = await cloneAsDeployer(gh);
    const before = await git(dir, 'rev-parse', 'origin/main');
    const newMain = await landOnMainElsewhere(gh, 'someone-else-merged');
    // A local compare would have waved this through: the clone's own idea of origin/main is stale.
    expect(before).toBe(await git(dir, 'rev-parse', 'HEAD'));

    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.facts.remoteMain.sha).toBe(newMain);
    expect(v.facts.relation).toEqual({ kind: 'unfetched' });

    const r = await runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/predeploy: refused/);
    expect(r.stderr).toMatch(/has not even fetched/);

    // Read-only: it asked GitHub, it did not fetch.
    expect(await git(dir, 'rev-parse', 'origin/main')).toBe(before);
    expect(fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('refuses a fetched-but-behind checkout with the count, and passes once it catches up', async () => {
    const gh = await newGithub();
    const dir = await cloneAsDeployer(gh);
    await landOnMainElsewhere(gh, 'merge-1');
    await landOnMainElsewhere(gh, 'merge-2');
    await git(dir, 'fetch', '--quiet', 'origin');
    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.facts.relation).toEqual({ kind: 'behind', count: 2 });
    expect(v.problems[0]).toMatch(/roll production back/);

    await git(dir, 'merge', '--quiet', '--ff-only', 'origin/main');
    expect((await check(dir)).ok).toBe(true);
  });

  it('refuses a feature branch with work not on main, naming it, and again once main moves too', async () => {
    const gh = await newGithub();
    const dir = await cloneAsDeployer(gh);
    await git(dir, 'switch', '--quiet', '-c', 'feature/old-work');
    await commitLocally(dir, 'branch-work');
    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.facts.relation).toEqual({ kind: 'ahead', count: 1 });
    expect(v.problems[0]).toContain('branch feature/old-work');

    await landOnMainElsewhere(gh, 'theirs');
    await git(dir, 'fetch', '--quiet', 'origin');
    const d = await check(dir);
    expect(d.ok).toBe(false);
    expect(d.facts.relation).toEqual({ kind: 'diverged' });
  });

  it('refuses modified, staged, deleted and untracked files, but not ignored ones', async () => {
    const dir = await cloneAsDeployer(await newGithub());
    write(dir, 'node_modules/pkg/index.js', 'ignored\n');
    write(dir, 'frontend/dist/buildbridge/index.html', 'ignored\n');
    expect((await check(dir)).ok).toBe(true);

    write(dir, 'src/worker.js', 'export default { changed: true };\n'); // modified
    write(dir, 'src/a.js', 'export const a = 3;\n');
    await git(dir, 'add', 'src/a.js'); // staged
    fs.rmSync(path.join(dir, 'src', 'b.js')); // deleted
    write(dir, 'src/new/feature.js', 'untracked\n'); // untracked, inside a new folder

    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    for (const p of ['src/worker.js', 'src/a.js', 'src/b.js', 'src/new/feature.js']) expect(v.problems[0]).toContain(p);
    expect(v.problems[0]).toMatch(/4 uncommitted changes/);
    expect(v.problems[0]).not.toContain('node_modules');

    const r = await runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/new/feature.js');
  });

  it('refuses a clone of a local folder: origin is not GitHub', async () => {
    const dir = await cloneAsDeployer(await newGithub(), { github: false });
    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain(DEPLOY_REPO);
  });

  it('fails closed when GitHub cannot be reached', async () => {
    const gh = await newGithub();
    const dir = await cloneAsDeployer(gh);
    // Point the GitHub URL at a folder that does not exist: the network is "down".
    await git(dir, 'config', '--remove-section', `url.${slash(gh)}`);
    await git(dir, 'config', `url.${slash(path.join(tmp, 'missing.git'))}.insteadOf`, GITHUB_URL);
    const v = await check(dir);
    expect(v.ok).toBe(false);
    expect(v.facts.remoteMain.error).toMatch(/ls-remote failed/);
    expect(v.problems[0]).toMatch(/Could not ask GitHub/);
  });

  it('refuses outside any git checkout', async () => {
    const dir = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    expect(await inspectDeploySource({ cwd: dir, env })).toEqual({ isRepo: false });
    const r = await runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not a git checkout/);
  });
});

// ─── The wiring ──────────────────────────────────────────────────────────────────────────

describe('package.json runs the guard before anything ships', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const GUARD_CMD = 'node scripts/predeploy-guard.mjs';

  it('cf:deploy starts with the guard, ahead of the build and wrangler', () => {
    const s = pkg.scripts['cf:deploy'];
    expect(s.startsWith(`${GUARD_CMD} && `)).toBe(true);
    expect(s.indexOf(GUARD_CMD)).toBeLessThan(s.indexOf('build:frontend'));
    expect(s.indexOf('build:frontend')).toBeLessThan(s.indexOf('wrangler deploy'));
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'predeploy-guard.mjs'))).toBe(true);
  });

  it('deploy goes through cf:deploy before anything else', () => {
    expect(pkg.scripts.deploy.startsWith('npm run cf:deploy &&')).toBe(true);
  });

  it('no other script reaches wrangler deploy without the guard', () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name.startsWith('_comment')) continue;
      if (/\bwrangler\s+(deploy|versions\s+upload)\b/.test(cmd)) {
        expect(cmd.startsWith(`${GUARD_CMD} && `), name).toBe(true);
      }
    }
  });
});
