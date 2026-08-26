# Privacy Policy

**tab-clamp collects nothing, sends nothing, and has no servers.**

Last updated: 2026-08-26

## What the extension stores

Everything below lives in your browser's local extension storage
(`chrome.storage.local`) on your own machine. None of it leaves the device.

| Data | Why | Lifetime |
| --- | --- | --- |
| The URLs, titles, and tab ids of the tabs you clamp | To detect when a clamped tab navigates away, gets closed, or loses focus | Deleted when the session ends |
| Session start and end time | To run the countdown and unlock on time | Deleted when the session ends |
| Your strictness toggles | To remember your preference between sessions | Until you change them or uninstall |
| Your emergency-exit notes and their timestamps | To show your exit count in the popup, so the habit stays visible to you | Last 100 exits, kept until you uninstall |

## What the extension does not do

- No analytics, telemetry, crash reporting, or usage metrics.
- No network requests of any kind. The extension has no server, no API, and no
  third-party SDKs.
- No account, no sign-in, no identifiers.
- No reading, collecting, or transmitting of page content. The in-page script
  draws the countdown overlay and cancels off-policy clicks; it does not read
  what is on the page.
- Nothing is sold or shared with anyone, because nothing is collected.

## Why it asks for access to all websites

You can clamp any tab, and the extension cannot know in advance which sites
those will be. Access is used only for the tabs you explicitly select when you
start a session, and only for the duration of that session.

## Private browsing

tab-clamp never clamps a private/incognito tab and never records a private URL.
If you grant it access to private windows, that access is used for exactly one
thing: closing private windows opened while a focus session is running. Nothing
about them is stored.

## Deleting your data

Uninstalling the extension removes all of it. To clear it while keeping the
extension, end any running session and remove the extension's storage from your
browser's extension settings.

## Contact

Open an issue at <https://github.com/USERNAME/tab-clamp/issues>.
