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
