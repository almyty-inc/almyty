---
"@almyty/mcp-server": patch
---

`almyty_execute` now reports a failed call as an error: when the tool's upstream API refuses it (a 401 from Stripe, say) the result carries `isError: true` with the error text, as the gateway's own tools do, instead of coming back as ordinary data. `almyty_search` now searches by words rather than for the whole query as one string: common words are ignored and the remaining ones are matched across each tool's name, title and description, best match first, so a phrase like "get an issue" finds `get_issue`.
