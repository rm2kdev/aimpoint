# Contributing to Aimpoint

Thanks for helping improve Aimpoint. Bug reports, feature requests and pull requests are all welcome.

## Before you open a pull request

1. **Sign the Contributor License Agreement.** Every contributor must accept the [Aimpoint CLA](CLA.md) before a pull request can be merged. You keep the copyright in your work; the CLA gives the project a licence to use it, including in the hosted Aimpoint service and under future licence terms. Signing happens on the pull request itself and is handled by a GitHub Action; see [How the CLA check works](#how-the-cla-check-works) below.

2. **Run the checks.** `pnpm lint` and `pnpm test` should pass. See the [README](README.md#run-locally) for setting up a local environment.

3. **Keep it focused.** One change per pull request, with a short description of what changed and why. For larger changes, open an issue first so we can agree on the approach.

## How the CLA check works

The **CLA** workflow ([`.github/workflows/cla.yml`](.github/workflows/cla.yml), logic in [`.github/scripts/cla.js`](.github/scripts/cla.js)) runs on every pull request when it is opened, reopened or updated with new commits.

1. **It works out who needs to sign.** That is the pull request's author plus the GitHub account behind every commit in it. Bots and maintainers on the allowlist (the `CLA_ALLOWLIST` repository variable) are exempt.
2. **It reports a `CLA` commit status.** The status passes when everyone has signed and fails otherwise. While it fails, a bot comment on the pull request links the CLA, gives the exact sentence to post and lists who still has to sign. We don't merge a pull request until the `CLA` status passes.
3. **You sign by commenting.** Read the [CLA](CLA.md), then post this exact comment on the pull request:

   > I have read the CLA Document and I hereby sign the CLA

   Case, extra spaces and a trailing full stop don't matter, but the comment must contain only that sentence.
4. **The action records your signature automatically.** Your comment triggers the workflow again. It stores your GitHub username and numeric user id, the CLA version (currently 1.0), the time and a link to your comment, and the pull request number in `signatures/cla-v1.0.json` on the `cla-signatures` branch. The check then passes, and the bot comment updates to say so. Nothing else is needed from you: no form, no email, no manual approval.

Good to know:

- **You only sign once.** Signatures are keyed by your GitHub user id, so they carry over to later pull requests and survive a username change. If the CLA version changes, you will be asked to sign the new version.
- **Only you can sign for yourself.** A sign comment counts only for the account that posts it, and only if that account is a contributor to the pull request.
- **Commits must be linked to your GitHub account.** If a commit's author email isn't on any GitHub account, the check can't tell who wrote it and keeps failing. Add the email to your GitHub account (or amend the commits with one that is), then comment `recheck`.
- **`recheck`** on its own as a comment runs the check again, for example after fixing commit emails.
- **Signing on behalf of an employer.** If you contribute as part of your job, make sure you're authorised to accept the CLA for your employer before you sign (see the definition of "you" in the CLA).

## Third-party code

If your contribution includes code you didn't write, identify it in the pull request along with its source and licence. Only include code whose licence permits it to be distributed as part of Aimpoint.

## Licence

Aimpoint is source-available under the [PolyForm Shield License 1.0.0](LICENSE.md). By contributing, you agree to the terms of the [CLA](CLA.md).
