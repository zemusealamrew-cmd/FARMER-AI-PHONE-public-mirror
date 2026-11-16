These are synthetic development fixtures for reproducible offline inference diagnostics.
They are not held-out acceptance data, human speech, training records, or native-speaker
quality signoff. The focused prompt is an experimental candidate that was not adopted:
its actual generations still omitted a requested name or echoed the question.

Run `tools/dialogue-prompt-probe.py` with `g1-dialogue-development-cases.json`, and
`tools/oromo-dialogue-probe.py` with `g1-oromo-development-cases.json`, inside the
loopback-only namespace launcher. Use the existing pinned models and research terms.
These files do not establish rights for a future training corpus.

The 2026-11-08 comparison inputs are original synthetic developer examples or the
owner's supplied question wording. No third-party corpus or human recording is
included. Model weights and downloaded publisher assets remain outside Git.
Prompt demonstrations are explicitly labelled and are never counted as generated
answers. The four-model bundle preserves failures and marks unfinished cells
NOT_RUN; no native-speaker or production acceptance is implied.

Continuation fixtures reference the original recorded histories and retain only actual
assistant replies accepted by the unchanged guards. Their fourth-turn questions omit
the corrected number. No completed case is regenerated. Original interrupted probe
groups remain incomplete even after these separate common-criteria cells are filled.
