# Installing the Caprock desktop app

The app is one window for your agent terminals, projects and the dashboard
([app/README.md](../app/README.md)). Each release carries it for macOS,
Windows and Linux on the same
[Releases](https://github.com/dspv/caprock/releases) page as the daemon, and
each build bundles the daemon from the same tag. You do not need to install the
daemon separately.

| OS      | One step                                                  |
| ------- | --------------------------------------------------------- |
| macOS   | `brew install --cask dspv/tap/caprock-app`, or the `.dmg` |
| Windows | run `Caprock_<version>_x64-setup.exe`                     |
| Linux   | the `.AppImage`, `.deb` or `.rpm` ([below](#linux))       |

Minimum versions: macOS 13, Windows 10 22H2, and a Linux with WebKitGTK 4.1
(Ubuntu 22.04, Debian 12, Fedora 38 or newer). The Mac build is universal
(Apple silicon and Intel); Windows and Linux are x64.

## macOS

```bash
brew install --cask dspv/tap/caprock-app
```

Then open **Caprock** from Applications or Spotlight.

The app is not notarized yet (it is ad-hoc signed; Developer ID signing comes
with an Apple Developer account). The cask clears the download's quarantine
flag after Homebrew has checked its sha256, so it opens like any other app. If
macOS still says it cannot verify Caprock, use the steps below.

**From the `.dmg`.** Download `Caprock_<version>_universal.dmg` from
[Releases](https://github.com/dspv/caprock/releases), open it and drag
Caprock to Applications. The first time you open it, macOS refuses an app from
an unidentified developer:

- **macOS 15 and newer:** click **Done**, open **System Settings → Privacy &
  Security**, scroll to *"Caprock" was blocked*, click **Open Anyway** and
  confirm with your password.
- **macOS 13 and 14:** right-click Caprock in Applications, choose **Open**,
  then **Open** again.

macOS remembers the choice; later launches open directly. The terminal
equivalent of either is
`xattr -dr com.apple.quarantine /Applications/Caprock.app`.

**Upgrade:** `brew upgrade --cask caprock-app`, or drag the new `.dmg`'s
Caprock over the old one.
**Uninstall:** `brew uninstall --cask caprock-app`, or move Caprock to the
Trash.

## Windows

Download `Caprock_<version>_x64-setup.exe` from
[Releases](https://github.com/dspv/caprock/releases) and run it. It installs
for your user only, with no administrator prompt, and fetches Microsoft's
WebView2 runtime if Windows does not have it yet.

The installer is not code-signed yet, so SmartScreen may show *"Windows
protected your PC"*: click **More info**, then **Run anyway**.

**Upgrade:** run the newer installer over the old one. **Uninstall:** Settings →
Apps → Caprock.

## Linux

Pick one:

```bash
# AppImage: any distribution with WebKitGTK 4.1
chmod +x Caprock_<version>_amd64.AppImage && ./Caprock_<version>_amd64.AppImage

# Debian, Ubuntu
sudo apt install ./Caprock_<version>_amd64.deb

# Fedora, RHEL
sudo dnf install ./Caprock-<version>-1.x86_64.rpm
```

The `.deb` and `.rpm` pull in WebKitGTK 4.1 and the tray library themselves.
**Upgrade:** install the newer package the same way, or replace the AppImage.
**Uninstall:** `sudo apt remove caprock` or `sudo dnf remove caprock`, or
delete the AppImage.

## The first launch

The app looks for a Caprock daemon before it starts one, so it never runs two:

- **A daemon is already running** (Homebrew, Scoop, `go install`, an earlier
  app): the app uses it and opens on your terminals.
- **None is running:** the app asks once, with **Keep Caprock running in the
  background** on. It starts the `caprock` formula's daemon if Homebrew
  installed one (so `brew upgrade caprock` keeps it current), and otherwise
  installs its bundled daemon into the data directory and starts that.

Quitting the app leaves the daemon and every session running. Uninstalling the
app leaves the data directory (your sessions and history) and any Homebrew or
Scoop daemon untouched; `caprock service uninstall` then removes the
background service if you want it gone too.
