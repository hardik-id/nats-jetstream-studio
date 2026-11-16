# Install

Download the installer for your system from the
[latest release](https://github.com/hardik-id/nats-jetstream-studio/releases/latest).

| System  | File                                                  |
| ------- | ----------------------------------------------------- |
| Windows | `nats-jetstream-studio-<version>-setup.exe`           |
| macOS   | `nats-jetstream-studio-<version>-universal.dmg`       |
| Linux   | `.AppImage` (make it executable and run it) or `.deb` |

## First-run warnings

The installers are **not code-signed yet** ([Windows #17](https://github.com/hardik-id/nats-jetstream-studio/issues/17),
[macOS #18](https://github.com/hardik-id/nats-jetstream-studio/issues/18)), so your system shows a
warning the first time you open the app. The files are built by the public
[release workflow](../.github/workflows/release.yml) from a tagged commit.

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** Gatekeeper says the app "cannot be verified" or "is damaged". Open **System Settings >
  Privacy & Security** and click **Open Anyway**, or run
  `xattr -cr "/Applications/NATS JetStream Studio.app"` once.
- **Linux:** no warning.

## Updates

Automatic updates need a signed app on macOS, so until signing is set up, download new versions by
hand from the releases page.

## Run from source instead

Developers can skip the installer: see [CONTRIBUTING.md](../CONTRIBUTING.md). Running from source
does not trigger these warnings. To use the studio in a browser, see [web-mode.md](web-mode.md).
