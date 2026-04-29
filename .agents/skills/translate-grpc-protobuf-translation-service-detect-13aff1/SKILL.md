---
name: translate-grpc-protobuf-translation-service-detect-13aff1
description: "TranslationService service method: DetectLanguage"
metadata:
  author: almyty
  generated: "true"
  toolId: "8c3cd4a7-c74a-41be-b061-94ba308d6f88"
  version: "1.0.0"
---

# real_google_translate_protobuf_translation_service_detect_13aff1

TranslationService service method: DetectLanguage

## When to use

- TranslationService service method: DetectLanguage
- POST requests to /grpc/DetectLanguage

## HTTP endpoint

```
POST https://translate.googleapis.com/grpc/DetectLanguage
```

## Example

```bash
curl -X POST "https://translate.googleapis.com/grpc/DetectLanguage"
```

## Invocation

Recommended (fastest, ~50 ms startup): install the CLI once globally, then call directly.

```bash
npm i -g @almyty/skills   # one-time, skip if already installed
almyty-skills run fb-1776091040/translate-grpc/translate-grpc-protobuf-translation-service-detect-13aff1
```

Or invoke with `npx` if a global install isn't available — slower (~1 s overhead per call, much more in sandboxes that scope per-session npm caches):

```bash
npx -y @almyty/skills run fb-1776091040/translate-grpc/translate-grpc-protobuf-translation-service-detect-13aff1
```
