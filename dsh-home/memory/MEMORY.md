# Memory index

One line per topic; detail in topics/<slug>.md. Maintained by memory_save.

- Local model serving: an OpenAI-compatible server (llama.cpp / llama-swap / vLLM / ollama) on 127.0.0.1:8080; contextWindow in settings must match its real context size
- Cron defaults: dsh-cron jobs default to the local model; the runner fires via user crontab every minute
- Agent name: The user calls this agent "Neo" — respond to that name.
