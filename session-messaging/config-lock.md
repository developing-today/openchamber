# Config override lock verification

Follow-up to inter-session messaging, verified against source commit 90a37c04e.

- Before: writing the explicit config incorrectly unlocked Messaging, while the live OpenCode project config still won.
- After: the project warning and lock remain after the same write.
- Hosted mobile: the warning and numeric stepper locks also remain.
- Removing the project override unlocks the controls and reloads the explicit config without restarting OpenCode.
- Enterprise reads remain available. Writes and removal return 403 enterprise_mode and leave both config content and modification time unchanged.

The report records 6 live checks, no browser page errors, and successful process cleanup. Every server, database, profile and config file belongs to the isolated fixture.

Native platform limits from the feature verification remain unchanged: macOS rejects the dev app's real native-notification calls with UNErrorDomain error 1, and this machine has no simulator/emulator runtime for Capacitor execution.
