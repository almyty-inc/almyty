# @almyty/connections

Connect third-party accounts to almyty from your terminal: inference vendors, deployment clouds, memory backends, MCP servers, channels and registries. API-key style connectors prompt for each field with secrets hidden; OAuth connectors print an authorize URL (or open it with `--open`) and can be finished headlessly by pasting the code.

```sh
npx @almyty/auth login
npx @almyty/connections connectors --kind inference
npx @almyty/connections connect openrouter --open
npx @almyty/connections connect huggingface --owner user
npx @almyty/connections list
npx @almyty/connections grant <connectionId> --principal agent --to <agentId>
```

Run `npx @almyty/connections help` for every command. Design notes: `docs/connections.md` in the almyty repository.
