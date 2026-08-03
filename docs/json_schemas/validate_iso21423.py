#!/usr/bin/env python3
import argparse, copy, json, pathlib, sys
from jsonschema import Draft202012Validator
ROOT=pathlib.Path(__file__).resolve().parent
BUNDLE=json.loads((ROOT/'iso21423.bundle.schema.json').read_text())
MANIFEST=json.loads((ROOT/'validation_manifest.json').read_text())
ap=argparse.ArgumentParser()
ap.add_argument('resource', choices=sorted(MANIFEST))
ap.add_argument('payload')
a=ap.parse_args()
s=copy.deepcopy(BUNDLE); s['$ref']=MANIFEST[a.resource]
payload=json.loads(pathlib.Path(a.payload).read_text())
errors=sorted(Draft202012Validator(s).iter_errors(payload), key=lambda e:list(e.path))
if errors:
    print(f'INVALID: {a.payload} against {a.resource}', file=sys.stderr)
    for e in errors:
        path='$'+''.join(f'[{i}]' if isinstance(i,int) else f'.{i}' for i in e.path)
        print(f'- {path}: {e.message}', file=sys.stderr)
    sys.exit(1)
print(f'VALID: {a.payload} against {a.resource}')
