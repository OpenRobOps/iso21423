# ISO 21423 JSON Schemas - corrected package

Taken from ISO/FDIS 21423 Annex A and normalized for implementation.

## Key fixes in this revision

- `supportVendorContactInformation` follows Table A.4: only `name` is required; `phone`, `address`, and `email` are recommended, so they are not in the JSON Schema `required` array.
- Entry point files in `entrypoints/` are now distinct lightweight wrappers, not duplicate full copies of the bundle.
- The canonical schema is `iso21423.bundle.schema.json`; `validation_manifest.json` maps resource names to bundle pointers.

## Validate

```bash
python validate_iso21423.py identity examples/example_identity.json
python validate_iso21423.py request examples/example_request.json
python validate_iso21423.py ccs examples/example_ccs.json
```
