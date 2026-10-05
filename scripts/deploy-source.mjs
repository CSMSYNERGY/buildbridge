// The deploy-source check behind scripts/predeploy-guard.mjs; the WHY lives there.
//
// Kept apart from the command on purpose. The command runs its check unconditionally, so there
// is no "am I the main module?" test that could misfire (a symlinked path, a differently-cased
// drive letter) and let a deploy through with exit 0. Tests import this file; npm runs that one.

import { execFile } from 'node:child_process';

// Where production deploys come from. Lower-case host/owner/repo, no scheme, no `.git`.
export const DEPLOY_REMOTE = 'origin';
export const DEPLOY_BRANCH = 'main';
export const DEPLOY_REPO = 'github.com/csmsynergy/buildbridge';

// How many dirty paths to print before summarising the rest.
const MAX_LISTED_PATHS = 10;

/**
 * Reduce a git remote URL to `host/owner/repo` so the https and ssh spellings of the same
 * repository compare equal:
 *   https://github.com/CSMSYNERGY/buildbridge.git   → github.com/csmsynergy/buildbridge
 *   https://user@github.com/CSMSYNERGY/buildbridge  → github.com/csmsynergy/buildbridge
 *   git@github.com:CSMSYNERGY/buildbridge.git       → github.com/csmsynergy/buildbridge
 *   ssh://git@github.com/CSMSYNERGY/buildbridge.git → github.com/csmsynergy/buildbridge
 * A local path, or anything else that is not host + path, returns null.
 */
export function normalizeRepoUrl(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  let host;
  let path;
  let m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) {
    [, host, path] = m;
  } else {
    // scp-like `user@host:owner/repo`. A Windows drive path (`C:/x`, `C:\x`) also has a colon,
    // so require the user@ part, which a drive letter never has.
    m = u.match(/^[^@/\\\s]+@([^:/\\\s]+):(?!\/)(.+)$/);
    if (!m) return null;
    [, host, path] = m;
  }
  const clean = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  if (!clean.includes('/')) return null;
  return `${host}/${clean}`.toLowerCase();
}

/**
 * Hide the credentials part of every URL in `text`: `https://user:token@host/x` prints as
 * `https://***@host/x`. Anything this guard prints can end up in a CI log, a pasted terminal or a
 * chat message, and a clone made with a personal access token in its URL carries that token in
 * remote.origin.url. The scp-like `git@host:owner/repo` form holds no secret and is left alone.
 */
export function redactUrlCredentials(text) {
  return String(text ?? '').replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

/** The sha `git ls-remote <remote> refs/heads/<branch>` printed for that branch, or null. */
export function parseLsRemote(stdout, branch = DEPLOY_BRANCH) {
  const want = `refs/heads/${branch}`;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === want && /^[0-9a-f]{40,64}$/i.test(sha)) return sha.toLowerCase();
  }
  return null;
}

const short = (sha) => (sha ? sha.slice(0, 7) : '?');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Pure verdict over facts gathered from git. Returns { ok, problems: string[] }.
 *
 * facts = {
 *   isRepo:     boolean,
 *   head:       sha | null,          // HEAD of this checkout
 *   branch:     string | null,       // null = detached HEAD
 *   status:     string[],            // `git status --porcelain` lines; [] = clean
 *   originUrl:  string | null,       // remote.<DEPLOY_REMOTE>.url as configured
 *   remoteMain: { sha } | { error }, // what GitHub says main is right now
 *   relation:   { kind: 'behind'|'ahead'|'diverged'|'unfetched', count? } | null,
 * }
 */
export function evaluateDeploySource(facts, { expectedRepo = DEPLOY_REPO } = {}) {
  const problems = [];

  if (!facts?.isRepo) {
    return {
      ok: false,
      problems: ['This folder is not a git checkout, so there is no telling what would ship.'],
    };
  }

  const repo = normalizeRepoUrl(facts.originUrl);
  if (!facts.originUrl) {
    problems.push(
      `This checkout has no "${DEPLOY_REMOTE}" remote, so there is no main to compare against. ` +
        `Deploy from a clone of https://${expectedRepo}.`,
    );
  } else if (repo !== expectedRepo) {
    problems.push(
      `"${DEPLOY_REMOTE}" is ${redactUrlCredentials(facts.originUrl)}, not ${expectedRepo}. ` +
        'A clone of another checkout has a main that can be anything. Deploy from a clone of GitHub.',
    );
  }

  // Only worth asking about the commit when origin is the real repo; otherwise "main" is
  // somebody's folder and the comparison would be noise next to the problem above.
  if (facts.originUrl && repo === expectedRepo) {
    const remoteSha = facts.remoteMain?.sha ?? null;
    if (!remoteSha) {
      const why = facts.remoteMain?.error ? ` (${redactUrlCredentials(facts.remoteMain.error)})` : '';
      problems.push(
        `Could not ask GitHub where ${DEPLOY_BRANCH} is${why}. ` +
          'The guard does not fall back to the local copy of main, which may be days old. ' +
          'Try again once GitHub is reachable.',
      );
    } else if (!facts.head) {
      problems.push('HEAD does not point at a commit yet, so there is nothing to compare with main.');
    } else if (facts.head.toLowerCase() !== remoteSha) {
      const where = facts.branch ? `branch ${facts.branch}` : 'a detached HEAD';
      const rel = facts.relation ?? { kind: 'diverged' };
      let what;
      if (rel.kind === 'behind') {
        what =
          `${DEPLOY_BRANCH} on GitHub (${short(remoteSha)}) is ${plural(rel.count, 'commit')} ahead of it. ` +
          'Deploying this would roll production back.';
      } else if (rel.kind === 'ahead') {
        what =
          `It has ${plural(rel.count, 'commit')} that ${rel.count === 1 ? 'is' : 'are'} not on ${DEPLOY_BRANCH} ` +
          `(${short(remoteSha)} on GitHub). Merge to ${DEPLOY_BRANCH} and push first.`;
      } else if (rel.kind === 'unfetched') {
        what =
          `${DEPLOY_BRANCH} on GitHub is ${short(remoteSha)}, a commit this checkout has not even fetched, ` +
          'so it is missing newer work.';
      } else {
        what = `${DEPLOY_BRANCH} on GitHub is ${short(remoteSha)}, and the two have gone separate ways.`;
      }
      problems.push(
        `HEAD is ${short(facts.head)} on ${where}, not ${DEPLOY_BRANCH}. ${what}\n` +
          `  To deploy what is on ${DEPLOY_BRANCH}:\n` +
          `    git fetch ${DEPLOY_REMOTE}\n` +
          `    git switch --detach ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}   (or a clean ${DEPLOY_BRANCH} that matches it)\n` +
          '    npm run deploy\n' +
          '  To put an earlier version back live: npx wrangler rollback (never deploy an old commit).',
      );
    }
  }

  const dirty = (facts.status ?? []).filter((l) => l.trim() !== '');
  if (dirty.length) {
    const listed = dirty.slice(0, MAX_LISTED_PATHS).map((l) => `    ${l}`);
    if (dirty.length > MAX_LISTED_PATHS) listed.push(`    …and ${dirty.length - MAX_LISTED_PATHS} more`);
    problems.push(
      `The working tree has ${plural(dirty.length, 'uncommitted change')}. ` +
        'wrangler bundles the files on disk, so these would go live without being in git:\n' +
        `${listed.join('\n')}\n` +
        `  Commit them and land them on ${DEPLOY_BRANCH}, or stash them, then deploy.`,
    );
  }

  return { ok: problems.length === 0, problems };
}

/** One git call. Resolves { ok, out, err } and never rejects, so every check gets its say. */
function runGit(args, { cwd, env, timeout = 30_000 }) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, out: String(stdout), err: '' });
        resolve({ ok: false, out: String(stdout ?? ''), err: String(stderr || error.message || error).trim() });
      },
    );
  });
}

// git's own messages can quote the remote URL, credentials included.
const firstLine = (s) => redactUrlCredentials(String(s ?? '').trim().split(/\r?\n/)[0] || 'no output');

/**
 * Gather the facts evaluateDeploySource needs. Read-only: `git status` runs without the optional
 * index lock, and ls-remote only asks where main is (no fetch, no ref written, nothing downloaded).
 */
export async function inspectDeploySource({ cwd = process.cwd(), env = process.env } = {}) {
  // Never let git stop and ask for a password mid-deploy, and never take the optional index
  // lock: other sessions may be working in this checkout.
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const git = (args, opts = {}) => runGit(args, { cwd, env: gitEnv, ...opts });

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false };

  const [headR, branchR, statusR, urlR] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']),
    // The URL as configured, not as rewritten by any url.<x>.insteadOf: the check is about which
    // repository this clone means to deploy from.
    git(['config', '--get', `remote.${DEPLOY_REMOTE}.url`]),
  ]);
  const head = headR.ok ? headR.out.trim().toLowerCase() || null : null;
  const branch = branchR.ok ? branchR.out.trim() || null : null;
  const status = statusR.ok
    ? statusR.out.split(/\r?\n/).filter((l) => l.trim() !== '')
    : [`(git status failed: ${firstLine(statusR.err)})`];
  const originUrl = urlR.ok ? urlR.out.trim() || null : null;

  let remoteMain = { error: 'not asked' };
  let relation = null;
  if (originUrl && normalizeRepoUrl(originUrl) === DEPLOY_REPO) {
    const ls = await git(['ls-remote', '--quiet', DEPLOY_REMOTE, `refs/heads/${DEPLOY_BRANCH}`], { timeout: 60_000 });
    if (!ls.ok) {
      remoteMain = { error: `git ls-remote failed: ${firstLine(ls.err)}` };
    } else {
      const sha = parseLsRemote(ls.out, DEPLOY_BRANCH);
      remoteMain = sha ? { sha } : { error: `GitHub has no ${DEPLOY_BRANCH} branch` };
    }

    // Only to make the refusal say WHY; the verdict is already "the shas differ". Left of the
    // triple dot is HEAD, right is main on GitHub. If this clone has never fetched that commit,
    // git cannot count against it at all, which is itself the answer.
    if (remoteMain.sha && head && head !== remoteMain.sha) {
      const counts = await git(['rev-list', '--left-right', '--count', `${head}...${remoteMain.sha}`]);
      const [mine, theirs] = counts.ok ? counts.out.trim().split(/\s+/).map(Number) : [];
      if (!counts.ok || !Number.isFinite(mine) || !Number.isFinite(theirs)) relation = { kind: 'unfetched' };
      else if (mine === 0) relation = { kind: 'behind', count: theirs };
      else if (theirs === 0) relation = { kind: 'ahead', count: mine };
      else relation = { kind: 'diverged' };
    }
  }

  return { isRepo: true, head, branch, status, originUrl, remoteMain, relation };
}

/** inspect + evaluate. Resolves { ok, problems, facts }. */
export async function checkDeploySource(opts = {}) {
  const facts = await inspectDeploySource(opts);
  return { ...evaluateDeploySource(facts), facts };
}
