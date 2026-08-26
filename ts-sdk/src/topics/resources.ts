import { Iso21423Error } from '../errors.js';

/** Normative publish settings for a resource; `minHz`/`maxHz` bound the allowed publish rate where the spec constrains it. */
export interface ResourceConfig { qos: 0 | 1 | 2; retain: boolean; minHz?: number; maxHz?: number }

/** Table B.1 — resources and their normative QoS / retain / rate configuration. */
export const RESOURCE_CONFIG: Record<string, ResourceConfig> = {
  identity: { qos: 1, retain: true },
  status: { qos: 1, retain: true },
  batteryStatus: { qos: 0, retain: true },
  footprint: { qos: 1, retain: true },
  odometry: { qos: 0, retain: false, minHz: 0.5, maxHz: 30 },
  localTrajectory: { qos: 0, retain: false, minHz: 1, maxHz: 10 },
  globalPath: { qos: 1, retain: true },
  globalPlan: { qos: 1, retain: true },
  request: { qos: 2, retain: true },
  requestStatus: { qos: 2, retain: true },
  activeRequestsStatus: { qos: 1, retain: true },
  disconnection: { qos: 1, retain: true },   // B.4 LWT parameters
};

const STANDARD_RESOURCES: ReadonlySet<string> = new Set(Object.keys(RESOURCE_CONFIG));

/** True for the resources Table B.1 defines; false for deployment-defined extension resources. */
export function isStandardResource(name: string): boolean {
  return STANDARD_RESOURCES.has(name);
}

/**
 * Registers a deployment-defined resource (ISO 21423 leaves the resource catalog open — see the
 * standard's extension clause) so entities can publish it via `EntityHandle.publishExtension` and
 * clients can `subscribeResource` to it. Extension resources carry no schema: subscribers receive
 * the raw payload text, exactly like `footprint`.
 *
 * Process-wide (the resource table is a module singleton): both ends of a deployment must
 * register the same name with the same config. Re-registering with an identical config is a
 * no-op; a different config throws, as does a name that collides with a standard resource.
 */
export function registerExtensionResource(name: string, config: ResourceConfig): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Iso21423Error(`invalid extension resource name "${name}"`);
  }
  if (STANDARD_RESOURCES.has(name)) {
    throw new Iso21423Error(`"${name}" is a standard ISO 21423 resource and cannot be redefined`);
  }
  const existing = RESOURCE_CONFIG[name];
  if (existing && (existing.qos !== config.qos || existing.retain !== config.retain
      || existing.minHz !== config.minHz || existing.maxHz !== config.maxHz)) {
    throw new Iso21423Error(`extension resource "${name}" is already registered with a different config`);
  }
  RESOURCE_CONFIG[name] = { ...config };
}
