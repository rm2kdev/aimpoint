// CLA check for pull requests. Run by .github/workflows/cla.yml through actions/github-script.
//
// Every commit author on a pull request must have signed the current CLA version (CLA.md),
// unless they are allowlisted or a bot. Contributors sign by commenting SIGN_PHRASE on the PR.
// Signatures are stored as JSON on the unprotected CLA_BRANCH, keyed by GitHub user id so a
// username change doesn't lose a signature. The result is reported as the "CLA" commit status.

const CLA_VERSION = '1.0';
const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA';
const CLA_BRANCH = 'cla-signatures';
const SIGNATURES_PATH = `signatures/cla-v${CLA_VERSION}.json`;
const STATUS_CONTEXT = 'CLA';
const MARKER = '<!-- aimpoint-cla -->';

const normalise = (text) =>
  (text || '').trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').toLowerCase();

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');

function parseAllowlist(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function loadSignatures(github, owner, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: SIGNATURES_PATH, ref: CLA_BRANCH });
    const json = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { signatures: json.signatures || [], sha: data.sha, branchExists: true };
  } catch (err) {
    if (err.status !== 404) throw err;
    try {
      await github.rest.git.getRef({ owner, repo, ref: `heads/${CLA_BRANCH}` });
      return { signatures: [], sha: undefined, branchExists: true };
    } catch (refErr) {
      if (refErr.status !== 404) throw refErr;
      return { signatures: [], sha: undefined, branchExists: false };
    }
  }
}

function serialise(signatures) {
  return (
    JSON.stringify(
      {
        claVersion: CLA_VERSION,
        document: 'CLA.md',
        note: 'Managed by .github/workflows/cla.yml. Do not edit by hand.',
        signatures,
      },
      null,
      2,
    ) + '\n'
  );
}

async function saveSignatures(github, owner, repo, state, signatures, message) {
  const content = serialise(signatures);
  if (!state.branchExists) {
    // Orphan branch holding only the signatures file, so it never mixes with application code.
    const { data: tree } = await github.rest.git.createTree({
      owner,
      repo,
      tree: [{ path: SIGNATURES_PATH, mode: '100644', type: 'blob', content }],
    });
    const { data: commit } = await github.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [] });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${CLA_BRANCH}`, sha: commit.sha });
    return;
  }
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: SIGNATURES_PATH,
    branch: CLA_BRANCH,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha: state.sha,
  });
}

async function collectContributors(github, owner, repo, pr) {
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 });
  const users = new Map();
  const unlinked = new Map();
  const add = (user) => {
    if (user && !isBot(user)) users.set(user.id, { id: user.id, login: user.login });
  };
  add(pr.user);
  for (const c of commits) {
    if (c.author) add(c.author);
    else if (c.commit && c.commit.author) {
      const { name, email } = c.commit.author;
      unlinked.set(email || name, `${name} <${email}>`);
    }
  }
  return { users: [...users.values()], unlinked: [...unlinked.values()] };
}

function buildComment({ unsigned, unlinked, claUrl }) {
  if (unsigned.length === 0 && unlinked.length === 0) {
    return `${MARKER}\n**CLA check passed.** All contributors to this pull request have signed the [Aimpoint CLA](${claUrl}). Thank you.`;
  }
  const lines = [
    MARKER,
    `Thanks for your contribution. Before we can merge it, every contributor needs to sign the [Aimpoint Contributor License Agreement](${claUrl}). You keep the copyright in your work; the CLA gives the project a licence to use it.`,
    '',
    'To sign, read the CLA and then post this exact comment on this pull request:',
    '',
    '```',
    SIGN_PHRASE,
    '```',
    '',
    'You only need to sign once. Comment `recheck` to run the check again.',
  ];
  if (unsigned.length) {
    lines.push('', '**Still to sign:**', ...unsigned.map((u) => `- [ ] @${u.login}`));
  }
  if (unlinked.length) {
    lines.push(
      '',
      "**Commits from an email address that isn't linked to a GitHub account** (add the email to your GitHub account, or amend the commits, then comment `recheck`):",
      ...unlinked.map((u) => `- ${u}`),
    );
  }
  return lines.join('\n');
}

async function upsertComment(github, owner, repo, number, body, { onlyIfExists }) {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const existing = comments.find((c) => (c.body || '').startsWith(MARKER) && isBot(c.user));
  if (existing) {
    if (existing.body !== body) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else if (!onlyIfExists) {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const payload = context.payload;
  const allowlist = parseAllowlist(process.env.CLA_ALLOWLIST);

  let prNumber;
  let signer = null;
  if (context.eventName === 'pull_request_target') {
    prNumber = payload.pull_request.number;
  } else if (context.eventName === 'issue_comment') {
    if (!payload.issue.pull_request) return;
    const body = normalise(payload.comment.body);
    const isSign = body === normalise(SIGN_PHRASE);
    if (!isSign && body !== 'recheck') return;
    prNumber = payload.issue.number;
    if (isSign) signer = payload.comment;
  } else {
    core.info(`Ignoring event ${context.eventName}`);
    return;
  }

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const defaultBranch = payload.repository.default_branch;
  const claUrl = `https://github.com/${owner}/${repo}/blob/${defaultBranch}/CLA.md`;

  const { users, unlinked } = await collectContributors(github, owner, repo, pr);
  const required = users.filter((u) => !allowlist.includes(u.login.toLowerCase()));

  // Record a new signature, retrying once if another run updated the file at the same time.
  let signatures;
  for (let attempt = 0; ; attempt++) {
    const state = await loadSignatures(github, owner, repo);
    signatures = state.signatures;
    const signedIds = new Set(signatures.map((s) => s.id));
    const signerUser = signer && signer.user;
    const shouldRecord =
      signerUser && !isBot(signerUser) && required.some((u) => u.id === signerUser.id) && !signedIds.has(signerUser.id);
    if (!shouldRecord) break;
    const record = {
      login: signerUser.login,
      id: signerUser.id,
      claVersion: CLA_VERSION,
      signedAt: signer.created_at,
      commentId: signer.id,
      commentUrl: signer.html_url,
      repository: `${owner}/${repo}`,
      pullRequest: prNumber,
    };
    try {
      await saveSignatures(
        github,
        owner,
        repo,
        state,
        [...signatures, record],
        `@${signerUser.login} signed the CLA v${CLA_VERSION} in #${prNumber}`,
      );
      signatures = [...signatures, record];
      core.info(`Recorded signature for ${signerUser.login}`);
      break;
    } catch (err) {
      if (attempt === 0 && [409, 422].includes(err.status)) continue;
      throw err;
    }
  }

  const signedIds = new Set(signatures.map((s) => s.id));
  const unsigned = required.filter((u) => !signedIds.has(u.id));
  const passed = unsigned.length === 0 && unlinked.length === 0;

  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: pr.head.sha,
    state: passed ? 'success' : 'failure',
    context: STATUS_CONTEXT,
    description: passed
      ? 'All contributors have signed the CLA'
      : `${unsigned.length + unlinked.length} contributor(s) still need to sign the CLA`,
    target_url: claUrl,
  });

  await upsertComment(github, owner, repo, prNumber, buildComment({ unsigned, unlinked, claUrl }), {
    onlyIfExists: passed,
  });

  core.info(passed ? 'CLA check passed' : `Unsigned: ${unsigned.map((u) => u.login).join(', ')} ${unlinked.join(', ')}`);
};

module.exports._internal = { normalise, buildComment, parseAllowlist, SIGN_PHRASE, CLA_BRANCH, SIGNATURES_PATH };
