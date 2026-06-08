#!/usr/bin/env bash
# Shared helpers for the real-model smoke scripts.
#
# The model is overridable via SMOKE_MODEL (default: anthropic/claude-haiku-4-5)
# so one smoke can validate any provider. `smoke_require_key` then checks the
# API key THAT provider needs, instead of always demanding ANTHROPIC_API_KEY —
# so `SMOKE_MODEL=openai/gpt-4o-mini bash smoke-resume.sh` works with only an
# OpenAI key present.

# The model under test (env override, default haiku). Reads SMOKE_MODEL
# directly so callers can guard before defining their own MODEL var.
smoke_model() {
  printf '%s' "${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"
}

# Fail fast (exit 1) when the key the given model's provider needs is unset.
smoke_require_key() {
  local model="${1:-$(smoke_model)}" var
  case "$model" in
    anthropic/*) var=ANTHROPIC_API_KEY ;;
    openai/*) var=OPENAI_API_KEY ;;
    google/*)
      if [[ -n "${GOOGLE_API_KEY:-}" ]]; then var=GOOGLE_API_KEY; else var=GEMINI_API_KEY; fi
      ;;
    *) var=ANTHROPIC_API_KEY ;;
  esac
  if [[ -z "${!var:-}" ]]; then
    echo "$var not set (model $model); cannot run real-model smoke." >&2
    exit 1
  fi
}
