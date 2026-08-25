---
name: cron-job-recipes
description: How to create and inspect dsh-cron scheduled agent tasks
whenToUse: When the user asks to schedule, list, or debug recurring agent work
---
# Cron job recipes

- Create: cronjob action=create name=... cron="30 8 * * 1-5" prompt=...
- Inspect live: /cron in dsh-tui
- Log: ~/.dsh/cron/results.md; state: jobs.json
- One-shots use at=<ISO> and are removed after firing.
