ForgeAI Server 2.8 — run ForgeAI without the desktop app
=========================================================

Works on: Linux (x64, ARM64, ARMv7 — including Raspberry Pi 4 and 5), macOS and Windows.
Needs: Node.js 22.5 or newer. The install scripts download it for you (official build from nodejs.org, checksum checked).

WORKER MODE (default) — lend this computer to your main ForgeAI
  Linux / Raspberry Pi / Mac:   sh install.sh
  Windows:                      right-click install.ps1 → Run with PowerShell

  When it finishes it prints an Address and a Computer token.
  On your main ForgeAI: Computers → Add Computer → Another computer running ForgeAI,
  paste both, and trust the certificate. The computer can then:
    • run jobs on its own local models (Ollama, LM Studio, llama.cpp…)
    • join a Cluster (Computers → New Cluster) to share one big model
    • report live CPU, memory and GPU use on the Performance page

FULL SERVER — a complete ForgeAI on a Linux box or VPS
  sh install.sh --main --port 4545
  Then open https://<its address>:4545 from another computer and use the first-time setup code
  printed in the log (Linux: journalctl --user -u forgeai, or /opt/forgeai with sudo).

Options
  --port N      port to listen on (default 4545)
  --main        full server instead of worker mode

Where things go
  Run as a normal user: ~/.forgeai   (app, data, Node.js if it was installed)
  Run with sudo:        /opt/forgeai
  Windows:              %LOCALAPPDATA%\ForgeAI-Server
  Starts automatically: systemd service “forgeai” (Linux), LaunchAgent (Mac), scheduled task “ForgeAI Server” (Windows).

Raspberry Pi — what to expect
  • Good for: small 1–3B models, routing, monitoring, email and scheduled agents.
  • A Pi adds little to a GPU cluster and usually makes it slower; use it on its own or with other small machines.
  • Use the 64-bit Raspberry Pi OS if you can, and a wired network connection.

Safety
  • Only use worker mode on a private network or a VPN such as Tailscale.
  • The computer token is a password — anyone with it can run jobs on this computer.
  • Cluster workers (llama.cpp RPC) have no password; ForgeAI only binds them to one private address.

Run it by hand instead
  AICORE_DATA=./data node app/headless.js --worker --port 4545

USE A SERVER AS THE REMOTE-LINK HUB (2.5)
A ForgeAI Server on a small cloud machine is the easiest hub for computers on different networks:
  1. Install as above, open the server's port in the cloud firewall (default 4545, HTTPS).
  2. Sign in to it from a browser (https://<server-ip>:4545), go to Computers -> Remote link -> "Be the hub", then "New code".
  3. On each of your computers: Computers -> Remote link -> "Connect to a hub", enter <server-ip>:4545 and the code.
  Your computers then see each other through the hub (chat, agents, clusters, model downloads), and "Reach from outside"
  can publish a computer's ForgeAI sign-in page on a hub port. Nothing passes through any third-party service.

COMMAND-LINE AND SILENT INSTALLS (2.7)
  Mac / Linux:  sh install-unix.sh --silent [--zip FILE] [--hub HOST:PORT --key FGE-…] [--priority low|lowest|normal]
                [--no-yield] [--lend idle|always|never] [--hide-icon] [--autostart] [--no-start] [--name NAME]
  Windows:      "Install ForgeAI (x64).exe" /S [/ALLUSERS] [/HUB=host:port /KEY=FGE-…] [/PRIORITY=low] [/AUTOSTART] [/START]
                [/HIDEICON] [/NOYIELD] [/LEND=idle] [/NAME=…] [/D=C:\path]     uninstall: "Uninstall ForgeAI.exe" /S
                or: powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Exe "Install ForgeAI (x64).exe" -Hub … -Key …
  This server:  sh install.sh --silent --priority low   (Linux service runs with Nice=10; "lowest" also uses idle CPU/IO scheduling)
  Easiest: on your hub, Computers -> Roll out -> New enrolment key gives ready-to-paste one-line commands for every OS.

UNINSTALL (2.8)
  sudo sh uninstall-unix.sh --silent            removes ForgeAI Server / the Mac app / services; keeps data
  sudo sh uninstall-unix.sh --silent --purge    also deletes data (cannot be undone)
  sh uninstall-unix.sh --dry-run                only lists what would be removed
  Windows: "Uninstall ForgeAI.exe" /S  (add /PURGE to delete data; run as admin/SYSTEM to clean every user)
  From the hub: Computers -> the computer -> Uninstall… (also revokes its access).
