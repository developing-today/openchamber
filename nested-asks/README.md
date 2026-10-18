# Nested asks live check

The live harness ran the built web UI in Chrome against an isolated OpenCode in simulation mode, with a scripted model. The root launched "Level one", which launched "Level two", whose shell command waited for permission. A second chain tested the toast.

| | main | branch |
| --- | --- | --- |
| Work Status while Level two waits | Only Level one | Level two indented under Level one, both "needs permission" |
| Permission or question alert opens | Level two ("Subagent sessions cannot be prompted") | The root, whose dock shows the request |
| Sidebar tree, switcher, phone sheet | Already nested | Nested |
