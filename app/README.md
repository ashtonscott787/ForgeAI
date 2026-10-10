# ForgeAI — server / headless mode

The Mac app runs everything by itself. This file is only for running ForgeAI **without** the Mac app,
for example on a Linux server or VPS that you want to reach from anywhere.

Requirements: Node.js 22.13 or newer.

```
npm install --omit=dev
AICORE_DATA=/srv/aicore AICORE_PORT=4545 AICORE_REMOTE=1 node headless.js
```

- On first start the log prints a **setup code**. Open `http://<server>:4545` and enter it on the setup page.
- `AICORE_REMOTE=1` listens on all network interfaces (default is this machine only).
- Secrets are encrypted with a key file in the data folder, or with `AICORE_MASTER_KEY` if set (recommended on servers).
- Put the server behind HTTPS (Cloudflare Tunnel, Tailscale Funnel, Caddy or nginx). Do not expose plain HTTP to the internet.
- Local models on your Macs join as **worker nodes**: install the ForgeAI app on each Mac, turn on
  *Settings → Remote access → Allow access from other devices* and *Share this Mac's models*,
  then add each Mac on the hub under *Models & compute → Add Mac / node*.

Data layout: `platform.sqlite` (organisations, users, nodes, grants), `orgs/<id>/org.sqlite` + `orgs/<id>/files`
(one isolated database and folder per organisation), `vault.json` (encrypted secrets), `backups/<org>/` (encrypted backups).
