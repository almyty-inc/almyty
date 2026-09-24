# Migrations

`synchronize` is off everywhere, so a migration is the only thing that
changes the schema. Every entity change ships with one.

## One timestamp per migration

A migration's file is `<13-digit timestamp>-<Name>.ts` and its class is
`<Name><same timestamp>`. TypeORM orders migrations by the timestamp at
the end of the class name and records each by name.

- **Never reuse a timestamp.** Take the next free one after the newest
  file here. Two migrations with the same timestamp both run, but the
  numbers no longer say which runs first, so a fresh database can apply
  them in a different order from the one production did.
- **Never rename a migration that has run** on staging or production.
  The recorded name changes, and TypeORM runs it again.

`__tests__/unique-timestamps.spec.ts` enforces both the unique
timestamp and the class/file match. It allowlists the one historical
collision, `CollaborationParticipants1750808000000` and
`PrivateVisibility1750808000000`: both had already run everywhere before
the guard existed, so they keep their names. Do not add to that list.
