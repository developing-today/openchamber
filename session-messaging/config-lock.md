# Config override lock verification

Follow-up to inter-session messaging, verified against source commit 27b06af2c.

- Before: writing the explicit config incorrectly unlocked Messaging, while the live OpenCode project config still won.
- After: the project warning and lock remain after the same write.
- Hosted mobile: the warning and numeric stepper locks also remain.
- Removing the project override unlocks the controls and reloads the explicit config without restarting OpenCode.
- Enterprise reads remain available. Writes and removal return 403 enterprise_mode and leave both config content and modification time unchanged.
- With both global JSON and JSONC files present, a directory beneath them remains writable through the explicit config. The live OpenCode config confirms that precedence.

The report records 8 live checks, no browser page errors, and successful process cleanup. Every server, database, profile and config file belongs to the isolated fixture.

Native platform limits from the feature verification remain unchanged: macOS rejects the dev app's real native-notification calls with UNErrorDomain error 1, and this machine has no simulator/emulator runtime for Capacitor execution.
