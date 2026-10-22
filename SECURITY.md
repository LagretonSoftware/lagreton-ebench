# Security

Lagreton eBench writes firmware to ESP32 boards and can permanently burn eFuses (Lock open). A bug here can brick a board or leak the Wi-Fi passwords held in its backups, so please report security problems privately.

## Reporting a vulnerability

Use **[Report a vulnerability](https://github.com/LagretonSoftware/lagreton-ebench/security/advisories/new)** on this repository's Security tab. Please don't open a public issue.

Include what you found, how to reproduce it, and the version or commit you tested. Never attach real board backups or settings saves: they contain Wi-Fi passwords.

## What's in scope

- The app's local server, its key and host checks
- Reading, backing up, restoring and flashing boards
- Lock open and the eFuse simulation that runs before it
- Imported firmware handling: unpacking, flash plans, the lockout scan
- Where backups are stored and who can read them

Only the latest version on `main` gets fixes.
