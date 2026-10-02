# Touch and real-device acceptance

`npm run test:ui -- --project touch` runs four core flows with a Chromium mobile device profile (`isMobile`, touch input and device scale): project drafts, sending, question answers, and interruption. The desktop project retains the broader suite. Browser emulation does not validate a physical software keyboard, iOS Safari, or an actual device viewport.

Before a mobile release, record device, OS/browser, result, and evidence for each real-device check below. Current status: **not verified on physical devices**; automated success does not change this status.

- On Android Chrome and iOS Safari, focus both new-session and existing-session composers. Open and dismiss the software keyboard; the active line, image attachments, and send/stop actions must remain reachable without horizontal scrolling.
- Enter multiple lines with a Chinese IME. Selecting a candidate must not submit a turn; composition remains intact through keyboard dismissal and view switching.
- With the keyboard open, rotate the device and change text size. Confirm the visual viewport and composer recover without covering the last message or losing text.
- Answer a multiple-choice question plus Other, switch Chat/Trajectory, and submit. Verify selections, free text, and resulting answer match.
- Background and restore the browser during streaming, then interrupt and send the retained next draft. Confirm reconnect does not duplicate messages or clear input.

Automated runs deliberately use `fill` to supply text and `tap` for touch targets; they do not claim to generate native keyboard or IME events.
