import type { IsoTimestamp, SoftwareVersion, SupportVendorContactInformation, Uuid } from './common.js';

export type ResourceName = string;

export interface Capabilities {
  provides: ResourceName[];
  accepts: { requests: string[] };
  manages?: Uuid[];
  managedBy?: Uuid;
}

export interface ImrfmDetails {
  imrfmModel?: string;
  imrfmName?: string;
  softwareVersions: SoftwareVersion[];
  supportVendorContactInformation?: SupportVendorContactInformation;
  supportUrl?: string;
  imrfmDocumentation?: string;
}

export interface EntityIdentity {
  id: Uuid;
  timestamp: IsoTimestamp;
  entityType: 'IMR' | 'IMRFM' | string;
  manufacturerName: string;
  iso21423Version?: string;
  capabilities: Capabilities;
  details: ImrfmDetails | Record<string, unknown>;
}
