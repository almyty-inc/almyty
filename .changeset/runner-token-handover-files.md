---
'@almyty/runner': patch
---

In a hosted pod, read the enrollment and model tokens from handed-over files in ALMYTY_HANDOVER_DIR and delete each once read, so no command run on the machine can find them in /proc/<pid>/environ.
