# Pi model serving

~/llama.cpp/build/bin/llama-server -m ~/models/Bonsai-27B-Q1_0.gguf -c 8192 -t 4 --alias bonsai-27b --host 127.0.0.1 --port 8080
