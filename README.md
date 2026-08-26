<div align="center">

# tab-clamp

**Lock yourself into a few tabs. Get the thing done.**

You sit down to watch a tutorial. Four minutes in, your hands open a new tab
and search for something completely unrelated. You didn't decide to do that -
you just did it.

tab-clamp takes the option away. Pick your tabs, set a timer, and until it runs
out you can't switch away, can't close them, can't open new ones, and can't
browse off them.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](src/manifest.json)
[![No telemetry](https://img.shields.io/badge/telemetry-none-green.svg)](PRIVACY.md)

</div>

---

## Install

> **Store links coming soon.** Until then, install from source below - it takes
> about a minute.

```bash
git clone https://github.com/USERNAME/tab-clamp.git
cd tab-clamp
npm run build
```

**Chrome, Edge, Brave, Arc** - open `chrome://extensions`, turn on **Developer
mode**, click **Load unpacked**, and pick `dist/chrome`.

**Firefox** - open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on**, and pick `dist/firefox/manifest.json`. Then open
`about:addons` → tab-clamp → Permissions and grant **Access your data for all
websites** - Firefox makes this opt-in, and without it the countdown overlay
and link blocking won't load.


## How it works

Open the popup, tick the tabs you want to keep, set a timer, hit **Clamp**.

### Two lock modes, chosen per tab

**Site lock** - the tab stays on its domain. Good for a docs site or a
codebase you're reading, where you want to click around freely but not end up
on Twitter.

**URL lock** - the tab stays on that *exact* page. This is the one for tutorial
videos. It's what stops the drift into the recommended sidebar, and it's
per-tab: URL-lock the video, site-lock the docs you're following along in.

Flip the **URL** switch on any tab in the picker to turn it on.

### Strictness toggles

| Toggle | Default | What it does |
| --- | --- | --- |
| Reopen tabs I close | on | A clamped tab you close comes straight back where it was |
| Block new tabs | on | New tabs are closed the moment they appear |
| Pull focus back | on | Switching to a tab or window outside the session snaps you back |

Turn them off for a gentler session - a URL lock with everything else off is
still a useful nudge.

### While a session runs

A small countdown pill sits in the corner of every clamped tab, and the toolbar
badge shows the minutes left. When the timer ends, everything unlocks on its
own. You don't have to do anything.

## The emergency exit

Sometimes you genuinely have to leave. There's a way out, and it's deliberately
slow.

Click **Emergency exit** in the popup and a window asks you for three things:

1. The sentence *"I am choosing to leave my focus session and I accept the
   distraction."*
2. At least 25 words of your own about what pulled you away and why it can't
   wait.
3. A 15-second pause before the unlock button turns on.

Then everything unlocks, and the exit goes in a local log. The popup shows how
many times you've used it in the last 7 days.

That counter is the actual feature. An escape hatch with no friction gets used
reflexively; one that makes you write a sentence gets used when you mean it.
Watching the number is what changes the habit.

## Privacy

tab-clamp makes **no network requests**, has no servers, no analytics, and no
account. Your session, your settings, and your exit notes live in your
browser's local storage and never leave your machine. See [PRIVACY.md](PRIVACY.md).

It asks for access to all websites because you might clamp a tab on any site -
it's used only for the tabs you pick, only while a session is running, and it
never reads page content.

## FAQ

**Can I add a tab to a running session?**
Not yet - end the session or wait for the timer. It's the most requested thing
on the roadmap.

**My browser restarted and the session was gone.**
That's intentional. Tab identity doesn't survive a restart, so a resumed session
would clamp the wrong tabs. A restart ends the session cleanly instead.

**I closed a clamped tab and it came back, but my video restarted.**
The tab is recreated, not resurrected - scroll position and video position are
gone. You'll usually get a "Leave site?" prompt first; say Cancel and nothing is
lost.

**Can I stop myself from just disabling the extension?**
No, and no extension can - the browser's own extensions page is reachable from a
menu that extensions aren't allowed to touch. tab-clamp is built to beat the
reflex, not to beat a determined you. If you're deliberately navigating to
`chrome://extensions` to escape, that's a decision, and the tool has already
done its job by making you make it.

**Does it work on a second browser / another profile?**
No. Sessions are per-browser-profile.

**Is there a keyboard shortcut?**
Not yet. On the roadmap.

## Contributing

Issues and pull requests welcome - especially bug reports with the browser,
version, and what you were doing when it misbehaved.

```
src/manifest.json    shared manifest; build.js adds the per-browser background key
src/background.js    session state, enforcement, alarms, messaging
src/content.js       countdown pill, click and history guards
src/popup.{html,js}  tab picker, per-tab URL-lock switch, timer, countdown
src/exit.{html,js}   emergency exit gate
src/ui.css           shared styles
build.js             emits dist/chrome + dist/firefox, icons, and store zips
```

```bash
npm run build      # dist/chrome + dist/firefox
npm run package    # the above, plus store-ready zips
npm run check      # syntax check all sources
```

A note on the design, since it surprises people reading the code: a browser
extension **cannot veto** a tab switch or a tab close. Those APIs report events;
they don't ask permission. So every rule is enforced as *undo it immediately*
rather than *prevent it* - `tabs.onRemoved` recreates a closed tab,
`tabs.onActivated` snaps focus back, `webNavigation` returns a wandering tab to
its allowed URL. The one place we do prevent rather than undo is in the page
itself: the content script cancels off-policy link clicks before they navigate,
and patches `history.pushState` so a URL lock on a single-page app refuses the
route change in place - which is why locking a YouTube video doesn't reload it
and lose your position.

## License

[MIT](LICENSE)
