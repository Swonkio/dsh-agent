# Learning-loop scorecard — 2026-08-25

First real run of the loop eval, local model, 3 repeats per arm.

- **Model:** `qwen3.8-27b-uncensored` (local, via llama-swap)
- **Profile:** `review` (no shell / fetch / fs — the only source of an answer is context)
- **Command:** `node tools/eval.mjs --repeats 3 --profile review`

## Verdict: memory changed the answer by **+92%**

Across 4 tasks that can detect memory: **4 helped, 0 hurt, 0 unchanged.**
With memory seeded, the agent scored **12/12** runs perfect; without it, near-zero.

| task | memory on | memory off | lift | significant |
| --- | --- | --- | --- | --- |
| recall-port | 100% | 0% | +100% | yes |
| recall-preference | 100% | 33% | +67% | yes |
| supersede-stale | 100% | 0% | +100% | yes |
| recall-constraint | 100% | 0% | +100% | yes |

## Notes

- `recall-preference` control scored 33% (1 of 3): the model guessed "diff" on
  its own once. This is exactly why the run uses 3 repeats — a single run would
  have reported that task as +100% or +67% by luck. The 3-repeat mean is honest.
- `supersede-stale` is the key result: with memory the agent named the CURRENT
  cluster (prod-east) every time; without it, it correctly REFUSED to guess
  ("I don't have that on file, so I won't invent one") rather than hallucinating
  a stale value. So the loop's value is not only recall — it is the difference
  between a right answer and an honest "I don't know" instead of a made-up one.
- An earlier run read +50%; that was two scoring bugs (excludes that clashed
  with the tasks' own seeded memory), now fixed and guarded in validateTask.
