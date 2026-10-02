# data

This app's state, and the only directory in the project that outlives a release.

PocketBase keeps `data.db` and `storage/` here. Anything else the app writes —
its own SQLite database, uploaded files — belongs here too, and nowhere else. A
path built from `process.cwd()` resolves inside the release directory once the
app is on a server, which is where the next deploy leaves it behind and the
pruner eventually deletes it.

Ask for the directory rather than working it out:

```ts
import { dataPath } from '@velastack/kit/server';

const db = new Database(dataPath('app.sqlite'));
```

`vela` sets `VELA_DATA_DIR` in every context — `vela dev`, `vela build`, and the
environment it writes on each deploy — so that one call answers `<project>/data`
here and `/var/lib/vela/apps/<id>/shared/pb_data` on a server.

Because it is PocketBase's own directory, `vela backup` captures everything in
it and `vela restore` replaces it. `backups/` is the exception: PocketBase
leaves that out of the archives it writes.
