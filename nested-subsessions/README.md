# Nested subsessions live check

An isolated OpenCode from the nested-subsessions branch ran in simulation mode. A scripted model answered over its Drive backend, and only model output was scripted. Sessions, the subagent tool, permissions, jobs and the OpenChamber web UI were real.

The root launched a `general` subagent ("Level one"). That subagent was offered the `subagent` tool and launched its own ("Level two"), whose shell command waited for permission. Root, child and grandchild all stayed running until the permission was answered. Then each level finished with its own answer.

| Check while the grandchild waits | main (before) | branch (after) |
| --- | --- | --- |
| Root's permission dock says "From subagent" | false | true |
| Work Status marks the Level one row "needs permission" | false | true |

Before, the request looked like the root's own and the child's row only showed a timer. Both runs had no page errors and stopped every process they started.
