<p align="center">
<img src=".github/assets/banner.svg" alt="Lagreton eBench" width="100%">
</p>
<p align="center">
<a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-FF3B2F?style=flat-square"></a>
<img alt="macOS on Apple silicon" src="https://img.shields.io/badge/macOS-Apple%20silicon-F5F2F0?style=flat-square&logo=apple&logoColor=white&labelColor=070606">
<img alt="Python 3.12+" src="https://img.shields.io/badge/python-3.12%2B-9A9494?style=flat-square&logo=python&logoColor=white">
</p>

# Lagreton eBench

Lagreton eBench is a Mac app for your ESP32 boards. Plug a board in to see what it runs, back it up, and switch it between firmware you've imported, without losing each firmware's settings. Boards, backups and firmware stay on your Mac.

<img src=".github/assets/screenshot.png" alt="Lagreton eBench showing an ESP32-S3 board: its flash map, settings, live log and library" width="100%">

## Features

- **Reads any board** you plug in: chip, flash map, running firmware, settings and security switches.
- **Backups**: full flash backups checked against the board, and per-firmware settings saves.
- **Library**: import a `.bin`, a `.zip` or `.tar.gz` release, or an ESP-IDF build folder once, then use it on any board it fits.
- **Switching**: the outgoing firmware's settings are saved, the incoming bootloader is scanned for encryption or secure boot, and the incoming firmware's own settings go back on.
- **My boards**: every board you've used, with its saves and history, plugged in or not.
- **Lock open** (ESP32-S3 and C6): permanently write-protects the eFuses that could turn on encryption, secure boot or disable USB flashing. It runs on a virtual copy of the chip first.
- **iPhone companion**: run the boards on your Mac's hub from your phone, at home or away through Tailscale.

## Download

Get `eBench-<version>-macos-arm64.zip` from [Releases](https://github.com/LagretonSoftware/lagreton-ebench/releases/latest), unzip it and move `eBench.app` to Applications. It runs on macOS with Apple silicon.

The app isn't notarized by Apple yet, so the first time it won't open. Go to System Settings › Privacy & Security and click **Open Anyway** next to eBench.

## iPhone

The iPhone companion shows every board on your Mac's hub, with its log and saves, and can back up, save settings, switch firmware, restore, restart or forget a board. The Mac does the work, so eBench must be open on it. Lock open and importing firmware stay on the Mac.

### Install

1. Get `eBench-<version>-ios.ipa` from [Releases](https://github.com/LagretonSoftware/lagreton-ebench/releases/latest).
2. Install [iloader](https://iloader.app) on the Mac, plug in the iPhone, sign in with your Apple ID and choose **Import IPA**.
3. On the iPhone, turn on Developer Mode if it asks (Settings › Privacy & Security), and trust your Apple ID under Settings › General › VPN & Device Management.

With a free Apple ID, apps installed this way stop opening after 7 days. Install it again with iloader. A free Apple ID also allows only 3 such apps on a phone at once: if iloader says the device "has reached the maximum number of installed apps", delete one of the others first.

### Pair

In eBench on the Mac, click **Phones**, then **Show a code**. Open eBench on the iPhone and point it at the code, or scan the code with the Camera app. A code pairs one phone and works for 10 minutes. The Mac lists every paired phone, and **Remove** cuts one off at once.

Until a phone pairs, nothing outside the Mac can reach eBench. If the macOS firewall is on, it asks once whether eBench may accept incoming connections: allow it.

### Away from home: Tailscale

[Tailscale](https://tailscale.com) makes a private network between your own devices, so the iPhone reaches the Mac from anywhere, and nothing on your router needs opening.

1. Install Tailscale on the Mac and on the iPhone, and sign in to both with the same account.
2. Open **Phones** in eBench. The Mac's Tailscale address (it starts with `100.`) shows next to its Wi-Fi ones. Pair as above: the code carries every address, and the phone uses whichever answers. A phone paired before you installed Tailscale learns the new address the next time it connects at home.
3. When you're out, keep Tailscale switched on in the iPhone's Tailscale app.
4. Keep the Mac awake with eBench open. On a laptop: System Settings › Battery › Options › **Prevent automatic sleeping on power adapter when the display is off**.

### How the link is kept private

Phone and Mac talk over HTTPS. The pairing code carries the fingerprint of the Mac's own certificate, so the phone talks only to your Mac, and a key made for that one phone. The Mac keeps only a hash of that key, and the phone keeps it in its Keychain. The phone's offline copy of your boards leaves out their settings, so no Wi-Fi passwords are kept on it.

To build the iPhone app yourself: `brew install xcodegen`, then `cd ios && xcodegen && open eBench.xcodeproj`.

## Run from source

You need [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/LagretonSoftware/lagreton-ebench
cd lagreton-ebench
uv run ebench
```

To build the app yourself: `uv run pyinstaller --noconfirm ebench.spec`, which makes `dist/eBench.app`.

Backups hold your Wi-Fi passwords. They live in `~/Library/Application Support/Lagreton eBench` and are never uploaded.

## License

[AGPL-3.0](LICENSE). The Lagreton name and logo are not covered by the license.
