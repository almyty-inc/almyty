# @almyty/models

The almyty model catalog from your terminal: register model cards, validate them with one real call, import a provider's list, deploy weights through a registered adapter, and watch spend.

```sh
npx @almyty/auth login
npx @almyty/models list --selectable
npx @almyty/models register-endpoint --name vllm-box --url https://vllm.internal/v1 --model llama-3-8b --tier private_cloud --region eu-central
npx @almyty/models validate <card id>
npx @almyty/models adapters
npx @almyty/models deploy --model-version <modelVersionId> --adapter huggingface-endpoints --config '{"token":"hf_..."}' --desired '{"replicas":1,"region":"eu-west-1"}'
```

Run `npx @almyty/models help` for every command. Design notes: `docs/models.md` in the almyty repository.
