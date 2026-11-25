# Tizen shell

The shell keeps one stable fork identity: package `FrameHs001`, application
`FrameHs001.Dashboard`, display name `Haushaltsgalerie`. It coexists with upstream.
Future updates must preserve this identity and the existing author certificate.
Only the thin iframe shell is installed; hosted frontend updates need no WGT
reinstall. Back exits normally, with no assumed custom launcher.

## Build on Linux

Node 24 and Python 3 suffice; no Tizen Studio, SDB or ARM cross-compiler:

```sh
# Set the private DASHBOARD_URL in ignored .env.local:
# https://<trusted-dashboard-origin>/display#token=<display-secret>
npm run tizen:build
```

Output: `tizen/HouseholdFrame.unsigned.wgt`, reproducible ZIP with only widget
config, shell, icon and generated dashboard URL. Its file mode is `0600`;
**it contains the display credential**. Do not upload it as a public artifact.
Access is restricted to that origin. Deploy trusted HTTPS, not a public HTTP
listener. The package builder permits HTTP for isolated packaging tests only.

The iframe accepts a ready message only from its configured origin/window.
Failed initial connections retry with capped exponential backoff; the frontend
retains last-good data across ordinary source/network failures, purges it after
authorization failure, and detects hosted build changes. There is no periodic
full iframe reload. Left/right and OK retain upstream week navigation.

## Existing Samsung certificates and Apps2Samsung

Install the operator's Apps2Samsung CLI according to its project documentation.
Stable v3.3.1 source was reviewed for the commands below. Actual signing,
certificate reuse and TV installation have not been executed in this project.
First inspect the installed help/version and existing certificate store. Reuse
or import the established Samsung author/distributor material through that
version's documented flow; verify the TV DUID is covered. Do not generate a
replacement author identity or force login merely to make an update succeed.

With the TV already on, Developer Mode/installation authorization configured,
and `TV_HOST` exported in the shell:

```sh
apps2samsung-cli --help
apps2samsung-cli cert --tv "$TV_HOST"
apps2samsung-cli sign tizen/HouseholdFrame.unsigned.wgt -o tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
apps2samsung-cli install tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
# Separate, deliberate launch:
apps2samsung-cli launch FrameHs001.Dashboard --tv "$TV_HOST"
```

`npm run tizen:install` wraps sign/install only; unlike build it expects an
already exported `TV_HOST`. Do not use `--new-id`, uninstall, force login or
implicit launch. Keep signed WGT and certificates private. Launching the live
app and using native Art Mode are different operating modes.

## On-device acceptance

Verify coexistence with upstream; update-in-place with unchanged signing
identity; real viewport/font/TLS rendering; readable German/long titles and
artwork credits; all remote keys/Back; foreground/resume; initial offline
launch and recovery; cached network outage vs revoked token; hosted build
update without reinstall. The web app is not native Art Mode and cannot claim
its ambient-light, motion, sleep or energy behavior.
