#!/usr/bin/env python3
# Copyright 2026 InOrbit, Inc.
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS,
#    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#    See the License for the specific language governing permissions and
#    limitations under the License.

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
