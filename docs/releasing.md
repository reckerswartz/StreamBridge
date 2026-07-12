# Release runbook

1. Update `CHANGELOG.md` and set the same numeric version in `package.json` and `package-lock.json`.
2. Run `npm run verify` and `npm run release:reproducible`.
3. Commit and push the release changes, then create and push the matching annotated tag, such as `v0.1.0`.
4. The release workflow creates a draft GitHub Release and attaches checksummed, attested artifacts.
5. Approve the protected Mozilla and Chrome submission environments after inspecting the draft assets.
6. After Mozilla marks the listed version public, run the Store Finalize workflow. It downloads the signed XPI, runs persistent desktop and Android installation checks, attaches the XPI, and publishes the GitHub Release.

The Chrome ZIP attached to GitHub is for store upload or developer-mode testing. Normal Chrome users install from the Chrome Web Store. Firefox users may install the Mozilla-signed XPI from GitHub or AMO.
