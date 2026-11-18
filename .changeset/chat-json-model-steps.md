---
"@almyty/chat": patch
"@almyty/client": patch
---

`almyty chat --json` names the model that answered and counts the steps. An agent on a fixed model printed `model: null`, and an answer given without a tool call printed `steps: 0`; the step count now comes from the finished run, and the model from the run's record when the live events did not name it.
