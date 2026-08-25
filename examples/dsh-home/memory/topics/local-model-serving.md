# Local model serving

The default model is served by an OpenAI-compatible endpoint on
127.0.0.1:8080 (llama.cpp's llama-server, llama-swap, vLLM, or ollama). The
`contextWindow` in settings.yaml MUST equal the server's real context size —
it is what the compaction threshold is a percentage of.
