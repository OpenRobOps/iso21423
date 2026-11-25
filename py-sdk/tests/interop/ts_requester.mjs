// TS SDK requester for the Python interop test. Env: BROKER_URL, TARGET_UUID, SCENARIO.
// Prints one JSON line per event to stdout; exits 0 on the expected outcome, else 1.
import { randomUUID } from 'node:crypto';
import { Iso21423Client, move, RequestFailed } from '../../../ts-sdk/dist/index.js';

const { BROKER_URL, TARGET_UUID, SCENARIO } = process.env;
// the abort reason travels on the detail status (Table C.x), not on the request-level status
const reasonOf = (s) => s.detailStatuses?.map((d) => d.status?.reason).find(Boolean);
const out = (o) => console.log(JSON.stringify(o));
const fail = (msg) => { out({ error: msg }); process.exit(1); };
const timer = setTimeout(() => fail('timeout'), 20000);

// ts-sdk race (out of scope here): Session.subscribeTopic registers its handler only after the SUBACK
// await, so retained identities delivered right behind the SUBACK can be dropped. Hence: retry on a
// fresh client until the catalog shows the target.
let client, fm, entry;
for (let attempt = 0; attempt < 8 && !entry; attempt++) {
  await client?.close?.();
  client = await Iso21423Client.connect({ url: BROKER_URL, sequenceStore: null });
  fm = await client.registerSelfEntity({
    entityUuid: randomUUID(), entityType: 'IMRFM', manufacturerName: 'interop',
    details: { softwareVersions: [{ moduleName: 'interop', moduleVersion: '0.0.0' }] },
  });
  const catalog = client.discover();
  for (let i = 0; i < 20 && !(entry = catalog.get(TARGET_UUID)); i++) await new Promise((r) => setTimeout(r, 100));
}
if (!entry) fail('target identity not discovered');
out({ identity: entry.identity });

let ok, cancelling;
if (SCENARIO === 'identity_discovered') {
  ok = entry.identity.capabilities?.accepts?.requests?.includes('move') === true;
} else {
  const handle = await fm.sendRequest({
    destination: TARGET_UUID,
    details: [move({ location: { ccsId: randomUUID(), x: 1, y: 2, z: 0 } })],
  });
  handle.onStatus((s) => {
    out({ status: s.status, reason: reasonOf(s) });
    if (SCENARIO === 'cancel' && s.status === 'EXECUTING') cancelling = handle.cancel();
  });
  try {
    const final = await handle.completion();
    ok = SCENARIO === 'move_succeeds' && final.status === 'SUCCEEDED';
  } catch (e) {
    if (!(e instanceof RequestFailed)) fail(String(e));
    const f = e.finalStatus;
    ok = SCENARIO === 'cancel' ? f.status === 'CANCELED'
      : SCENARIO === 'abort_reason' ? f.status === 'ABORTED' && reasonOf(f) === 'GENERAL_FAILURE'
      : false;
  }
}
await cancelling?.catch((e) => fail(String(e)));  // let the cancel request finish publishing
clearTimeout(timer);
await client.close?.();
process.exit(ok ? 0 : 1);
